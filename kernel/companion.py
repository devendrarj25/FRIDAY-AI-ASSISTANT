"""FRIDAY — phone companion (local network only).

Security model:
  * Off by default. Only reachable when the desktop app starts the kernel with
    FRIDAY_LAN=1, which binds the LAN interface.
  * Pairing is a one-time 6-digit code valid for two minutes. There is no
    password, and no device PIN is ever stored.
  * A paired phone gets a random long-lived session token stored only in that
    phone's browser. The owner can revoke any phone at any time.
  * Nothing is exposed to the public internet: no relay, no port forwarding.
"""

from __future__ import annotations

import json
import secrets
import time
from contextvars import ContextVar
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, JSONResponse, Response

PAIR_TTL = 120  # seconds
TOKEN_BYTES = 32
_PNG_MAGIC = b"\x89PNG\r\n\x1a\n"


def _checkout_root() -> Path:
    """Repo root in a checkout; Electron extraResources root when packaged."""
    return Path(__file__).resolve().parent.parent


def _png_payload_from_ico(data: bytes) -> bytes | None:
    """Return the largest PNG chunk already stored inside a Windows ICO."""
    if len(data) < 6 or data[:4] != b"\x00\x00\x01\x00":
        return None
    count = int.from_bytes(data[4:6], "little")
    best: tuple[int, bytes] | None = None
    offset = 6
    for _ in range(count):
        if offset + 16 > len(data):
            break
        width = data[offset] or 256
        size = int.from_bytes(data[offset + 8 : offset + 12], "little")
        start = int.from_bytes(data[offset + 12 : offset + 16], "little")
        blob = data[start : start + size]
        if blob.startswith(_PNG_MAGIC) and (best is None or width > best[0]):
            best = (width, blob)
        offset += 16
    return best[1] if best else None


def companion_icon_png() -> bytes | None:
    """FRIDAY's existing logo only — never generated artwork."""
    root = _checkout_root()
    ico = root / "resources" / "icons" / "friday.ico"
    if ico.is_file():
        png = _png_payload_from_ico(ico.read_bytes())
        if png:
            return png
    favicon = root / "public" / "favicon.png"
    if favicon.is_file():
        blob = favicon.read_bytes()
        if blob.startswith(_PNG_MAGIC):
            return blob
    return None


def _product_version(root: Path) -> str | None:
    path = root / "config" / "friday-version.json"
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return f"{int(data['major'])}.{int(data['minor'])}.{int(data['patch'])}.{int(data['revision'])}"
    except Exception:
        return None


def parse_changelog_sections(text: str) -> list[dict]:
    """Split CHANGELOG.md / notes on canonical `## vX.Y.Z` (or `## FRIDAY vX.Y.Z`) headings."""
    sections: list[dict] = []
    current: dict | None = None
    for line in text.splitlines():
        version = ""
        if line.startswith("## v"):
            version = line[4:].strip().split()[0]
        elif line.startswith("## FRIDAY v"):
            version = line[len("## FRIDAY v") :].strip().split()[0]
        if version:
            if current:
                current["body"] = str(current["body"]).strip()
                sections.append(current)
            current = {"version": version, "body": line + "\n"}
        elif current is not None:
            current["body"] = str(current["body"]) + line + "\n"
    if current:
        current["body"] = str(current["body"]).strip()
        sections.append(current)
    return sections


def companion_whats_new(root: Path | None = None) -> dict:
    """Owner-facing What's New from CHANGELOG.md — never invented text."""
    base = root or _checkout_root()
    version = _product_version(base)
    changelog = base / "CHANGELOG.md"
    notes_path = base / "releases" / "notes" / f"v{version}.md" if version else None
    source: str | None = None
    text = ""
    if changelog.is_file():
        try:
            text = changelog.read_text(encoding="utf-8")
            source = "CHANGELOG.md"
        except Exception:
            text = ""
            source = None
    if not text and notes_path and notes_path.is_file():
        try:
            text = notes_path.read_text(encoding="utf-8")
            source = f"releases/notes/v{version}.md"
        except Exception:
            text = ""
    if not text:
        return {
            "version": version,
            "source": None,
            "current": None,
            "history": [],
            "detail": "CHANGELOG.md is not available beside this kernel, so What's New cannot be shown.",
        }
    history = parse_changelog_sections(text)
    current = next((row for row in history if row.get("version") == version), None)
    if version and current is None and source and source.startswith("releases/notes/"):
        current = {"version": version, "body": text.strip()}
        if not history:
            history = [current]
    payload: dict = {
        "version": version,
        "source": source,
        "current": current,
        "history": history,
    }
    if version and current is None:
        payload["detail"] = f"CHANGELOG.md has no ## v{version} section."
    return payload


