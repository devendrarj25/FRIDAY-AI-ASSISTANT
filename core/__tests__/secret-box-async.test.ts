/**
 * Secret storage on Electron's asynchronous safeStorage API.
 *
 * Electron 46 removes `isEncryptionAvailable`, `encryptString` and `decryptString`. FRIDAY's stored provider keys,
 * connector tokens, voice profile and voiceprint now go through electron/secret-box.cjs, which uses only
 * `isAsyncEncryptionAvailable`, `encryptStringAsync` and `decryptStringAsync`.
 *
 * These tests use a MOCK safeStorage and synthetic secrets. The mock proves the contract FRIDAY relies on (the
 * return shape, the order of calls, what is written, what survives a failure). It does not prove that real
 * Windows DPAPI opens ciphertext that an older build wrote with `encryptString`: Electron documents that, and
 * it stays unverified on a real Windows PC until the owner checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const secretBox = require("../../electron/secret-box.cjs");
const credentials = require("../../electron/credentials.cjs");
const models = require("../../electron/models.cjs");
const voiceprint = require("../../electron/voiceprint.cjs");
const github = require("../../electron/github-sync.cjs");

const SYNC = "SYNC:";
const ASYNC = "ASYNC:";
const b64 = (text: string) => Buffer.from(text).toString("base64");
const unb64 = (text: string) => Buffer.from(text, "base64").toString();

/** What the old `encryptString` produced, as the mock understands it. */
const legacyEncrypt = (text: string) => Buffer.from(SYNC + b64(text));

type Mock = ReturnType<typeof makeStore>;
function makeStore(opts: { available?: boolean; rotate?: boolean } = {}) {
  const state = {
    available: opts.available ?? true,
    rotate: opts.rotate ?? false,
    failDecrypt: false,
    failEncrypt: false,
    hang: "" as "" | "available" | "encrypt" | "decrypt",
    delayMs: 0,
    foreign: new Set<string>(),
    calls: [] as string[],
    generation: 1,
  };
  const wait = () => (state.delayMs ? new Promise((r) => setTimeout(r, state.delayMs)) : null);
  const store = {
    state,
    isAsyncEncryptionAvailable: async () => {
      state.calls.push("available");
      if (state.hang === "available") return new Promise<boolean>(() => {});
      return state.available;
    },
    encryptStringAsync: async (text: string) => {
      state.calls.push("encrypt");
      if (state.hang === "encrypt") return new Promise<Buffer>(() => {});
      await wait();
      if (state.failEncrypt) throw new Error("encrypt failed");
      return Buffer.from(`${ASYNC}g${state.generation}:${b64(text)}`);
    },
    decryptStringAsync: async (buffer: Buffer) => {
      state.calls.push("decrypt");
      if (state.hang === "decrypt") return new Promise<never>(() => {});
      await wait();
      if (state.failDecrypt) throw new Error("decrypt failed");
      const raw = buffer.toString();
      if (state.foreign.has(raw)) throw new Error("another machine");
      if (raw.startsWith(SYNC)) {
        return { result: unb64(raw.slice(SYNC.length)), shouldReEncrypt: state.rotate };
      }
      if (raw.startsWith(ASYNC)) {
        const [, gen = "0", body = ""] = /^ASYNC:g(\d+):(.*)$/.exec(raw) || [];
        const stale = Number(gen) < state.generation;
        return { result: unb64(body), shouldReEncrypt: stale || state.rotate };
      }
      throw new Error("not ciphertext");
    },
  };
  return store;
}

let root = "";
let store: Mock;

const credFile = () => path.join(root, "security", "credentials", "secrets.json");
const keyFile = () => path.join(root, "config", "provider-keys.json");
const writeJson = (file: string, value: unknown) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
const readJson = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const fileText = (file: string) => fs.readFileSync(file, "utf8");
const leftovers = (file: string) =>
  fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"));

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "friday-secretbox-"));
  store = makeStore();
  secretBox.useForTests(store);
  secretBox.setCallLimitForTests(60);
  process.env["FRIDAY_ROOT"] = root;
});

