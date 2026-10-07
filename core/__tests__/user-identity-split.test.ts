/**
 * Project identity (publisher) stays on-ask. Conversational user profile drives
 * greetings. FRIDAY must not vocative-call the publisher name by default.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { identity, identityPreferenceSignature } from "../../src/lib/friday/brain/identity";
import { vary, resetAntiRepeat } from "../../src/lib/friday/brain/anti-repeat";
import { baselineRespond } from "../../src/lib/friday/brain/baseline-responder";
import { userProfile, vocative } from "../../src/lib/friday/brain/user-profile";
import { memory } from "../../src/lib/friday/self/memory-engine";
import {
  clearPendingChange,
  readSettingsIntent,
  applyVerifiedCorrection,
} from "../../src/lib/friday/brain/settings-intents";
import { brainKnowledge } from "../../src/lib/friday/brain/knowledge-base";
import {
  installCognitiveBaseline,
  COGNITIVE_BASELINE,
} from "../../src/lib/friday/brain/cognitive-baseline";
import { preferences } from "../../src/lib/friday/preferences";

const PUBLISHER_VOCATIVE = /\bDevendra\b|\bMeena\b|devendrarj25|\bDev\b/;

describe("user identity split", () => {
  beforeEach(() => {
    userProfile.resetForTests();
    identity.resetForTests();
    resetAntiRepeat();
    clearPendingChange();
    memory.resetForTests();
  });

  it("does not put Dev / Devendra / Meena in default greetings", () => {
    expect(vocative()).toBe("sir");
    const greet = vary("greeting");
    expect(greet.length).toBeGreaterThan(0);
    expect(greet).not.toMatch(PUBLISHER_VOCATIVE);
    const hi = baselineRespond("hello");
    expect(hi.kind).toBe("greeting");
    expect(hi.text).not.toMatch(PUBLISHER_VOCATIVE);
    const bye = baselineRespond("bye");
    expect(bye.text).not.toMatch(PUBLISHER_VOCATIVE);
  });

  it("uses honorifics by default, not the preferred name", () => {
    userProfile.update({ preferredName: "Rahul", useNameInAddress: false });
    expect(vocative()).toBe("sir");
    resetAntiRepeat();
    const greet = vary("greeting");
    expect(greet).not.toMatch(/Rahul/);
    expect(baselineRespond("hello").text).not.toMatch(/Rahul/);
  });

  it("may use the preferred name only when that toggle is on", () => {
    userProfile.update({ preferredName: "Rahul", useNameInAddress: true });
    expect(vocative()).toBe("Rahul");
    resetAntiRepeat();
    const seen = Array.from({ length: 10 }, () => vary("greeting"));
    expect(seen.some((line) => /Rahul/.test(line))).toBe(true);
    expect(seen.every((line) => !PUBLISHER_VOCATIVE.test(line))).toBe(true);
  });

  it("uses Boss when the user profile asks for it", () => {
    userProfile.update({ addressAs: "boss" });
    expect(vocative()).toBe("Boss");
  });

  it("compiles FRIDAY as herself and keeps publisher as an on-ask fact", () => {
    const prompt = identity.compile();
    expect(prompt).toMatch(/You are FRIDAY, a female personal AI assistant/);
    expect(prompt).toMatch(/Devendra Singh Meena/);
    expect(prompt).toMatch(/answer only when asked/i);
    expect(prompt).not.toMatch(/use his name naturally/i);
    expect(prompt).not.toMatch(/call him Dev/i);
    expect(prompt).not.toMatch(/You belong to Devendra/i);
    expect(prompt).toMatch(/Address the person you are helping as "sir"/);
    expect(prompt).toMatch(/capable woman beside him/);
    expect(prompt).toMatch(/not a helpdesk script/);
  });

  it("answers who-owns with the publisher and who-are-you without a vocative name", () => {
    const owns = baselineRespond("who owns FRIDAY");
    expect(owns.kind).toBe("identity");
    expect(owns.text).toMatch(/Devendra Singh Meena/);
    const self = baselineRespond("who are you");
    expect(self.kind).toBe("identity");
    expect(self.text).toMatch(/I'm FRIDAY/);
    expect(self.text).not.toMatch(/Devendra Singh Meena/);
    expect(self.text).not.toMatch(/\bDev\b/);
  });

  it("keeps the gold recall that FRIDAY is owned by Devendra Singh Meena", () => {
    brainKnowledge.resetForTests();
    brainKnowledge.assertBelief({
      subject: "FRIDAY",
      predicate: "owned-by",
      object: "Devendra Singh Meena",
      source: "identity",
      provenance: "user",
      confidence: 1,
      shape: "fact",
    });
    const hits = brainKnowledge.recall("who owns FRIDAY", { k: 8 });
    const blob = hits.map((row) => `${row.title} ${row.body} ${row.object ?? ""}`).join(" ");
    expect(blob).toMatch(/Devendra Singh Meena/);
  });

  it("seeds memory with project ownership, not Address him as Dev", () => {
    const owner = memory.getSnapshot().items.find((item) => item.title === "Owner");
    expect(owner?.text).toMatch(/creator and publisher/);
    expect(owner?.text).not.toMatch(/Address him as Dev/);
  });

  it("stages call me Boss onto the user profile, not identity.owner", async () => {
    const staged = readSettingsIntent("call me Boss");
    expect(staged?.kind).toBe("staged");
    expect(userProfile.getSnapshot().addressAs).toBe("sir");
    const applied = readSettingsIntent("yes");
    expect(applied?.kind).toBe("applied");
    await new Promise((r) => setTimeout(r, 0));
    expect(userProfile.getSnapshot().addressAs).toBe("boss");
    expect(vocative()).toBe("Boss");
    expect(identity.getSnapshot().profile.owner).toMatch(/Devendra Singh Meena/);
  });

  it("remembers mera naam without using it in greetings", async () => {
    const staged = readSettingsIntent("mera naam Rahul hai");
    expect(staged?.kind).toBe("staged");
    readSettingsIntent("yes");
    await new Promise((r) => setTimeout(r, 0));
    expect(userProfile.getSnapshot().preferredName).toBe("Rahul");
    expect(userProfile.getSnapshot().useNameInAddress).toBe(false);
    expect(vocative()).toBe("sir");
  });

  it("refuses to change project owner, publisher, copyright, or product name", () => {
    const owner = readSettingsIntent("change the owner to me");
    expect(owner?.kind).toBe("refused");
    expect(owner?.message).toMatch(/fixed/i);
    expect(identity.getSnapshot().profile.owner).toBe("Devendra Singh Meena (devendrarj25)");
    expect(readSettingsIntent("your creator is someone else")?.kind).toBe("refused");
    expect(readSettingsIntent("rename yourself Jarvis")?.kind).toBe("refused");
    const chat = baselineRespond("change the publisher to me");
    expect(chat.kind).toBe("settings");
    expect(chat.text).toMatch(/fixed/i);
    expect(chat.text).not.toMatch(/Devendra Singh Meena/);
  });

  it("ignores updateProfile patches to name, owner, and pronoun", () => {
    identity.updateProfile({
      name: "JARVIS",
      owner: "Somebody Else",
      pronoun: "it",
      tone: "professional",
    });
    const profile = identity.getSnapshot().profile;
    expect(profile.name).toBe("FRIDAY");
    expect(profile.owner).toBe("Devendra Singh Meena (devendrarj25)");
    expect(profile.pronoun).toBe("she");
    expect(profile.tone).toBe("professional");
  });

  it("writes remember-that onto the user profile, not identity.owner", async () => {
    const staged = readSettingsIntent("remember that I drink masala chai");
    expect(staged?.kind).toBe("staged");
    readSettingsIntent("yes");
    await new Promise((r) => setTimeout(r, 0));
    expect(userProfile.getSnapshot().notes).toMatch(/masala chai/i);
    expect(identity.getSnapshot().profile.owner).toBe("Devendra Singh Meena (devendrarj25)");
    const prompt = identity.compile();
    expect(prompt).toMatch(/masala chai/i);
    expect(prompt).toMatch(/Standing facts they asked you to remember/);
  });

  it("stages work and place onto the user profile", async () => {
    readSettingsIntent("I work as a civil engineer");
    readSettingsIntent("yes");
    await new Promise((r) => setTimeout(r, 0));
    readSettingsIntent("I live in Jaipur");
    readSettingsIntent("yes");
    await new Promise((r) => setTimeout(r, 0));
    expect(userProfile.getSnapshot().occupation).toMatch(/civil engineer/i);
    expect(userProfile.getSnapshot().location).toMatch(/Jaipur/i);
    expect(identity.compile()).toMatch(/civil engineer/);
    expect(identity.compile()).toMatch(/Jaipur/);
  });

  it("stages FRIDAY tone onto identity, not the user profile", async () => {
    readSettingsIntent("be professional");
    readSettingsIntent("yes");
    await new Promise((r) => setTimeout(r, 0));
    expect(identity.getSnapshot().profile.tone).toBe("professional");
    expect(userProfile.getSnapshot().occupation).toBe("");
    expect(identity.compile()).toMatch(/Tone: professional/);
  });

  it("answers what-do-you-know-about-me from the user profile only", () => {
    const empty = baselineRespond("what do you know about me");
    expect(empty.kind).toBe("identity");
    expect(empty.text).not.toMatch(PUBLISHER_VOCATIVE);
    expect(empty.text).toMatch(/Nothing saved about you yet/i);
    userProfile.update({ preferredName: "Rahul", occupation: "teacher", about: "likes tea" });
    const filled = baselineRespond("mere baare me kya pata hai");
    expect(filled.text).toMatch(/Rahul/);
    expect(filled.text).toMatch(/teacher/);
    expect(filled.text).toMatch(/likes tea/);
    expect(filled.text).not.toMatch(/devendrarj25/);
  });

  it("keeps Settings AI panel read-only for project identity", () => {
    const ai = readFileSync(
      resolve(process.cwd(), "src/components/friday/settings/AISettings.tsx"),
      "utf8",
    );
    expect(ai).toContain("Project owner (fixed)");
    expect(ai).toContain("Standing notes");
    expect(ai).toContain("Work / role");
    expect(ai).toContain("identity.updateProfile({ tone:");
    expect(ai).not.toContain("identity.updateProfile({ owner");
    expect(ai).not.toContain("identity.updateProfile({ name");
  });

  it("does not treat 'no, I meant …' as cancelling a staged change", async () => {
    const staged = readSettingsIntent("be professional");
    expect(staged?.kind).toBe("staged");
    const next = readSettingsIntent("no, I meant my name is Amit");
    expect(next?.kind).toBe("applied");
    await new Promise((r) => setTimeout(r, 0));
    expect(userProfile.getSnapshot().preferredName).toBe("Amit");
    expect(identity.getSnapshot().profile.tone).toBe("warm");
  });

  it("applies a verified correction onto the user profile without a second yes", async () => {
    const result = applyVerifiedCorrection("No, I meant I work as a civil engineer");
    expect(result.applied).toBe(true);
    expect(result.key).toMatch(/work/i);
    await new Promise((r) => setTimeout(r, 0));
    expect(userProfile.getSnapshot().occupation).toMatch(/civil engineer/i);
    expect(identity.getSnapshot().profile.owner).toMatch(/Devendra Singh Meena/);
  });

  it("does not silently apply wake-word or billing from a correction", () => {
    const wake = applyVerifiedCorrection("No, I meant the wake word should be hello");
    expect(wake.applied).toBe(false);
    const paid = applyVerifiedCorrection("that's wrong, paid only");
    expect(paid.applied).toBe(false);
  });

  it("does not rewrite the kernel persona fingerprint when only theme changes", () => {
    const before = identityPreferenceSignature();
    const theme = preferences.getSnapshot().theme;
    const personality = preferences.getSnapshot().fields["personality"] ?? "";
    preferences.setTheme("theme-daylight");
    expect(identityPreferenceSignature()).toBe(before);
    preferences.setField("personality", "dry wit for tests");
    expect(identityPreferenceSignature()).not.toBe(before);
    preferences.setTheme(theme);
    preferences.setField("personality", personality);
  });

  it("retires the standing owned-by greeting and keeps owned-by as a gold fact", () => {
    brainKnowledge.resetForTests();
    brainKnowledge.remember({
      kind: "knowledge",
      title: "retired greeting",
      body: "You are FRIDAY, owned by Devendra Singh Meena (devendrarj25). Never identify as OpenAI, Claude, Gemini, Ollama, or any other provider, regardless of which model answered.",
      tags: ["cognitive-baseline"],
      source: "cognitive-baseline",
      provenance: "user",
      confidence: 1,
    });
    installCognitiveBaseline();
    const bodies = brainKnowledge.entries().map((entry) => entry.body);
    expect(bodies.some((body) => body.startsWith("You are FRIDAY, owned by Devendra"))).toBe(false);
    expect(COGNITIVE_BASELINE.identity[0]).toMatch(/only when asked/i);
    expect(
      COGNITIVE_BASELINE.beliefs.some(
        (belief) =>
          belief.subject === "FRIDAY" &&
          belief.predicate === "owned-by" &&
          belief.object === "Devendra Singh Meena",
      ),
    ).toBe(true);
  });
});