class CompanionStore:
    """Paired phones persisted inside the FRIDAY root (never AppData)."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.pending: dict[str, float] = {}

    def _read(self) -> dict:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except Exception:
            return {"phones": []}

    def _write(self, data: dict) -> None:
        self.path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    # -- pairing ----------------------------------------------------------
    def new_code(self) -> dict:
        code = f"{secrets.randbelow(1_000_000):06d}"
        self.pending = {c: t for c, t in self.pending.items() if t > time.time()}
        self.pending[code] = time.time() + PAIR_TTL
        return {"code": code, "expiresAt": int((time.time() + PAIR_TTL) * 1000)}

    def redeem(self, code: str, label: str) -> dict | None:
        expiry = self.pending.get(code)
        if not expiry or expiry < time.time():
            return None
        self.pending.pop(code, None)
        token = secrets.token_urlsafe(TOKEN_BYTES)
        data = self._read()
        phone = {
            "id": secrets.token_hex(8),
            "label": label or "Phone",
            "token": token,
            "pairedAt": int(time.time() * 1000),
        }
        data.setdefault("phones", []).append(phone)
        self._write(data)
        return phone

    # -- sessions ---------------------------------------------------------
    def valid(self, token: str) -> dict | None:
        if not token:
            return None
        for phone in self._read().get("phones", []):
            if secrets.compare_digest(str(phone.get("token", "")), token):
                return phone
        return None

    def phones(self) -> list[dict]:
        return [
            {k: v for k, v in phone.items() if k != "token"}
            for phone in self._read().get("phones", [])
        ]

    def revoke(self, phone_id: str) -> bool:
        data = self._read()
        before = len(data.get("phones", []))
        data["phones"] = [p for p in data.get("phones", []) if p.get("id") != phone_id]
        self._write(data)
        return len(data["phones"]) < before


COMPANION_HTML = """<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="FRIDAY" />
<title>FRIDAY Companion</title>
<link rel="manifest" href="/companion/manifest.json" />
<link rel="icon" href="/companion/icon-192.png" type="image/png" sizes="192x192" />
<link rel="apple-touch-icon" href="/companion/icon-192.png" />
<meta name="theme-color" content="#05070d" />
<style>
 :root{color-scheme:dark}
 *{box-sizing:border-box}
 html,body{height:100%;width:100%;max-width:100%;}
 body{margin:0;font-family:ui-sans-serif,system-ui,'Segoe UI',sans-serif;background:#05070d;color:#dbe7ff;
   display:flex;flex-direction:column;height:100dvh;min-height:100dvh;min-height:100svh;width:100%;max-width:100%;
   touch-action:manipulation;padding-left:env(safe-area-inset-left);padding-right:env(safe-area-inset-right)}
 header{padding:12px 16px;padding-top:max(12px,env(safe-area-inset-top));border-bottom:1px solid #16233d;
   display:flex;justify-content:space-between;align-items:center;gap:10px;flex-shrink:0;min-width:0}
 .brand{display:flex;align-items:center;gap:10px;min-width:0;flex-shrink:0}
 .brand img{width:32px;height:32px;border-radius:8px;flex-shrink:0}
 h1{font-size:15px;margin:0;letter-spacing:.14em;text-transform:uppercase;color:#6ee7ff}
 #state{font-size:12px;color:#8aa0c4;display:inline-flex;align-items:center;gap:6px;min-width:0;flex:1;
   text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;justify-content:flex-end}
 #state::before{content:'';width:8px;height:8px;border-radius:50%;background:#8aa0c4;flex-shrink:0}
 #state.ok::before{background:#34d399}
 #state.bad{color:#ff8087}
 #state.bad::before{background:#ff8087}
 #log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;min-height:0}
 .msg{max-width:85%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.4;white-space:pre-wrap}
 .me{align-self:flex-end;background:#12305a}
 .fr{align-self:flex-start;background:#0d1729;border:1px solid #1c2f4f}
 .err{align-self:flex-start;background:#2a0f16;border:1px solid #5c2530;color:#ffb4b9}
 footer{display:flex;gap:8px;padding:12px;padding-bottom:max(12px,env(safe-area-inset-bottom));
   border-top:1px solid #16233d;flex-shrink:0}
 input,button{font:inherit;border-radius:12px;border:1px solid #1c2f4f;background:#0b1220;color:#dbe7ff;
   padding:11px 13px;min-height:44px}
 input{flex:1;min-width:0}
 button{background:#153a63;border-color:#245089}
 button:disabled{opacity:.5}
 button.on{background:#7f1d2b;border-color:#b03349}
 #pair{padding:24px;display:flex;flex-direction:column;gap:12px}
 #pair[hidden],#composer[hidden]{display:none}
 #news,#perms{padding:16px;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0;overflow-y:auto}
 #news[hidden],#perms[hidden],#log[hidden]{display:none}
 #news pre{white-space:pre-wrap;font:inherit;font-size:13px;line-height:1.45;margin:0;color:#dbe7ff}
 .perm{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;padding:10px 0;
   border-bottom:1px solid #16233d;font-size:13px}
 .perm b{display:block}
 .perm span{color:#8aa0c4;font-size:12px}
 #menu{display:none;flex-wrap:wrap;gap:8px;padding:10px 12px;border-bottom:1px solid #16233d;
   max-height:40vh;overflow-y:auto;flex-shrink:0;-webkit-overflow-scrolling:touch}
 #menu.open{display:flex}
 #menu .grp{width:100%;font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:#6ee7ff;
   margin:6px 0 2px;padding:0 2px}
 #menu button{padding:10px 12px;font-size:13px;border-radius:10px;flex:1 1 calc(50% - 8px);min-height:44px;text-align:left}
 #menuBtn{padding:8px 10px;min-width:44px;min-height:44px;flex-shrink:0}
 .hdr-tools{display:flex;gap:8px;align-items:center;min-width:0;flex:1;justify-content:flex-end}
 @media (max-width:359px){ #menu button{flex-basis:100%} #state{font-size:11px} }
 @media (min-width:600px){ #menu button{flex:1 1 calc(33.33% - 8px)} .msg{max-width:70%} }
 @media (min-width:900px){ #menu button{flex:1 1 calc(25% - 8px)} .msg{max-width:60%} }
 @media (orientation:landscape) and (max-height:500px){
   header{padding:8px 12px;padding-top:max(8px,env(safe-area-inset-top))}
   #log{padding:8px 14px}
   #menu{max-height:32vh}
 }
</style></head>
<body>
<header>
  <div class="brand">
    <img src="/companion/icon-192.png" alt="" width="32" height="32" />
    <h1>FRIDAY</h1>
  </div>
  <span class="hdr-tools">
    <span id="state">connecting…</span>
    <button id="menuBtn" title="FRIDAY features" type="button">☰</button>
  </span>
</header>
<div id="menu"></div>
<div id="pair" hidden>
  <p>Enter the 6-digit pairing code shown in FRIDAY → Settings → Phone companion.</p>
  <input id="code" inputmode="numeric" maxlength="6" placeholder="000000" />
  <button id="pairBtn" type="button">Pair this phone</button>
  <span id="pairErr" style="color:#ff8087;font-size:13px"></span>
</div>
<div id="news" hidden>
  <button id="newsBack" type="button">Back to chat</button>
  <h1 style="font-size:15px;letter-spacing:.08em">What's New</h1>
  <p id="newsMeta" style="color:#8aa0c4;font-size:12px;margin:0"></p>
  <pre id="newsBody"></pre>
</div>
<div id="perms" hidden>
  <button id="permsBack" type="button">Back to chat</button>
  <h1 style="font-size:15px;letter-spacing:.08em">This phone</h1>
  <p id="netLine" style="color:#8aa0c4;font-size:12px;margin:0"></p>
  <div id="permList"></div>
</div>
<div id="log"></div>
<footer id="composer" hidden>
  <input id="text" placeholder="Ask FRIDAY…" />
  <button id="mic" type="button" title="Talk to FRIDAY">🎤</button>
  <button id="cam" type="button" title="Send a photo">📷</button>
  <button id="send" type="button">Send</button>
</footer>
<script>
const KEY='friday.companion.token';
const el=id=>document.getElementById(id);
function setState(t,bad){const s=el('state');s.textContent=t;s.className=bad?'bad':(t==='connected'||t.indexOf('connected ·')===0?'ok':'');}
let ws=null, watchdog=null, awaiting=false, liveLine='', lastLive=null, lastWhatsNew=null;
let audioUnlocked=false, pendingAudio=null, speakerState='prompt';
function unlockAudio(){
  audioUnlocked=true;
  if(speakerState==='prompt' || speakerState==='blocked') speakerState='granted';
  const pending=pendingAudio; pendingAudio=null;
  if(pending){ pending.play().then(()=>{ speakerState='granted'; }).catch(()=>{ speakerState='blocked'; }); }
  renderPerms();
}
['pointerdown','keydown','touchstart'].forEach(ev=>window.addEventListener(ev, unlockAudio, {passive:true}));
function applyLive(live){
  if(!live||typeof live!=='object') return;
  lastLive=live;
  /* Prefer the desktop-computed line so a new live field cannot drift here. */
  if(typeof live.line==='string') liveLine=live.line;
  else {
    const bits=[];
    if(live.mode) bits.push(String(live.mode));
    if(live.voice && live.voice!=='OFF') bits.push(String(live.voice).toLowerCase());
    const doc=live.doctor||{};
    const p=doc.problems||0, w=doc.warnings||0;
    if(p||w) bits.push(p+' issue'+(p===1?'':'s')+(w? ', '+w+' warning'+(w===1?'':'s'):''));
    else if(!doc.scanning) bits.push('healthy');
    const connected=(live.connectors||[]).filter(c=>c&&c.connected).map(c=>c.name||c.id);
    if(connected.length) bits.push(connected.join(', '));
    if((live.cloud||[]).length) bits.push('cloud: '+(live.cloud||[]).join(', '));
    if(live.routeMode && live.routeMode!=='auto') bits.push('route: '+live.routeMode);
    if(live.policy && live.policy!=='free-preferred') bits.push('cost: '+live.policy);
    if((live.selected||[]).length) bits.push('models: '+(live.selected||[]).join(', '));
    const work=live.work||{};
    if(work.step) bits.push(String(work.step));
    else if(work.goal) bits.push(String(work.goal).slice(0,80));
    else if(work.tool) bits.push(String(work.tool));
    if(live.remote && live.remote.url) bits.push('off-LAN ready');
    else if(live.remote && live.remote.enabled) bits.push('off-LAN: not ready');
    liveLine=bits.join(' · ');
  }
  const s=el('state');
  if(s.className==='ok' || s.textContent==='connected' || s.textContent.indexOf('connected ·')===0)
    setState(liveLine?('connected · '+liveLine):'connected');
  renderNet();
}
function add(text,who){const d=document.createElement('div');d.className='msg '+who;d.textContent=text;
  el('log').appendChild(d);el('log').scrollTop=el('log').scrollHeight;return d;}
function fail(message){ awaiting=false; clearTimeout(watchdog); watchdog=null;
  setState(message,true); add(message,'err'); }
function armWatchdog(what){ clearTimeout(watchdog); awaiting=true;
  watchdog=setTimeout(()=>{ if(!awaiting) return;
    fail(what+' got no answer from FRIDAY. Her local service may be busy, stopped, or phone access was turned off.');
    try{ ws && ws.close(); }catch(e){} }, 60000); }
function settled(){ awaiting=false; clearTimeout(watchdog); watchdog=null; }
function speak(text){
  fetch('/companion/speak',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({token:localStorage.getItem(KEY),text})})
    .then(r=>r.ok?r.json():null).then(r=>{
      if(r&&r.audio){
        if(typeof Audio==='undefined'){ speakerState='unsupported'; renderPerms(); return; }
        const a=new Audio('data:audio/mp3;base64,'+r.audio);
        const play=()=>a.play().then(()=>{ speakerState='granted'; renderPerms(); }).catch(()=>{
          speakerState='blocked'; pendingAudio=a;
          add('Tap anywhere to allow FRIDAY to speak. This browser blocked autoplay.','err');
          renderPerms();
        });
        if(audioUnlocked) play(); else { pendingAudio=a; speakerState='blocked'; renderPerms();
          add('Tap anywhere to allow FRIDAY to speak. This browser blocked autoplay.','err'); }
      } else if('speechSynthesis' in window){
        const u=new SpeechSynthesisUtterance(text); u.lang='hi-IN';
        try{ speechSynthesis.speak(u); speakerState=audioUnlocked?'granted':'blocked'; }
        catch(e){ speakerState='blocked'; add('Spoken reply was blocked: '+e,'err'); }
        renderPerms();
      } else {
        speakerState='unsupported'; renderPerms();
      }
    })
    .catch((e)=>{ add('Spoken reply failed: '+e,'err'); });
}
function showChat(){
  el('news').hidden=true; el('perms').hidden=true; el('log').hidden=false;
}
function showNews(){
  el('menu').classList.remove('open');
  el('news').hidden=false; el('perms').hidden=true; el('log').hidden=true;
  const news=lastWhatsNew||{};
  const cur=news.current;
  el('newsMeta').textContent=news.source
    ? ('Source: '+news.source+(news.version? ' · FRIDAY '+news.version:''))
    : (news.detail||"What's New is not available on this install.");
  el('newsBody').textContent=cur&&cur.body?cur.body:(news.detail||'No changelog section is present.');
}
function showPerms(){
  el('menu').classList.remove('open');
  el('news').hidden=true; el('perms').hidden=false; el('log').hidden=true;
  refreshPerms();
}
el('newsBack').onclick=showChat;
el('permsBack').onclick=showChat;
const perm={mic:'unknown',camera:'unknown',notify:'unknown',background:'unknown',speaker:'unknown'};
function permText(k){
  const v=k==='speaker'?speakerState:perm[k];
  if(v==='granted') return 'granted';
  if(v==='denied') return 'denied';
  if(v==='prompt') return 'not asked yet';
  if(v==='unsupported') return window.isSecureContext?'unsupported by this browser':'unsupported on this http page (needs https or localhost)';
  if(v==='unused') return 'not requested — tap 📷 or Ask to use the camera';
  if(v==='blocked') return 'blocked until you tap (autoplay)';
  return 'unknown';
}
function renderNet(){
  const box=el('netLine'); if(!box) return;
  const remote=lastLive&&lastLive.remote;
  const bits=['This page: '+location.host];
  if(!remote){ bits.push('Off-LAN: desktop has not published a Tailscale probe yet.'); }
  else {
    bits.push(remote.detail||'');
    if(remote.url) bits.push('Tailscale URL: '+remote.url);
    else if(remote.enabled) bits.push('Off-LAN is on, but Tailscale is not ready — no URL.');
    else bits.push('Off-LAN is off (LAN pairing only).');
  }
  box.textContent=bits.filter(Boolean).join(' ');
}
function renderPerms(){
  const box=el('permList'); if(!box) return;
  const rows=[
    ['Microphone',permText('mic'),(perm.mic==='prompt'||perm.mic==='unknown')?'mic':''],
    ['Camera',permText('camera'),(perm.camera==='prompt'||perm.camera==='unknown')?'cam':''],
    ['Notifications',permText('notify'),(perm.notify==='prompt'||perm.notify==='denied'||perm.notify==='unknown')?'notify':''],
    ['Background',permText('background'),perm.background==='prompt'?'bg':''],
    ['Speaker',permText('speaker'),(speakerState==='blocked'||speakerState==='prompt')?'speak':'']
  ];
  box.innerHTML='';
  rows.forEach(row=>{
    const d=document.createElement('div'); d.className='perm';
    const left=document.createElement('div');
    left.innerHTML='<b>'+row[0]+'</b><span>'+row[1]+'</span>';
    d.appendChild(left);
    if(row[2]){
      const b=document.createElement('button'); b.type='button';
      b.textContent=row[2]==='speak'?'Tap to allow':(row[2]==='notify'?'Ask':(row[2]==='mic'?'Ask':'Ask'));
      b.onclick=()=>askPerm(row[2]);
      d.appendChild(b);
    }
    box.appendChild(d);
  });
  renderNet();
}
async function refreshPerms(){
  speakerState=typeof Audio==='undefined'?'unsupported':speakerState;
  const secure=window.isSecureContext;
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    perm.mic='unsupported';
    perm.camera='unsupported';
  } else if(navigator.permissions&&navigator.permissions.query){
    try{ perm.mic=(await navigator.permissions.query({name:'microphone'})).state; }
    catch(e){ perm.mic='unknown'; }
    try{ perm.camera=(await navigator.permissions.query({name:'camera'})).state; }
    catch(e){ if(perm.camera==='unused') perm.camera='unknown'; }
  } else {
    if(perm.mic==='unused') perm.mic='unknown';
    if(perm.camera==='unused') perm.camera='unknown';
  }
  if(!secure) perm.notify='unsupported';
  else if(!('Notification' in window)) perm.notify='unsupported';
  else perm.notify=Notification.permission==='default'?'prompt':Notification.permission;
  /* Never await serviceWorker.ready — it never resolves when no worker is
     active, which is the normal case on plain-http LAN / Tailscale URLs. */
  if(!secure || !('serviceWorker' in navigator)) perm.background='unsupported';
  else {
    try{
      const existing=await navigator.serviceWorker.getRegistration('/companion');
      if(!existing) perm.background='unsupported';
      else if(!('periodicSync' in existing)) perm.background='unsupported';
      else {
        try{ perm.background=(await navigator.permissions.query({name:'periodic-background-sync'})).state; }
        catch(e){ perm.background='unknown'; }
      }
    }catch(e){ perm.background='unsupported'; }
  }
  renderPerms();
}
async function askPerm(kind){
  if(kind==='speak'){ unlockAudio(); return; }
  if(kind==='cam'||kind==='camera'){
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
      const msg=!window.isSecureContext
        ?'Camera requires HTTPS or localhost (secure context). Open companion via https:// or Tailscale.'
        :'Camera is not supported in this browser.';
      fail(msg); perm.camera='unsupported'; renderPerms(); return;
    }
    try{
      const stream=await navigator.mediaDevices.getUserMedia({video:true});
      stream.getTracks().forEach(t=>t.stop());
      perm.camera='granted';
    }catch(e){ perm.camera='denied'; fail('Camera permission was refused: '+e); }
    renderPerms(); return;
  }
  if(kind==='mic'){
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
      const msg=!window.isSecureContext
        ?'Microphone requires HTTPS or localhost (secure context). Open companion via https:// or Tailscale.'
        :'Microphone is not supported in this browser.';
      fail(msg); perm.mic='unsupported'; renderPerms(); return;
    }
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:true});
      stream.getTracks().forEach(t=>t.stop());
      perm.mic='granted';
    }catch(e){ perm.mic='denied'; fail('Microphone permission was refused: '+e); }
    renderPerms(); return;
  }
  if(kind==='notify'){
    if(!window.isSecureContext || !('Notification' in window)){ perm.notify='unsupported'; renderPerms(); return; }
    try{ perm.notify=await Notification.requestPermission(); }
    catch(e){ perm.notify='unsupported'; }
    if(perm.notify==='default') perm.notify='prompt';
    renderPerms(); return;
  }
  if(kind==='bg'){
    if(!window.isSecureContext || !('serviceWorker' in navigator)){ perm.background='unsupported'; renderPerms(); return; }
    try{
      const existing=await navigator.serviceWorker.getRegistration('/companion');
      if(!existing || !('periodicSync' in existing)){ perm.background='unsupported'; renderPerms(); return; }
      await existing.periodicSync.register('friday-companion',{minInterval:60*60*1000});
      perm.background='granted';
    }catch(e){
      perm.background=/denied|permission/i.test(String(e))?'denied':'unsupported';
      add('Background sync was refused: '+e,'err');
    }
    renderPerms();
  }
}
function maybeNotify(title, body){
  if(perm.notify!=='granted' || !('Notification' in window) || !window.isSecureContext) return;
  if(!document.hidden && document.visibilityState==='visible') return;
  try{
    if(navigator.serviceWorker && navigator.serviceWorker.controller){
      navigator.serviceWorker.getRegistration('/companion').then(reg=>{ if(reg) reg.showNotification(title,{body:body,icon:'/companion/icon-192.png'}); });
    } else { new Notification(title,{body:body,icon:'/companion/icon-192.png'}); }
  }catch(e){}
}
if(window.isSecureContext && 'serviceWorker' in navigator){
  navigator.serviceWorker.register('/companion/sw.js',{scope:'/companion'}).catch(()=>{ perm.background='unsupported'; });
} else {
  perm.background='unsupported';
}
refreshPerms();
/* ---- feature menu: read from FRIDAY's own navigation registry ---- */
async function loadMenu(){
  const box=el('menu');
  box.dataset.state='loading';
  if(!box.children.length) box.textContent='Loading FRIDAY features…';
  try{
    const res=await fetch('/companion/features?token='+encodeURIComponent(localStorage.getItem(KEY)||''));
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data=await res.json();
    if(!(data.features||[]).length && !(data.capabilities||[]).length) throw new Error('menu not ready');
    box.innerHTML=''; box.dataset.state='ready';
    lastWhatsNew=data.whatsNew||null;
    function addGroup(title){
      const head=document.createElement('div'); head.className='grp'; head.textContent=title;
      box.appendChild(head);
    }
    addGroup('This phone');
    [["What's New","news"],["Permissions & network","perms"]].forEach(row=>{
      const b=document.createElement('button'); b.type='button'; b.textContent=row[0];
      b.onclick=()=>{ row[1]==='news'?showNews():showPerms(); };
      box.appendChild(b);
    });
    const byGroup={};
    (data.features||[]).forEach(f=>{ (byGroup[f.group||'Main']=byGroup[f.group||'Main']||[]).push(f); });
    Object.keys(byGroup).forEach(group=>{
      addGroup(group);
      byGroup[group].forEach(f=>{
        const b=document.createElement('button'); b.type='button'; b.textContent=f.label;
        b.onclick=()=>{ box.classList.remove('open'); openFeature(f); };
        box.appendChild(b);
      });
    });
    /* Live capabilities — models, tools, skills, agents, modules, plugins,
       workflows — exactly the registry the desktop brain routes with. */
    const caps=data.capabilities||[];
    const byType={};
    caps.forEach(c=>{ (byType[c.type]=byType[c.type]||[]).push(c); });
    Object.keys(byType).sort().forEach(type=>{
      addGroup(type+'s ('+byType[type].length+')');
      byType[type].forEach(c=>{
        const b=document.createElement('button'); b.type='button';
        b.textContent=(c.available?'':'○ ')+c.name;
        b.title=(c.detail||'')+' — '+(c.health||'');
        if(!c.available) b.style.opacity='.55';
        b.onclick=()=>{ box.classList.remove('open'); useCapability(c); };
        box.appendChild(b);
      });
    });
    applyLive(data.live);
  }catch(e){
    box.dataset.state='retrying'; box.textContent='Loading FRIDAY features — retrying…';
    clearTimeout(loadMenu.retryTimer);
    loadMenu.retryTimer=setTimeout(loadMenu,2000);
  }
}
function openFeature(f){
  if(f.id==='/'){ el('menu').classList.remove('open'); showChat(); el('text').focus(); return; }
  if(!ws||ws.readyState!==1){ fail('Not connected to FRIDAY.'); return; }
  add(f.label,'me'); setState('loading '+f.label+'…');
  armWatchdog(f.label);
  if(f.read){ ws.send(JSON.stringify({type:'command',method:f.read,field:f.field||'',label:f.label})); }
  else { ws.send(JSON.stringify({type:'chat',prompt:f.prompt})); }
}
/* Runnable comes from the published registry flag (capabilityRunnable).
   Models are chat-about; every other type hits the real planner so the
   desktop approval gate still decides. A missing flag treats non-models
   as runnable so a new type cannot silently stay chat-only. */
function isRunnable(c){
  if(typeof c.runnable==='boolean') return c.runnable;
  return c.type!=='model';
}
function useCapability(c){
  if(!ws||ws.readyState!==1){ fail('Not connected to FRIDAY.'); return; }
  add(c.name,'me'); setState('working…'); armWatchdog(c.name);
  if(isRunnable(c)){
    ws.send(JSON.stringify({type:'task',goal:'Use your '+c.type+' "'+c.name+'" now and report the result.',capability:c.id}));
  }else{
    ws.send(JSON.stringify({type:'chat',prompt:'Tell me about your '+c.type+' "'+c.name+'" and its current state.',capability:c.id}));
  }
}

el('menuBtn').onclick=()=>el('menu').classList.toggle('open');
/* Same backoff as electron/kernel-auto-restart.cjs: immediate, 2s, 8s.
   The phone never gives up — after the cap it keeps using 8s. */
const DELAYS=[0,2000,8000];
let reconnectAttempt=0;
function scheduleReconnect(){
  const delay=DELAYS[Math.min(reconnectAttempt, DELAYS.length-1)];
  reconnectAttempt+=1;
  setTimeout(connect, delay);
}
function connect(){
  const token=localStorage.getItem(KEY);
  if(!token){el('pair').hidden=false;el('composer').hidden=true;setState('not paired',true);return;}
  el('pair').hidden=true;el('composer').hidden=false;
  if(ws){ try{ ws.onclose=null; ws.onerror=null; ws.close(); }catch(e){} ws=null; }
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/companion/ws');
  ws.onopen=()=>{ reconnectAttempt=0; ws.send(JSON.stringify({token})); };
  ws.onclose=()=>{settled();setState('FRIDAY is offline — reconnecting…',true);scheduleReconnect();};
  ws.onerror=()=>setState('cannot reach FRIDAY on this network',true);
  let bubble=null;
  ws.onmessage=ev=>{const m=JSON.parse(ev.data);
    if(m.type==='ready'){setState(liveLine?('connected · '+liveLine):'connected');loadMenu();return;}
    if(m.type==='denied'){localStorage.removeItem(KEY);setState('pairing revoked',true);location.reload();return;}
    /* The desktop and the phone share ONE conversation: a turn typed on the PC
       is mirrored here live instead of only showing up after a reconnect. */
    if(m.type==='peer'){
      const peerText=(m.role==='user'&&m.origin!=='phone'?'🖥 ':'')+m.text;
      const peerClass=m.role==='user'?'me':'fr';
      const last=el('log').lastElementChild;
      if(last&&last.classList.contains(peerClass)&&last.textContent===peerText){
        return;
      }
      add(peerText, peerClass);
      maybeNotify('FRIDAY', m.text||''); return; }
    /* Reconnect: replay the shared session so the phone is not an empty log. */
    if(m.type==='history'){
      el('log').innerHTML='';
      let lastText=null, lastWho=null;
      (m.messages||[]).forEach(row=>{
        if(row&&row.text){
          const who=row.role==='user'?'me':'fr';
          const txt=(row.role==='user'&&row.origin==='desktop'?'🖥 ':'')+row.text;
          if(txt!==lastText||who!==lastWho){
            add(txt, who);
            lastText=txt; lastWho=who;
          }
        }
      });
      return;
    }
    /* Coarse live facts from the same companion-features file (not a second sync). */
    if(m.type==='live'){ applyLive(m.live); return; }
    /* Sections / capabilities changed on the desktop — re-read the one registry. */
    if(m.type==='refresh'){ loadMenu(); return; }
    if(m.type==='step'){ add(m.text,'fr'); awaiting=true; setState('working…'); return; }
    if(m.type==='delta'){ if(!bubble) bubble=add('','fr'); bubble.textContent+=m.text; awaiting=true; }
    if(m.type==='heard'){ add(m.text,'me'); setState('thinking…'); }
    if(m.type==='data'){ settled(); add(m.text,'fr'); setState(liveLine?('connected · '+liveLine):'connected'); }
    if(m.type==='done'){ settled(); if(bubble){speak(bubble.textContent);} bubble=null; setState(liveLine?('connected · '+liveLine):'connected'); }
    if(m.type==='error'){ settled(); add(m.error,'err'); setState(m.error,true); bubble=null; }
  };
}
el('pairBtn').onclick=async()=>{
  el('pairErr').textContent='';
  try{
    const res=await fetch('/companion/pair',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({code:el('code').value.trim(),label:navigator.userAgent.slice(0,40)})});
    if(!res.ok){el('pairErr').textContent=res.status===403?'Phone access is turned off in FRIDAY settings.':'That code is wrong or expired.';return;}
    const data=await res.json();localStorage.setItem(KEY,data.token);connect();
  }catch(e){ el('pairErr').textContent='FRIDAY could not be reached: '+e; }
};
function send(text){ if(!text)return;
  if(!ws||ws.readyState!==1){ fail('Not connected to FRIDAY — check that her app is running and phone access is on.'); return; }
  add(text,'me'); setState('thinking…'); armWatchdog('Your message');
  ws.send(JSON.stringify({type:'chat',prompt:text})); el('text').value=''; }
el('send').onclick=()=>send(el('text').value.trim());
el('text').addEventListener('keydown',e=>{if(e.key==='Enter')send(el('text').value.trim());});
/* ---- voice: the phone's microphone goes to FRIDAY's OWN transcriber ----
   Mobile browsers block SpeechRecognition on plain-http LAN origins, so the
   audio itself is streamed over this already-authenticated websocket and
   transcribed by kernel/stt.py (faster-whisper), exactly like the desktop. */
let recorder=null, chunks=[];
async function startMic(){
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    const msg=!window.isSecureContext
      ?'Microphone requires HTTPS or localhost (secure context). Open companion via https:// or Tailscale.'
      :'This browser cannot record audio.';
    fail(msg); return;
  }
  try{
    const stream=await navigator.mediaDevices.getUserMedia({audio:true});
    const mime=['audio/webm;codecs=opus','audio/webm','audio/mp4','audio/ogg;codecs=opus','audio/aac']
      .find(t=>{try{return MediaRecorder.isTypeSupported(t)}catch(e){return false}})||'';
    recorder=mime?new MediaRecorder(stream,{mimeType:mime}):new MediaRecorder(stream);
    chunks=[];
    recorder.ondataavailable=e=>{ if(e.data&&e.data.size) chunks.push(e.data); };
    recorder.onstop=async()=>{
      stream.getTracks().forEach(t=>t.stop());
      const blob=new Blob(chunks,{type:recorder.mimeType||mime||'audio/webm'});
      recorder=null; el('mic').classList.remove('on');
      if(blob.size<800){ setState('nothing was recorded',true); return; }
      if(!ws||ws.readyState!==1){ fail('Not connected to FRIDAY — voice needs the live connection.'); return; }
      setState('transcribing…'); armWatchdog('Your voice message');
      const reader=new FileReader();
      reader.onloadend=()=>{
        const b64=(reader.result||'').toString().split(',')[1]||'';
        if(!b64){ fail('Audio encoding failed.'); return; }
        ws.send(JSON.stringify({type:'audio',mime:blob.type,audio:b64,language:navigator.language||''}));
      };
      reader.readAsDataURL(blob);
    };
    recorder.start(250);
    el('mic').classList.add('on'); setState('listening… tap 🎤 to send');
  }catch(e){ fail('Microphone permission was refused: '+e); }
}
el('mic').onclick=()=>{ if(recorder){ try{recorder.stop()}catch(e){} } else { startMic(); } };
async function startCam(){
  if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
    const msg=!window.isSecureContext
      ?'Camera requires HTTPS or localhost (secure context). Open companion via https:// or Tailscale.'
      :'This browser cannot use the camera.';
    fail(msg); return;
  }
  if(!ws||ws.readyState!==1){ fail('Not connected to FRIDAY — the camera still needs the live connection.'); return; }
  try{
    const stream=await navigator.mediaDevices.getUserMedia({video:true,audio:false});
    const video=document.createElement('video'); video.autoplay=true; video.muted=true; video.playsInline=true; video.srcObject=stream;
    await new Promise((resolve,reject)=>{ video.onloadeddata=resolve; setTimeout(()=>reject(new Error('camera start timed out')),8000); });
    const canvas=document.createElement('canvas'); canvas.width=video.videoWidth||640; canvas.height=video.videoHeight||480;
    const ctx=canvas.getContext('2d'); if(!ctx){ stream.getTracks().forEach(t=>t.stop()); fail('Could not draw the camera frame.'); return; }
    ctx.drawImage(video,0,0); stream.getTracks().forEach(t=>t.stop());
    perm.camera='granted';
    const data=canvas.toDataURL('image/jpeg',0.8);
    const b64=data.split(',')[1]||'';
    if(b64.length<80){ fail('The camera still was empty.'); return; }
    add('📷 camera still','me'); setState('looking…'); armWatchdog('Your camera still');
    ws.send(JSON.stringify({type:'camera',mime:'image/jpeg',image:b64}));
  }catch(e){ perm.camera='denied'; fail('Camera permission was refused: '+e); }
}
el('cam').onclick=()=>{ startCam(); };
function fitKeyboard(){
  const vv=window.visualViewport; if(!vv) return;
  document.body.style.height=Math.round(vv.height)+'px';
}
if(window.visualViewport){
  window.visualViewport.addEventListener('resize', fitKeyboard);
  window.visualViewport.addEventListener('scroll', fitKeyboard);
  fitKeyboard();
}
connect();
</script></body></html>"""

COMPANION_SW = """self.addEventListener('install', event => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({type:'window', includeUncontrolled:true}).then(clients => {
    for (const client of clients) { if ('focus' in client) return client.focus(); }
    if (self.clients.openWindow) return self.clients.openWindow('/companion');
  }));
});
self.addEventListener('periodicsync', event => {
  if (event.tag === 'friday-companion') event.waitUntil(Promise.resolve());
});
"""

MANIFEST = {
    "name": "FRIDAY Companion",
    "short_name": "FRIDAY",
    "start_url": "/companion",
    "scope": "/companion",
    "display": "standalone",
    "background_color": "#05070d",
    "theme_color": "#05070d",
    "icons": [
        {
            "src": "/companion/icon-192.png",
            "sizes": "192x192",
            "type": "image/png",
            "purpose": "any",
        },
        {
            "src": "/companion/icon-512.png",
            "sizes": "512x512",
            "type": "image/png",
            "purpose": "any",
        },
    ],
    "serviceworker": {"src": "/companion/sw.js", "scope": "/companion"},
}

# Live phone sockets. The desktop pushes into these so the phone sees the SAME
# conversation and the SAME registry as the PC, live, instead of a snapshot
# frozen at connect time.
PHONE_SOCKETS: set = set()
# The phone that originated a chat/task is excluded from phone_broadcast so it
# does not see its own turn twice (it already rendered it locally).
_PHONE_SENDER: ContextVar = ContextVar("friday_phone_sender", default=None)


async def phone_broadcast(payload: dict, exclude_ws: Any = None) -> None:
    sender = exclude_ws if exclude_ws is not None else _PHONE_SENDER.get()
    dead = []
    for ws in list(PHONE_SOCKETS):
        if sender is not None and ws is sender:
            continue
        try:
            await ws.send_text(json.dumps(payload))
        except Exception:
            dead.append(ws)
    for ws in dead:
        PHONE_SOCKETS.discard(ws)


def phones_connected() -> int:
    return len(PHONE_SOCKETS)


def summarise(label: str, result: dict, field: str) -> str:
    """Turn one kernel read into a short, phone-sized text block."""
    if not isinstance(result, dict):
        return f"{label}: {result}"
    rows = result.get(field) if field else None
    if isinstance(rows, list):
        if not rows:
            return f"{label}: nothing here yet."
        lines = []
        for row in rows[:25]:
            if isinstance(row, dict):
                name = row.get("label") or row.get("name") or row.get("title") or row.get("id")
                extra = row.get("status") or row.get("state") or row.get("provider") or ""
                lines.append(f"• {name}{f' — {extra}' if extra else ''}")
            else:
                lines.append(f"• {row}")
        more = f"\n…and {len(rows) - 25} more" if len(rows) > 25 else ""
        return f"{label} ({len(rows)}):\n" + "\n".join(lines) + more
    parts = [f"{k}: {v}" for k, v in result.items() if not isinstance(v, (dict, list))]
    return f"{label}:\n" + "\n".join(parts[:20]) if parts else f"{label}: no details reported."


def build_router(
    store: CompanionStore,
    chat_handler,
    speak_handler,
    enabled,
    transcribe_handler=None,
    command_handler=None,
    features_provider=None,
    capabilities_provider=None,
    task_handler=None,
    history_provider=None,
    live_provider=None,
    whats_new_provider=None,
) -> APIRouter:
    """`chat_handler(prompt, send)` streams deltas; `speak_handler(text)` returns base64 mp3.

    `transcribe_handler(bytes, mime, language)` reuses FRIDAY's own STT
    (kernel/stt.py). `command_handler(method, params)` reuses the kernel's own
    dispatch table, restricted to read-only methods. `features_provider()`
    returns the desktop navigation registry so the phone menu mirrors it.
    `history_provider()` replays the shared session so a reconnecting phone
    sees the same conversation, not an empty log. `live_provider()` returns
    the coarse desktop snapshot (voice, doctor, connectors) from the same
    companion-features file. `whats_new_provider()` returns CHANGELOG.md
    sections for the What's New panel — never invented notes.
    """
    router = APIRouter(prefix="/companion")

    def guard() -> None:
        if not enabled():
            raise HTTPException(status_code=403, detail="Phone access is turned off in FRIDAY settings.")

    @router.get("", response_class=HTMLResponse)
    @router.get("/", response_class=HTMLResponse)
    async def page() -> HTMLResponse:
        guard()
        return HTMLResponse(COMPANION_HTML)

    @router.get("/manifest.json")
    async def manifest() -> JSONResponse:
        return JSONResponse(MANIFEST)

    @router.get("/sw.js")
    async def service_worker() -> Response:
        return Response(
            content=COMPANION_SW,
            media_type="text/javascript",
            headers={"Cache-Control": "no-cache"},
        )

    def _icon_response() -> Response:
        png = companion_icon_png()
        if not png:
            raise HTTPException(status_code=404, detail="FRIDAY icon is not packaged.")
        return Response(content=png, media_type="image/png")

    @router.get("/icon-192.png")
    async def icon_192() -> Response:
        return _icon_response()

    @router.get("/icon-512.png")
    async def icon_512() -> Response:
        return _icon_response()

    @router.get("/features")
    async def features(token: str = "") -> JSONResponse:
        guard()
        if not store.valid(token):
            raise HTTPException(status_code=401, detail="This phone is not paired.")
        return JSONResponse(
            {
                "features": features_provider() if features_provider else [],
                "capabilities": capabilities_provider() if capabilities_provider else [],
                "live": live_provider() if live_provider else {},
                "whatsNew": (whats_new_provider() if whats_new_provider else companion_whats_new()),
            }
        )

    @router.get("/whats-new")
    async def whats_new(token: str = "") -> JSONResponse:
        guard()
        if not store.valid(token):
            raise HTTPException(status_code=401, detail="This phone is not paired.")
        return JSONResponse(whats_new_provider() if whats_new_provider else companion_whats_new())

    @router.post("/pair")
    async def pair(request: Request) -> JSONResponse:
        guard()
        body = await request.json()
        phone = store.redeem(str(body.get("code", "")), str(body.get("label", "Phone")))
        if not phone:
            raise HTTPException(status_code=401, detail="Pairing code is wrong or expired.")
        return JSONResponse({"token": phone["token"], "id": phone["id"]})

    @router.post("/speak")
    async def speak(request: Request) -> JSONResponse:
        guard()
        body = await request.json()
        if not store.valid(str(body.get("token", ""))):
            raise HTTPException(status_code=401, detail="This phone is not paired.")
        audio = await speak_handler(str(body.get("text", "")))
        return JSONResponse({"audio": audio})

    @router.websocket("/ws")
    async def socket(ws: WebSocket) -> None:
        await ws.accept()
        if not enabled():
            await ws.send_text(json.dumps({"type": "denied"}))
            await ws.close(code=4403)
            return
        hello = json.loads(await ws.receive_text())
        phone = store.valid(str(hello.get("token", "")))
        if not phone:
            await ws.send_text(json.dumps({"type": "denied"}))
            await ws.close(code=4401)
            return
        PHONE_SOCKETS.add(ws)
        await ws.send_text(json.dumps({"type": "ready", "phone": phone["label"]}))
        if history_provider:
            try:
                rows = history_provider()
                messages = []
                for row in rows or []:
                    if not isinstance(row, dict) or not row.get("text"):
                        continue
                    item = {"role": row.get("role"), "text": row.get("text") or ""}
                    if row.get("origin"):
                        item["origin"] = row.get("origin")
                    messages.append(item)
                if messages:
                    await ws.send_text(json.dumps({"type": "history", "messages": messages}))
            except Exception:
                pass
        if live_provider:
            try:
                live = live_provider()
                if isinstance(live, dict) and live:
                    await ws.send_text(json.dumps({"type": "live", "live": live}))
            except Exception:
                pass

        async def send(payload: dict) -> None:
            await ws.send_text(json.dumps(payload))

        try:
            while True:
                message = json.loads(await ws.receive_text())
                kind = message.get("type")
                sender_token = _PHONE_SENDER.set(ws)
                try:
                    if kind == "chat":
                        # Same pipeline as a desktop message: the approval/permission
                        # system still gates every tool the answer may want to run.
                        try:
                            await chat_handler(str(message.get("prompt", "")), send)
                            await send({"type": "done"})
                        except Exception as exc:
                            await send({"type": "error", "error": str(exc)})
                        continue

                    if kind == "camera":
                        try:
                            import base64 as _b64

                            raw = _b64.b64decode(str(message.get("image", "")))
                        except Exception as exc:
                            await send({"type": "error", "error": f"Camera still could not be decoded: {exc}"})
                            continue
                        if len(raw) < 80:
                            await send({"type": "error", "error": "The camera still was empty."})
                            continue
                        extra = (
                            f"FILE: phone-camera.jpg (image/jpeg, {len(raw)} bytes)\n"
                            "  An image was attached."
                        )
                        try:
                            await chat_handler(
                                "I sent a camera still from my phone. Please look at it.",
                                send,
                                extra,
                            )
                            await send({"type": "done"})
                        except Exception as exc:
                            await send({"type": "error", "error": str(exc)})
                        continue

                    if kind == "audio":
                        if transcribe_handler is None:
                            await send({"type": "error", "error": "FRIDAY's transcriber is not available on this machine."})
                            continue
                        try:
                            import base64

                            raw = base64.b64decode(str(message.get("audio", "")))
                            result = await transcribe_handler(
                                raw, str(message.get("mime", "")), str(message.get("language", ""))
                            )
                        except Exception as exc:
                            await send({"type": "error", "error": f"Transcription failed: {exc}"})
                            continue
                        if not result.get("ok"):
                            await send({"type": "error", "error": result.get("error") or "Transcription failed."})
                            continue
                        text = str(result.get("text", "")).strip()
                        if not text:
                            await send({"type": "error", "error": "FRIDAY heard only silence."})
                            continue
                        await send({"type": "heard", "text": text})
                        try:
                            await chat_handler(text, send)
                            await send({"type": "done"})
                        except Exception as exc:
                            await send({"type": "error", "error": str(exc)})
                        continue

                    if kind == "command":
                        if command_handler is None:
                            await send({"type": "error", "error": "This build cannot run feature reads from the phone."})
                            continue
                        method = str(message.get("method", ""))
                        label = str(message.get("label", method))
                        try:
                            result = await command_handler(method, message.get("params") or {})
                        except Exception as exc:
                            await send({"type": "error", "error": f"{label}: {exc}"})
                            continue
                        await send({"type": "data", "text": summarise(label, result, str(message.get("field", "")))})
                        continue

                    if kind == "task":
                        # A phone can ask FRIDAY to actually DO something: this runs
                        # the same planner the desktop uses (kernel/planner.py), so
                        # every risky step still stops at the owner's approval gate
                        # on the PC — the phone only watches it happen.
                        if task_handler is None:
                            await send({"type": "error", "error": "This build cannot run tasks from the phone."})
                            continue
                        try:
                            await task_handler(str(message.get("goal", "")), send)
                            await send({"type": "done"})
                        except Exception as exc:
                            await send({"type": "error", "error": str(exc)})
                        continue
                finally:
                    _PHONE_SENDER.reset(sender_token)
        except WebSocketDisconnect:
            return
        finally:
            PHONE_SOCKETS.discard(ws)

    return router