afterEach(() => {
  vi.restoreAllMocks();
  secretBox.setCallLimitForTests(0);
  secretBox.useForTests(null);
  delete process.env["FRIDAY_ROOT"];
  fs.rmSync(root, { recursive: true, force: true });
});

describe("ciphertext written by the old synchronous API", () => {
  it("opens with decryptStringAsync and needs no re-save (credentials, provider keys)", async () => {
    writeJson(credFile(), {
      "connector.github.token": { enc: legacyEncrypt("synthetic-token-1").toString("base64") },
    });
    writeJson(keyFile(), { groq: { enc: legacyEncrypt("synthetic-key-2").toString("base64") } });
    const before = [fileText(credFile()), fileText(keyFile())];

    await credentials.prime(root);
    await models.primeKeys(root);

    expect(credentials.getSecret(root, "connector.github.token")).toBe("synthetic-token-1");
    expect(models.readKeys(root).groq).toBe("synthetic-key-2");
    // Same location, same format, untouched: nothing was written just to read.
    expect([fileText(credFile()), fileText(keyFile())]).toEqual(before);
    expect(store.state.calls).toContain("decrypt");
  });

  it("keeps a plain string written before encryption existed readable, without the OS", () => {
    secretBox.useForTests(null);
    writeJson(credFile(), { old: "written-before-encryption" });
    expect(credentials.getSecret(root, "old")).toBe("written-before-encryption");
  });
});

describe("asynchronous encryption and decryption", () => {
  it("encrypts a new secret asynchronously, in the same file and format, never as plain text", async () => {
    const saved = await credentials.setSecret(root, "speech.sarvam", "synthetic-sarvam-key");
    expect(saved).toEqual({ ok: true, stored: true, encrypted: true });
    const raw = readJson(credFile());
    expect(Object.keys(raw["speech.sarvam"])).toEqual(["enc"]);
    expect(fileText(credFile())).not.toContain("synthetic-sarvam-key");
    expect(
      unb64(Buffer.from(raw["speech.sarvam"].enc, "base64").toString().split(":")[2] ?? ""),
    ).toBe("synthetic-sarvam-key");
    expect(credentials.getSecret(root, "speech.sarvam")).toBe("synthetic-sarvam-key");
    expect(credentials.hasSecret(root, "speech.sarvam")).toBe(true);
    expect(store.state.calls).not.toContain("sync");
  });

  it("opens stored secrets after a restart (a fresh process only knows the file)", async () => {
    await models.writeKey(root, "openrouter", "synthetic-or-key");
    secretBox.useForTests(store); // what a new process starts with: nothing opened
    expect(models.readKeys(root).openrouter).toBeUndefined();
    const primed = await models.primeKeys(root);
    expect(primed).toMatchObject({ ok: true, opened: 1, failed: 0 });
    expect(models.readKeys(root).openrouter).toBe("synthetic-or-key");
  });

  it("deletes a secret when the value is empty and leaves the others", async () => {
    await credentials.setSecret(root, "a", "one");
    await credentials.setSecret(root, "b", "two");
    await credentials.setSecret(root, "a", "");
    expect(credentials.getSecret(root, "a")).toBe("");
    expect(credentials.getSecret(root, "b")).toBe("two");
    expect(Object.keys(readJson(credFile()))).toEqual(["b"]);
  });
});

describe("missing credentials and a root that is not chosen yet", () => {
  it("reads as empty and never throws", async () => {
    expect(credentials.getSecret(root, "nothing")).toBe("");
    expect(credentials.getSecret("", "nothing")).toBe("");
    expect(models.readKeys("")).toEqual({});
    expect(await credentials.prime(root)).toMatchObject({ ok: true, opened: 0 });
    expect((await credentials.setSecret("", "x", "y")).ok).toBe(false);
    expect((await models.writeKey(null, "groq", "k")).ok).toBe(false);
  });
});

