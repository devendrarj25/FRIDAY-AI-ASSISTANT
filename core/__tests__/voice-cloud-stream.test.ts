/**
 * The Sarvam streaming speech path is classified in the main process, one clause at a time, with the shared privacy
 * firewall, before a clause reaches the socket; the renderer's own check is not trusted. Privacy mode is re-read on
 * each clause. Fake streams and fake preferences stand in for the network and the PC.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const req = createRequire(import.meta.url);
const cloud = req("../../electron/voice-cloud.cjs") as {
  createVoiceCloud: (deps: Record<string, unknown>) => any;
  guardedStreamSend: (api: any, streams: { send: (id: string, m: any) => any }) => any;
};

const prefs = (over: Record<string, unknown> = {}, top: Record<string, unknown> = {}) => ({
  privacyMode: false,
  cloudVoice: { cloudEnabled: true, allowedProviders: ["sarvam"], ...over },
  ...top,
});

function rig(state: { value: any } = { value: prefs() }) {
  const sent: { id: string; message: any }[] = [];
  const streams = {
    send: (id: string, message: any) => {
      sent.push({ id, message });
      return { ok: true };
    },
  };
  const api = cloud.createVoiceCloud({
    fetchImpl: async () => new Response("{}"),
    getSecret: () => "sk-sarvam-SECRET",
    prefs: () => state.value,
  });
  return { send: cloud.guardedStreamSend(api, streams), sent, state };
}

describe("streaming speech: every clause is classified in the main process", () => {
  it("refuses a sensitive English clause, a Hindi clause and a Hinglish clause before the socket", () => {
    const { send, sent } = rig();
    for (const text of [
      "my password is hunter2",
      "card 4111 1111 1111 1111 expires soon",
      "मेरा पासवर्ड 1234 है",
      "mera password hunter2 hai",
    ]) {
      const out = send("s1", { type: "text", text });
      expect(out).toMatchObject({ ok: false, sensitive: true });
      expect(String(out.error)).toMatch(/sensitive/i);
    }
    expect(sent).toEqual([]);
  });

  it("refuses a harmless clause when the renderer says the whole reply is sensitive, never the reverse", () => {
    const { send, sent } = rig();
    expect(
      send("s1", { type: "text", text: "The number is on the next line.", sensitiveReply: true }),
    ).toMatchObject({ ok: false, sensitive: true });
    expect(sent).toEqual([]);
    expect(
      send("s1", { type: "text", text: "my password is x", sensitiveReply: false }),
    ).toMatchObject({ ok: false, sensitive: true });
    expect(sent).toEqual([]);
  });

  it("passes a harmless clause and the non-text frames through unchanged", () => {
    const { send, sent } = rig();
    expect(send("s1", { type: "text", text: "The weather is fine today." })).toEqual({ ok: true });
    expect(send("s1", { type: "flush" })).toEqual({ ok: true });
    expect(send("s1", { type: "config", language: "hi-IN", pace: 1.1 })).toEqual({ ok: true });
    expect(sent.map((s) => s.message.type)).toEqual(["text", "flush", "config"]);
    expect(sent[0]?.message).toEqual({ type: "text", text: "The weather is fine today." });
  });

  it("refuses a clause once privacy mode, cloud voice or the allow list is switched off mid-stream", () => {
    const state = { value: prefs() };
    const { send, sent } = rig(state);
    expect(send("s1", { type: "text", text: "hello there" }).ok).toBe(true);
    state.value = prefs({}, { privacyMode: true });
    const privacy = send("s1", { type: "text", text: "hello there" });
    expect(privacy.ok).toBe(false);
    expect(String(privacy.error)).toMatch(/on this PC/i);
    state.value = prefs({ cloudEnabled: false });
    expect(send("s1", { type: "text", text: "hello there" }).ok).toBe(false);
    state.value = prefs({ allowedProviders: [] });
    expect(send("s1", { type: "text", text: "hello there" }).ok).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it("refuses when the preferences cannot be read", () => {
    const { send, sent } = rig({
      get value() {
        throw new Error("unreadable");
      },
    } as any);
    expect(send("s1", { type: "text", text: "hello there" }).ok).toBe(false);
    expect(sent).toEqual([]);
  });

  it("does not hand the key or the socket to the screening, and ignores a malformed message", () => {
    const { send, sent } = rig();
    expect(send("s1", undefined).ok).toBe(true);
    expect(send("s1", { type: "text" }).ok).toBe(true);
    expect(sent).toHaveLength(2);
  });
});

describe("the main process wires the guard and keeps the cloud lane off by default", () => {
  const main = fs.readFileSync(
    path.resolve(import.meta.dirname, "../../electron/main.cjs"),
    "utf8",
  );
  it("registers voice-stream:send through the guarded sender, never the raw stream", () => {
    expect(main).toMatch(
      /const sendStream = voiceCloud\.guardedStreamSend\(voiceCloudApi, sarvamStreams\);/,
    );
    expect(main).toMatch(
      /ipcMain\.handle\("voice-stream:send", \(_e, id, message\) =>\s*sendStream\(String\(id \|\| ""\), message\),?\s*\);/,
    );
    expect(main).not.toMatch(/sarvamStreams\.send\(String\(id/);
  });
  it("leaves cloud voice off until the owner switches it on", () => {
    const { send } = rig({ value: { cloudVoice: {} } });
    expect(send("s1", { type: "text", text: "hello there" }).ok).toBe(false);
    expect(send("s1", { type: "text", text: "hello there" }).error).toMatch(/switched off/i);
  });
});

describe("privacy mode refuses cloud speech end to end through the main handlers", () => {
  it("speak and the stream both refuse with the same reason and make no request", async () => {
    let fetched = 0;
    const api = cloud.createVoiceCloud({
      fetchImpl: async () => {
        fetched += 1;
        return new Response("{}");
      },
      getSecret: () => "sk-sarvam-SECRET",
      prefs: () => prefs({}, { privacyMode: true }),
    });
    const sent: unknown[] = [];
    const send = cloud.guardedStreamSend(api, {
      send: (_id: string, m: unknown) => {
        sent.push(m);
        return { ok: true };
      },
    });
    const spoken = await api.speak("sarvam", { text: "hello there", language: "en-IN" });
    const streamed = send("s1", { type: "text", text: "hello there" });
    expect(spoken).toMatchObject({ ok: false });
    expect(streamed).toMatchObject({ ok: false });
    expect(spoken.error).toBe(streamed.error);
    expect(fetched).toBe(0);
    expect(sent).toEqual([]);
  });
});
