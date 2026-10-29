/**
 * One shared conversation across devices.
 *
 * A message sent from the paired phone must join the SAME session the desktop
 * is using — same history, same memory — and must be mirrored to the desktop
 * as it happens, not discovered later in a separate "companion" thread.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const kernel = fs.readFileSync(path.join(root, "kernel/main.py"), "utf8");
const preload = fs.readFileSync(path.join(root, "electron/preload.cjs"), "utf8");
const main = fs.readFileSync(path.join(root, "electron/main.cjs"), "utf8");

describe("shared phone session", () => {
  it("never writes phone turns to a separate companion thread", () => {
    expect(kernel).not.toMatch(/append_chat,\s*"companion"/);
  });

  it("writes phone turns into the active desktop session", () => {
    const handler = kernel.slice(
      kernel.indexOf("async def companion_chat"),
      kernel.indexOf("async def companion_speak"),
    );
    expect(handler).toContain("session_id = ACTIVE_SESSION");
    expect(handler).toMatch(/append_chat, session_id, "user"/);
    expect(handler).toMatch(/append_chat, session_id, "assistant"/);
    expect(handler).toContain('origin="phone"');
    expect(handler).toContain("phone_broadcast");
  });

  it("mirrors the phone turn to every connected desktop bridge", () => {
    const handler = kernel.slice(
      kernel.indexOf("async def companion_chat"),
      kernel.indexOf("async def companion_speak"),
    );
    expect(handler).toContain("broadcast(");
    expect(kernel).toContain("DESKTOP_CLIENTS.add(ws)");
    expect(kernel).toContain("DESKTOP_CLIENTS.discard(ws)");
  });

  it("lets the desktop declare which conversation is open", () => {
    expect(kernel).toContain('if method == "session.active"');
    expect(kernel).toContain('globals()["ACTIVE_SESSION"] = session_id');
    expect(main).toContain('ipcMain.handle("session:set-active"');
    expect(preload).toContain("setActiveSession:");
  });

  it("hands a phone turn to desktop Core Brain when a window is connected", () => {
    const handler = kernel.slice(
      kernel.indexOf("async def companion_chat"),
      kernel.indexOf("async def companion_speak"),
    );
    expect(handler).toContain("DESKTOP_CLIENTS");
    expect(handler).toContain("companion.cognize");
    expect(handler).toContain("router.stream");
    expect(preload).toContain('onCompanionCognize: on("companion:cognize")');
    expect(main).toContain('send("companion:cognize"');
    expect(main).toContain("companion.cognize_ack");
  });

  it("keeps the mirror socket independent of the chat socket", () => {
    // Chat must never stall because the mirror dropped, so the mirror owns its
    // own connection and reconnects with backoff.
    expect(main).toContain("function connectSessionStream()");
    expect(main).toContain("scheduleSessionReconnect");
  });
});