describe("encryption unavailable", () => {
  it("refuses to save when the owner turned on Refuse unencrypted, and writes nothing", async () => {
    store.state.available = false;
    writeJson(path.join(root, "config", "friday-preferences.json"), {
      toggles: { encryption: true },
    });
    const saved = await credentials.setSecret(root, "k", "synthetic");
    expect(saved.ok).toBe(false);
    expect(saved.error).toMatch(/refuses to save/);
    expect(fs.existsSync(credFile())).toBe(false);
    const key = await models.writeKey(root, "groq", "synthetic");
    expect(key).toMatchObject({ ok: false, stored: false });
    expect(fs.existsSync(keyFile())).toBe(false);
  });

  it("refuses a packaged app that cannot encrypt: never plain text in production", async () => {
    store.state.available = false;
    const lazy = require("../../electron/lazy-electron.cjs");
    vi.spyOn(lazy, "electron").mockReturnValue({ app: { isPackaged: true } });
    const saved = await credentials.setSecret(root, "k", "synthetic");
    expect(saved.ok).toBe(false);
    expect(fs.existsSync(credFile())).toBe(false);
    expect(credentials.storageStatus()).toMatchObject({ production: true, usable: false });
  });

  it("an unpackaged developer build without the toggle still reports encrypted:false instead of hiding it", async () => {
    store.state.available = false;
    const saved = await credentials.setSecret(root, "k", "dev-only-synthetic");
    expect(saved).toEqual({ ok: true, stored: true, encrypted: false });
  });

  it("the voiceprint is refused without the safe store and nothing is written", async () => {
    store.state.available = false;
    const result = await voiceprint.save([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(root, "voiceprint.json"))).toBe(false);
  });

  it("available() is false, never an exception, when the API throws or is missing", async () => {
    secretBox.useForTests({
      isAsyncEncryptionAvailable: async () => {
        throw new Error("boom");
      },
    });
    expect(await secretBox.available()).toBe(false);
    secretBox.useForTests(null);
    expect(await secretBox.available()).toBe(false);
    expect(credentials.encryptionAvailable()).toBe(false);
  });
});

describe("decryption failure", () => {
  it("leaves the stored secret in the file, reads empty, and keeps it when another id is saved", async () => {
    const foreign = Buffer.from("ASYNC:g1:" + b64("other-machine-secret"));
    store.state.foreign.add(foreign.toString());
    writeJson(credFile(), { alien: { enc: foreign.toString("base64") } });

    const primed = await credentials.prime(root);
    expect(primed).toMatchObject({ ok: true, opened: 0, failed: 1 });
    expect(credentials.getSecret(root, "alien")).toBe("");

    await credentials.setSecret(root, "mine", "synthetic-mine");
    const raw = readJson(credFile());
    expect(raw.alien.enc).toBe(foreign.toString("base64"));
    expect(credentials.getSecret(root, "mine")).toBe("synthetic-mine");
  });

  it("a decrypt that throws is a failure, not a crash, and is not retried in a loop", async () => {
    writeJson(credFile(), { x: { enc: legacyEncrypt("v").toString("base64") } });
    store.state.failDecrypt = true;
    await credentials.prime(root);
    const calls = store.state.calls.filter((c) => c === "decrypt").length;
    expect(credentials.getSecret(root, "x")).toBe("");
    expect(credentials.getSecret(root, "x")).toBe("");
    await new Promise((r) => setTimeout(r, 10));
    expect(store.state.calls.filter((c) => c === "decrypt").length).toBe(calls);
  });

  it("a bad ciphertext string is an unreadable entry, not an exception", async () => {
    writeJson(credFile(), { x: { enc: "!!!not-base64-ciphertext!!!" }, y: { enc: 42 } });
    await expect(credentials.prime(root)).resolves.toMatchObject({ ok: true });
    expect(credentials.getSecret(root, "x")).toBe("");
  });
});

