// FRIDAY · skill: ops-file-path-check
// Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
// File type risk and Windows path problems. Checks a file name or a Windows path before you trust or use it.
// It holds 2 small tools (parts). A request that names one runs it; otherwise every tool whose topic matches the
// request runs, the first answer is the main result and the others are listed under "also". Pass part to pick one.

const PARTS = [
  {
    id: "ops-file-type",
    gate: /\.[a-z0-9]{1,5}\b|extension|file type|\bfile\b/,
    run: (() => {
      // FRIDAY · skill: ops-file-type
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // What a file name or extension is, whether it can run code on Windows, and the double-extension trick.

      // ext: [kind, risk, note]
      const T = {
        exe: ["Windows program", "high", "Runs code the moment you open it."],
        msi: ["Windows installer", "high", "Installs software with admin rights."],
        bat: ["Batch script", "high", "Runs commands."],
        cmd: ["Command script", "high", "Runs commands."],
        com: ["DOS program", "high", "Runs code; also the ending of web domain names."],
        scr: ["Screen saver program", "high", "Really an executable."],
        pif: ["Program shortcut", "high", "Really an executable."],
        ps1: ["PowerShell script", "high", "Runs commands."],
        vbs: ["VBScript", "high", "Runs commands through Windows Script Host."],
        vbe: ["Encoded VBScript", "high", "Runs hidden commands."],
        js: ["JavaScript", "high", "Opened from Explorer it runs under Windows Script Host."],
        jse: ["Encoded JavaScript", "high", "Runs hidden commands."],
        wsf: ["Windows Script File", "high", "Runs commands."],
        hta: ["HTML application", "high", "Runs with full local rights."],
        jar: ["Java program", "high", "Runs code if Java is installed."],
        reg: ["Registry file", "high", "Changes Windows settings when merged."],
        lnk: ["Shortcut", "high", "Can launch any command; common in phishing."],
        dll: ["Program library", "high", "Code that other programs load."],
        cpl: ["Control Panel item", "high", "Runs code."],
        msc: ["Management console", "medium", "Opens an admin tool."],
        docm: ["Word document with macros", "medium", "Macros can run code."],
        xlsm: ["Excel workbook with macros", "medium", "Macros can run code."],
        pptm: ["PowerPoint with macros", "medium", "Macros can run code."],
        zip: ["ZIP archive", "medium", "Look inside before running anything it holds."],
        rar: ["RAR archive", "medium", "Look inside before running anything it holds."],
        "7z": ["7-Zip archive", "medium", "Look inside before running anything it holds."],
        iso: ["Disc image", "medium", "Mounts like a drive and can hold programs."],
        img: ["Disc image", "medium", "Mounts like a drive and can hold programs."],
        html: ["Web page", "medium", "Local pages can still show fake login forms."],
        htm: ["Web page", "medium", "Local pages can still show fake login forms."],
        svg: ["Vector image", "medium", "Can contain scripts."],
        pdf: ["PDF document", "low", "Opens in a reader; keep the reader updated."],
        doc: ["Word document", "low", "Old format that may hold macros."],
        docx: ["Word document", "low", "No macros in this format."],
        xls: ["Excel workbook", "low", "Old format that may hold macros."],
        xlsx: ["Excel workbook", "low", "No macros in this format."],
        ppt: ["PowerPoint", "low", "Old format."],
        pptx: ["PowerPoint", "low", "No macros in this format."],
        txt: ["Plain text", "low", "Only text."],
        md: ["Markdown text", "low", "Only text."],
        csv: ["Comma-separated table", "low", "Only text; Excel may treat =formulas as live."],
        json: ["JSON data", "low", "Only text."],
        xml: ["XML data", "low", "Only text."],
        log: ["Log file", "low", "Only text."],
        png: ["PNG image", "low", "Picture."],
        jpg: ["JPEG image", "low", "Picture."],
        jpeg: ["JPEG image", "low", "Picture."],
        gif: ["GIF image", "low", "Picture."],
        webp: ["WebP image", "low", "Picture."],
        bmp: ["Bitmap image", "low", "Picture."],
        mp3: ["MP3 audio", "low", "Sound."],
        wav: ["WAV audio", "low", "Sound."],
        m4a: ["AAC audio", "low", "Sound."],
        mp4: ["MP4 video", "low", "Video."],
        mkv: ["Matroska video", "low", "Video."],
        mov: ["QuickTime video", "low", "Video."],
        py: ["Python script", "medium", "Runs code if Python opens it."],
        sh: ["Shell script", "medium", "Runs commands in WSL or Git Bash."],
        gguf: ["Local model weights", "low", "Data for a local model runner."],
        onnx: ["ONNX model", "low", "Data for a model runner."],
      };
      const RUNNABLE = new Set(Object.keys(T).filter((k) => T[k][1] === "high"));
      const DOCLIKE = new Set([
        "pdf",
        "doc",
        "docx",
        "xls",
        "xlsx",
        "ppt",
        "pptx",
        "txt",
        "jpg",
        "jpeg",
        "png",
        "gif",
        "mp3",
        "mp4",
        "csv",
      ]);

      async function run(input = {}) {
        const text = String(input?.file ?? input?.prompt ?? input?.text ?? "");
        const tokens = text
          .split(/[\s,;"'`()<>]+/)
          .map((s) => s.replace(/[?!]+$/, "").replace(/^[.:]+(?=\.)/, ""))
          .filter((s) => /\.[a-z0-9]{1,5}$/i.test(s) && !/^https?:\/\//i.test(s));
        const items = [];
        for (const raw of [...new Set(tokens)].slice(0, 20)) {
          const parts = raw.toLowerCase().split(".");
          const ext = parts[parts.length - 1];
          const known = T[ext];
          if (!known) continue;
          const earlier = parts.length > 2 ? parts.slice(1, -1) : [];
          const doubleTrick = RUNNABLE.has(ext) && earlier.some((e) => DOCLIKE.has(e));
          items.push({
            name: raw,
            extension: ext,
            kind: known[0],
            risk: doubleTrick ? "high" : known[1],
            note: doubleTrick
              ? `Looks like a .${earlier[earlier.length - 1]} file but really ends in .${ext}: a classic disguise.`
              : known[2],
            canRunCode: RUNNABLE.has(ext),
          });
        }
        if (!items.length) {
          const bare = /(?:^|\s)\.?([a-z0-9]{1,5})\s+file/i.exec(text);
          if (bare && T[bare[1].toLowerCase()]) {
            const e = bare[1].toLowerCase();
            items.push({
              name: "." + e,
              extension: e,
              kind: T[e][0],
              risk: T[e][1],
              note: T[e][2],
              canRunCode: RUNNABLE.has(e),
            });
          }
        }
        if (!items.length)
          return {
            ok: false,
            error: "No known file type found; give a file name like report.pdf.exe.",
          };
        return {
          ok: true,
          items,
          answer: items.map((i) => `${i.name}: ${i.kind}, risk ${i.risk}. ${i.note}`).join("\n"),
        };
      }

      return run;
    })(),
  },
  {
    id: "ops-win-path",
    gate: /path|[a-z]:\\|folder|directory|wsl|260/,
    run: (() => {
      // FRIDAY · skill: ops-win-path
      // Runs inside the sandbox harness, which calls run(input). Deterministic, offline, no network.
      // Checks Windows paths for the problems that break installs and file tools, and converts to and from WSL paths.

      const RESERVED = new Set([
        "CON",
        "PRN",
        "AUX",
        "NUL",
        ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
        ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
      ]);
      const PROTECTED = [
        /\\Windows(\\|$)/i,
        /\\Program Files( \(x86\))?(\\|$)/i,
        /\\ProgramData(\\|$)/i,
        /^[A-Za-z]:\\?$/,
      ];
      const SYNCED = [/\\OneDrive[^\\]*(\\|$)/i, /\\Dropbox(\\|$)/i, /\\Google Drive(\\|$)/i];

      function pathsOf(input) {
        const direct = input?.path ?? input?.paths;
        if (Array.isArray(direct)) return direct.map(String);
        if (typeof direct === "string" && direct.trim()) return [direct.trim()];
        const raw = String(input?.text ?? input?.prompt ?? "");
        const quoted = [...raw.matchAll(/"([^"\r\n]+)"/g)].map((m) => m[1].trim());
        if (quoted.length) return quoted;
        // A path may hold spaces ("Program Files") and a bad character, so it runs from its start to the next
        // path start, a line end, a comma, a semicolon or " and " / " or ".
        const starts = [
          ...raw.matchAll(/(?:[A-Za-z]:[\\/]|\\\\[^\\\s]+\\|\/mnt\/[a-z](?:\/|\b))/g),
        ].map((m) => m.index);
        const out = starts.map((at, i) => {
          let seg = raw.slice(at, starts[i + 1] ?? raw.length);
          seg = seg.split(/\r?\n|,\s|;\s|\s+(?:and|or|vs)\s+/i)[0];
          return seg.trim();
        });
        return out.filter(Boolean);
      }

      function toWsl(p) {
        const drive = p.match(/^([A-Za-z]):[\\/]?(.*)$/);
        if (drive)
          return `/mnt/${drive[1].toLowerCase()}/${drive[2].replace(/\\/g, "/")}`.replace(
            /\/$/,
            "",
          );
        return null;
      }
      function fromWsl(p) {
        const m = p.match(/^\/mnt\/([a-z])(?:\/(.*))?$/);
        return m ? `${m[1].toUpperCase()}:\\${(m[2] ?? "").replace(/\//g, "\\")}` : null;
      }

      function check(original) {
        const problems = [];
        const warnings = [];
        let p = original;
        const wslForm = fromWsl(p);
        if (wslForm) {
          warnings.push("This is a WSL path; the Windows form is shown below.");
          p = wslForm;
        }
        const unc = /^\\\\/.test(p);
        const drive = /^[A-Za-z]:/.test(p);
        const longPrefix = /^\\\\\?\\/.test(p);
        if (!unc && !drive)
          warnings.push("Relative path: it depends on the folder the program starts in.");
        const body = longPrefix ? p.slice(4) : p;
        const rest = drive ? body.slice(2) : body;
        if (/[<>"|?*]/.test(rest.replace(/^\\\\\?\\/, "")))
          problems.push('Contains a character Windows forbids in names: < > " | ? *');
        if (/:/.test(rest))
          problems.push(
            "A colon is only allowed right after the drive letter (it creates an alternate data stream otherwise).",
          );
        if (/[\u0000-\u001f]/.test(p)) problems.push("Contains a control character.");
        if (/\//.test(p) && /\\/.test(p)) warnings.push("Mixes / and \\ separators.");
        const parts = body.split(/[\\/]+/).filter((x, i) => x || i === 0);
        for (const part of parts.slice(drive ? 1 : 0)) {
          if (!part) continue;
          const stem = part.split(".")[0].toUpperCase();
          if (RESERVED.has(stem)) problems.push(`"${part}" is a reserved device name (${stem}).`);
          if (/[. ]$/.test(part) && part !== "." && part !== "..")
            problems.push(`"${part}" ends with a dot or a space, which Windows silently drops.`);
          if (part.length > 255)
            problems.push(`A name is ${part.length} characters; the limit is 255.`);
        }
        if (!longPrefix && p.length >= 260) {
          problems.push(
            `The path is ${p.length} characters; the classic limit is 260 (MAX_PATH). Use the \\\\?\\ prefix or enable long paths.`,
          );
        } else if (!longPrefix && p.length >= 200) {
          warnings.push(
            `${p.length} characters is close to the 260 limit once a file name is added.`,
          );
        }
        if (PROTECTED.some((re) => re.test(p)))
          warnings.push("A protected location: writing here needs administrator rights.");
        if (SYNCED.some((re) => re.test(p)))
          warnings.push(
            "A cloud-synced folder: sync clients can lock files while a build or install runs.",
          );
        if (/\s/.test(p)) warnings.push("The path has spaces: quote it on the command line.");
        if (/[^\u0000-\u007f]/.test(p))
          warnings.push("Non-ASCII characters: some older tools mishandle them.");
        const suggestion = original
          .replace(/[<>"|?*]/g, "_")
          .replace(/(?<=[\\/])([^\\/]*?)[. ]+(?=[\\/]|$)/g, "$1");
        return {
          path: original,
          ok: problems.length === 0,
          problems,
          warnings,
          windows: wslForm ?? (drive || unc ? p : null),
          wsl: toWsl(p),
          ...(problems.length && suggestion !== original ? { suggestion } : {}),
        };
      }

      async function run(input = {}) {
        const paths = pathsOf(input);
        if (!paths.length)
          return {
            ok: false,
            error: "Give a path such as C:\\Users\\me\\FRIDAY or /mnt/d/FRIDAY.",
          };
        const results = paths.map(check);
        const bad = results.filter((r) => !r.ok);
        return {
          ok: true,
          answer: bad.length
            ? `${bad.length} of ${results.length} path(s) have a problem: ${bad[0].problems[0]}`
            : `${results.length} path(s) are valid.`,
          results,
        };
      }

      return run;
    })(),
  },
];

const PLAIN = new Set(["prompt", "text", "previous"]);

export async function run(input = {}) {
  const wanted = input?.part != null ? String(input.part) : "";
  const prompt = String(input?.prompt ?? input?.text ?? "").toLowerCase();
  const structured = Object.keys(input ?? {}).some((k) => !PLAIN.has(k));
  const chosen = wanted ? PARTS.filter((p) => p.id === wanted) : PARTS;
  if (wanted && !chosen.length) {
    return {
      ok: false,
      error: `Unknown part "${wanted}". Parts: ${PARTS.map((p) => p.id).join(", ")}.`,
    };
  }
  const hits = [];
  const misses = [];
  for (const p of chosen) {
    if (!wanted && p.gate && !structured && !p.gate.test(prompt)) continue;
    let r;
    try {
      r = await p.run(input);
    } catch (error) {
      r = { ok: false, error: String(error?.message ?? error) };
    }
    if (r && r.ok === true) hits.push({ part: p.id, result: r });
    else misses.push({ part: p.id, result: r });
  }
  if (!hits.length) {
    if (wanted) return { ...(misses[0]?.result ?? { ok: false }), ok: false, part: wanted };
    return {
      ok: false,
      error: misses.length
        ? misses.map((m) => `${m.part}: ${m.result?.error ?? "not for this request"}`).join(" | ")
        : `Nothing in this request fits: ${PARTS.map((p) => p.id).join(", ")}.`,
      parts: PARTS.map((p) => p.id),
    };
  }
  const [first, ...rest] = hits;
  const out = { ...first.result, part: first.part };
  if (rest.length) out.also = rest.map((h) => ({ part: h.part, answer: h.result.answer ?? null }));
  return out;
}

export default run;