describe("key rotation (shouldReEncrypt)", () => {
  it("re-encrypts a rotated secret once, in place, keeping the same clear text", async () => {
    store.state.rotate = true;
    writeJson(credFile(), { t: { enc: legacyEncrypt("synthetic-rotating").toString("base64") } });
    const old = readJson(credFile()).t.enc;

    await credentials.prime(root);

    const now = readJson(credFile()).t.enc;
    expect(now).not.toBe(old);
    expect(Buffer.from(now, "base64").toString().startsWith(ASYNC)).toBe(true);
    expect(credentials.getSecret(root, "t")).toBe("synthetic-rotating");
    expect(fileText(credFile())).not.toContain("synthetic-rotating");
    // The contract says to call decryptStringAsync again after shouldReEncrypt: it did.
    expect(store.state.calls.filter((c) => c === "decrypt").length).toBeGreaterThanOrEqual(2);
  });

  it("an old key generation is flagged and re-encrypted to the new one", async () => {
    await credentials.setSecret(root, "t", "synthetic-gen");
    store.state.generation = 2; // the OS key rotated
    secretBox.useForTests(store);
    await credentials.prime(root);
    expect(Buffer.from(readJson(credFile()).t.enc, "base64").toString()).toMatch(/^ASYNC:g2:/);
    expect(credentials.getSecret(root, "t")).toBe("synthetic-gen");
  });

  it("if re-encryption fails the old ciphertext stays and still opens", async () => {
    store.state.rotate = true;
    writeJson(credFile(), { t: { enc: legacyEncrypt("synthetic-keep").toString("base64") } });
    const old = readJson(credFile()).t.enc;
    store.state.failEncrypt = true;
    await credentials.prime(root);
    expect(readJson(credFile()).t.enc).toBe(old);
    expect(credentials.getSecret(root, "t")).toBe("synthetic-keep");
  });

  it("does not rewrite an entry that changed while the rotation was running", async () => {
    store.state.rotate = true;
    writeJson(credFile(), { t: { enc: legacyEncrypt("old-value").toString("base64") } });
    const first = credentials.prime(root);
    // the owner saves a new value while the old one is being re-encrypted
    const second = credentials.setSecret(root, "t", "new-value");
    await Promise.all([first, second]);
    await secretBox.settled(credFile());
    expect(credentials.getSecret(root, "t")).toBe("new-value");
  });
});

describe("a keystore call that never answers", () => {
  it("a hung encryption fails that save in a bounded time and the next save still works", async () => {
    store.state.hang = "encrypt";
    const started = Date.now();
    const saved = await credentials.setSecret(root, "stuck", "synthetic-stuck");
    expect(saved.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(fs.existsSync(credFile())).toBe(false);

    store.state.hang = "";
    const next = await credentials.setSecret(root, "after", "synthetic-after");
    expect(next.ok).toBe(true);
    expect(credentials.getSecret(root, "after")).toBe("synthetic-after");
  });

  it("a hung availability check reads as unavailable, never an exception or a stuck promise", async () => {
    store.state.hang = "available";
    expect(await secretBox.available()).toBe(false);
    writeJson(path.join(root, "config", "friday-preferences.json"), {
      toggles: { encryption: true },
    });
    const refused = await credentials.setSecret(root, "k", "synthetic");
    expect(refused.ok).toBe(false);
    expect(fs.existsSync(credFile())).toBe(false);
  });

  it("a hung decryption is not remembered as an unreadable secret: it opens once the keystore answers", async () => {
    writeJson(credFile(), { t: { enc: legacyEncrypt("synthetic-late").toString("base64") } });
    store.state.hang = "decrypt";
    const first = await credentials.prime(root);
    expect(first).toMatchObject({ ok: true, opened: 0, failed: 1 });
    expect(credentials.getSecret(root, "t")).toBe("");

    store.state.hang = "";
    const second = await credentials.prime(root);
    expect(second).toMatchObject({ opened: 1, failed: 0 });
    expect(credentials.getSecret(root, "t")).toBe("synthetic-late");
  });
});

describe("application startup before storage is ready", () => {
  it("before the app is ready nothing is opened, nothing throws, and nothing is saved as plain text", async () => {
    secretBox.useForTests(null); // lazy-electron answers null until app.isReady()
    writeJson(credFile(), { x: { enc: legacyEncrypt("later").toString("base64") } });
    expect(await secretBox.available()).toBe(false);
    expect(credentials.getSecret(root, "x")).toBe("");
    expect(await credentials.prime(root)).toMatchObject({ ok: false, reason: "unavailable" });

    writeJson(path.join(root, "config", "friday-preferences.json"), {
      toggles: { encryption: true },
    });
    const refused = await credentials.setSecret(root, "new", "synthetic");
    expect(refused.ok).toBe(false);
    expect(readJson(credFile())).not.toHaveProperty("new");
  });

  it("once ready, priming opens everything that was waiting", async () => {
    secretBox.useForTests(null);
    writeJson(credFile(), { x: { enc: legacyEncrypt("later").toString("base64") } });
    expect(credentials.getSecret(root, "x")).toBe("");
    secretBox.useForTests(store);
    await credentials.prime(root);
    expect(credentials.getSecret(root, "x")).toBe("later");
  });

  it("main.cjs primes after ready, bounded, and never reads safeStorage at load", () => {
    const main = fs.readFileSync(path.join(process.cwd(), "electron/main.cjs"), "utf8");
    expect(main).toContain("async function primeSecretStores");
    expect(main).toMatch(/await primeSecretStores\(\);/);
    expect(main).toMatch(/await primeSecretStores\(resolvedRoot\)/);
    expect(main).toMatch(/setTimeout\(resolve, 5000\)/);
    expect(fs.readFileSync(path.join(process.cwd(), "electron/secret-box.cjs"), "utf8")).toContain(
      'lazy.afterReady("safeStorage")',
    );
  });
});

describe("concurrent operations", () => {
  it("twenty simultaneous writes to different ids all survive", async () => {
    store.state.delayMs = 2;
    const ids = Array.from({ length: 20 }, (_, i) => `id-${i}`);
    const results = await Promise.all(ids.map((id) => credentials.setSecret(root, id, `v-${id}`)));
    expect(results.every((r: { ok: boolean }) => r.ok)).toBe(true);
    const raw = readJson(credFile());
    expect(Object.keys(raw).sort()).toEqual([...ids].sort());
    for (const id of ids) expect(credentials.getSecret(root, id)).toBe(`v-${id}`);
    expect(leftovers(credFile())).toEqual([]);
  });

  it("writes to the same id apply in call order, so the last one wins", async () => {
    store.state.delayMs = 3;
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => credentials.setSecret(root, "same", `value-${n}`)),
    );
    expect(credentials.getSecret(root, "same")).toBe("value-5");
  });

  it("a provider key write and a credential write do not disturb each other", async () => {
    await Promise.all([
      models.writeKey(root, "groq", "synthetic-groq"),
      credentials.setSecret(root, "connector.x", "synthetic-x"),
      models.writeKey(root, "gemini", "synthetic-gemini"),
    ]);
    expect(Object.keys(readJson(keyFile())).sort()).toEqual(["gemini", "groq"]);
    expect(Object.keys(readJson(credFile()))).toEqual(["connector.x"]);
  });
});

describe("persistence failure", () => {
  it("a failed write reports an error, leaves the old file whole, and removes its temp file", async () => {
    await credentials.setSecret(root, "keep", "synthetic-keep");
    const before = fileText(credFile());
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    const saved = await credentials.setSecret(root, "new", "synthetic-new");
    rename.mockRestore();
    expect(saved).toMatchObject({ ok: false });
    expect(saved.error).toMatch(/could not be written/);
    expect(fileText(credFile())).toBe(before);
    expect(leftovers(credFile())).toEqual([]);
    expect(credentials.getSecret(root, "keep")).toBe("synthetic-keep");
  });

  it("a failed encryption stores nothing and keeps the previous value", async () => {
    await credentials.setSecret(root, "t", "synthetic-before");
    const before = fileText(credFile());
    store.state.failEncrypt = true;
    const saved = await credentials.setSecret(root, "t", "synthetic-after");
    expect(saved.ok).toBe(false);
    expect(fileText(credFile())).toBe(before);
    expect(credentials.getSecret(root, "t")).toBe("synthetic-before");
  });

  it("an unreadable credential file is never overwritten with a smaller one", async () => {
    fs.mkdirSync(path.dirname(credFile()), { recursive: true });
    fs.writeFileSync(credFile(), "{ this is not json");
    const saved = await credentials.setSecret(root, "t", "synthetic");
    expect(saved.ok).toBe(false);
    expect(fileText(credFile())).toBe("{ this is not json");
  });

  it("the encrypted value is available to readers only after the write succeeded", async () => {
    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("disk full");
    });
    await credentials.setSecret(root, "t", "synthetic");
    expect(credentials.getSecret(root, "t")).toBe("");
  });
});

describe("callers that existed before the change", () => {
  it("the GitHub token round-trips through writeConfig and readConfig, never into github.json", async () => {
    const saved = await github.writeConfig(root, {
      repo: "owner/name",
      token: "ghp_synthetic",
      updateToken: "ghp_readonly",
    });
    expect(saved.ok).toBe(true);
    expect(saved.config).toMatchObject({ hasToken: true, hasUpdateToken: true });
    expect(saved.config).not.toHaveProperty("token");
    const config = github.readConfig(root);
    expect(config).toMatchObject({ token: "ghp_synthetic", updateToken: "ghp_readonly" });
    const stored = fileText(path.join(root, "config", "github.json"));
    expect(stored).not.toContain("ghp_synthetic");
    expect(stored).not.toContain("ghp_readonly");
  });

  it("a failed token save is reported and the config is not half-written", async () => {
    store.state.failEncrypt = true;
    const saved = await github.writeConfig(root, { repo: "owner/name", token: "ghp_synthetic" });
    expect(saved.ok).toBe(false);
    expect(fs.existsSync(path.join(root, "config", "github.json"))).toBe(false);
  });

  it("a historical github.json token is erased only after the encrypted store accepted it", async () => {
    writeJson(path.join(root, "config", "github.json"), {
      repo: "owner/name",
      token: "ghp_legacy",
    });
    store.state.failEncrypt = true;
    expect(github.readConfig(root).token).toBe("ghp_legacy");
    await github.whenAdopted(root);
    expect(readJson(path.join(root, "config", "github.json")).token).toBe("ghp_legacy");

    store.state.failEncrypt = false;
    github.readConfig(root);
    await github.whenAdopted(root);
    expect(readJson(path.join(root, "config", "github.json")).token).toBeUndefined();
    expect(credentials.getSecret(root, "github.token")).toBe("ghp_legacy");
  });

  it("removing a Hub connection removes its token", async () => {
    await credentials.setSecret(root, github.connectionTokenId("repo_x"), "ghp_linked");
    await github.removeConnection(root, "repo_x");
    expect(credentials.getSecret(root, github.connectionTokenId("repo_x"))).toBe("");
  });

  it("every production call site that stores a secret awaits it", () => {
    const read = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    for (const rel of [
      "electron/main.cjs",
      "electron/connectors.cjs",
      "electron/github-sync.cjs",
    ]) {
      const unawaited = read(rel)
        .split("\n")
        .filter((line) => /\.(setSecret|writeKey)\(/.test(line) && !/await /.test(line))
        // multi-line calls put `await` on the line before the open parenthesis
        .filter((line) => !/^\s*(const|let)?\s*\w*\s*=?\s*$/.test(line));
      expect(unawaited, rel).toEqual([]);
    }
    const main = read("electron/main.cjs");
    expect(main).toContain("await modelsApi.writeKey(");
    expect(main).toContain('await require("./credentials.cjs").setSecret(');
    expect(main).toContain("await githubSync.writeConfig(");
    expect(main).toContain("await connectors.disconnect(");
  });
});

describe("voiceprint and voice profile storage", () => {
  const vector = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8];
  const file = () => path.join(root, "voiceprint.json");

  it("a voiceprint saved by the old synchronous API loads with decryptStringAsync", async () => {
    fs.writeFileSync(
      file(),
      JSON.stringify({ enc: legacyEncrypt(JSON.stringify(vector)).toString("base64") }),
    );
    expect(await voiceprint.load()).toEqual(vector);
    expect(voiceprint.status().enrolled).toBe(true);
  });

  it("saves the same { enc } file shape, encrypted, and reads it back", async () => {
    expect(await voiceprint.save(vector)).toEqual({ ok: true, enrolled: true });
    const raw = readJson(file());
    expect(Object.keys(raw)).toEqual(["enc"]);
    expect(fileText(file())).not.toContain("0.1");
    expect(await voiceprint.load()).toEqual(vector);
    expect((await voiceprint.enrol(vector)).ok).toBe(true);
  });

  it("a failed save keeps the earlier voiceprint file", async () => {
    await voiceprint.save(vector);
    const before = fileText(file());
    store.state.failEncrypt = true;
    expect((await voiceprint.save([...vector].reverse())).ok).toBe(false);
    expect(fileText(file())).toBe(before);
    expect(leftovers(file())).toEqual([]);
  });

  it("refuses a short or non-numeric embedding, and forget removes the file", async () => {
    expect((await voiceprint.save([1, 2])).ok).toBe(false);
    expect((await voiceprint.save(["a", 2, 3, 4, 5, 6, 7, 8])).ok).toBe(false);
    await voiceprint.save(vector);
    expect(voiceprint.forget().enrolled).toBe(false);
    expect(fs.existsSync(file())).toBe(false);
    expect(await voiceprint.load()).toBeNull();
  });

  it("an embedding this PC cannot open loads as null, not as an error", async () => {
    store.state.failDecrypt = true;
    fs.writeFileSync(file(), JSON.stringify({ enc: legacyEncrypt("[1]").toString("base64") }));
    expect(await voiceprint.load()).toBeNull();
  });
});

describe("no synchronous safeStorage method is left in production code", () => {
  it("electron/, src/ and scripts/ never call the removed methods", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "node_modules") walk(full);
        } else if (/\.(cjs|mjs|js|ts|tsx)$/.test(entry.name)) {
          const text = fs.readFileSync(full, "utf8");
          if (/\.(encryptString|decryptString|isEncryptionAvailable)\(/.test(text)) {
            offenders.push(path.relative(process.cwd(), full));
          }
        }
      }
    };
    for (const dir of ["electron", "src", "scripts"]) walk(path.join(process.cwd(), dir));
    expect(offenders).toEqual([]);
  });

  it("only secret-box.cjs reads the safeStorage export", () => {
    const users: string[] = [];
    for (const name of fs.readdirSync(path.join(process.cwd(), "electron"))) {
      if (!name.endsWith(".cjs")) continue;
      const text = fs.readFileSync(path.join(process.cwd(), "electron", name), "utf8");
      if (/afterReady\("safeStorage"\)/.test(text)) users.push(name);
    }
    expect(users).toEqual(["secret-box.cjs"]);
  });

  it("a secret never reaches the renderer: no preload getter returns a stored value", () => {
    const preload = fs.readFileSync(path.join(process.cwd(), "electron/preload.cjs"), "utf8");
    expect(preload).not.toMatch(/getSecret|readKeys|decrypt/i);
  });
});
