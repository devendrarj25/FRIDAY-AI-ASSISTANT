import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DELIVERY_TAG_WORDS,
  MAX_PAUSE_MS,
  deliveryTagList,
  isDeliveryTag,
  keepForSpeech,
  maskDeliveryTags,
  stripDeliveryTags,
  tagsForSpeech,
} from "../../src/lib/friday/voice-engine/delivery-tags";
import { prepareSpeechText } from "../../src/lib/friday/voice-engine/speech-prep";
import { prepareForSpeech } from "../../src/lib/friday/voice-engine/text-normalizer";
import { voiceModeBlock } from "../../src/lib/friday/conversation-style";

describe("delivery tags: vocabulary", () => {
  it("is the agreed allow-list", () => {
    expect([...DELIVERY_TAG_WORDS]).toEqual([
      "warm",
      "soft",
      "excited",
      "calm",
      "pause",
      "breath",
      "sigh",
      "laugh-soft",
      "slow",
      "fast",
    ]);
  });
  it("lists the vocabulary for the prompt, with the timed pause", () => {
    const list = deliveryTagList();
    expect(list).toContain("[warm]");
    expect(list).toContain("[laugh-soft]");
    expect(list).toContain("[pause] [pause:ms]");
  });
  it("recognises only canonical tag tokens", () => {
    expect(isDeliveryTag("[warm]")).toBe(true);
    expect(isDeliveryTag("[pause:300]")).toBe(true);
    expect(isDeliveryTag("[Warm]")).toBe(false);
    expect(isDeliveryTag("[giggle]")).toBe(false);
    expect(isDeliveryTag("[warm:5]")).toBe(false);
    expect(isDeliveryTag("warm")).toBe(false);
  });
});

describe("stripDeliveryTags (anything shown on screen)", () => {
  it.each([
    ["Hello [warm] there.", "Hello there."],
    ["[warm] Hello there.", "Hello there."],
    ["Done [pause].", "Done."],
    ["Okay [pause:300] next.", "Okay next."],
    ["Yes [laugh-soft] sure [sigh]", "Yes sure"],
    ["Line one [calm]\nLine two", "Line one\nLine two"],
    ["नमस्ते [soft] आप कैसे हैं।", "नमस्ते आप कैसे हैं।"],
    ["Hi [WARM] there", "Hi there"],
    ["Hi [ warm ] there", "Hi there"],
    ["Hi [pause:abc] there", "Hi there"],
    ["Hi [pause:] there", "Hi there"],
    ["Hi [pause:99999] there", "Hi there"],
  ])("removes tags: %s", (input, expected) => {
    expect(stripDeliveryTags(input)).toBe(expected);
  });
  it("leaves text without tags exactly as it was", () => {
    expect(stripDeliveryTags("Plain line, no cues.")).toBe("Plain line, no cues.");
    expect(stripDeliveryTags("")).toBe("");
  });
  it("leaves other bracket text alone", () => {
    expect(stripDeliveryTags("See [note] and [1] and [link](http://x.y).")).toBe(
      "See [note] and [1] and [link](http://x.y).",
    );
    expect(stripDeliveryTags("a [warm](http://x.y) link")).toBe("a [warm](http://x.y) link");
  });
  it("leaves tags inside code, inline code and URLs", () => {
    expect(stripDeliveryTags("```\nx[warm]\n```")).toBe("```\nx[warm]\n```");
    expect(stripDeliveryTags("use `a [warm] b` now")).toBe("use `a [warm] b` now");
    expect(stripDeliveryTags("open http://h/[soft]/x now")).toBe("open http://h/[soft]/x now");
    expect(stripDeliveryTags("```\n[warm] unclosed")).toBe("```\n[warm] unclosed");
  });
  it("leaves a tag that touches a number", () => {
    expect(stripDeliveryTags("arr[0] and a5[soft]")).toBe("arr[0] and a5[soft]");
    expect(stripDeliveryTags("5[calm]")).toBe("5[calm]");
  });
  it("strips outside code but not inside, in one text", () => {
    expect(stripDeliveryTags("Hi [warm]. Run `a [warm]`.")).toBe("Hi. Run `a [warm]`.");
  });
});

describe("keepForSpeech (the speech path)", () => {
  it("keeps allow-listed tags in canonical form", () => {
    expect(keepForSpeech("Hello [Warm] there.")).toBe("Hello [warm] there.");
    expect(keepForSpeech("Okay [ pause : 300 ] next.")).toBe("Okay [pause:300] next.");
    expect(keepForSpeech("Yes [laugh-soft].")).toBe("Yes [laugh-soft].");
  });
  it("drops unknown and malformed tags", () => {
    expect(keepForSpeech("Hi [giggle] there.")).toBe("Hi there.");
    expect(keepForSpeech("Hi [pause:abc] there.")).toBe("Hi there.");
    expect(keepForSpeech("Hi [warm:3] there.")).toBe("Hi there.");
    expect(keepForSpeech("Hi [pause:0] there.")).toBe("Hi there.");
    expect(keepForSpeech("Hi [pause:12345] there.")).toBe("Hi there.");
  });
  it("clamps a long pause to the ceiling", () => {
    expect(keepForSpeech("Wait [pause:9999] ok.")).toBe("Wait [pause:2000] ok.");
  });
  it("keeps at most one tag per sentence", () => {
    expect(keepForSpeech("Hi [warm] there [soft]. Bye [calm] now [slow].")).toBe(
      "Hi [warm] there. Bye [calm] now.",
    );
  });
  it("leaves code, URLs and numbers alone", () => {
    expect(keepForSpeech("`x [warm]` and http://a/[soft] and a[0]")).toBe(
      "`x [warm]` and http://a/[soft] and a[0]",
    );
  });
  it("keeps non-tag brackets (links, numbers)", () => {
    expect(keepForSpeech("See [1] and [link](http://x.y)")).toBe("See [1] and [link](http://x.y)");
  });
  it("passes plain text through", () => {
    expect(keepForSpeech("No cues here.")).toBe("No cues here.");
  });
  it("clamp constant is the documented ceiling", () => {
    expect(MAX_PAUSE_MS).toBe(2000);
  });
});

describe("tagsForSpeech (who may carry a tag)", () => {
  const line = "Okay [warm] done [pause:200].";
  it("keeps tags for the assistant in voice mode", () => {
    expect(tagsForSpeech(line, { author: "assistant", voiceMode: true })).toBe("Okay [warm] done.");
  });
  it.each(["tool", "web", "file", "user", "other"] as const)(
    "removes tags from %s text even in voice mode",
    (author) => {
      expect(tagsForSpeech(line, { author, voiceMode: true })).toBe("Okay done.");
    },
  );
  it("removes tags from the assistant when voice mode is off", () => {
    expect(tagsForSpeech(line, { author: "assistant", voiceMode: false })).toBe("Okay done.");
  });
});

describe("mask and restore", () => {
  it("hides canonical tags and gives them back unchanged", () => {
    const masked = maskDeliveryTags("Hi [warm] 5 [pause:300] there");
    expect(masked.text).not.toContain("[warm]");
    expect(masked.restore(masked.text)).toBe("Hi [warm] 5 [pause:300] there");
  });
  it("leaves a tag that touches a digit visible and untouched", () => {
    expect(maskDeliveryTags("a5[soft]").text).toBe("a5[soft]");
  });
});

describe("speech prep keeps tags intact", () => {
  it("does not convert a tag inside a Hindi sentence", () => {
    const out = prepareSpeechText("नमस्ते [warm] यह meeting है।", { hindiVoice: true });
    expect(out).toContain("[warm]");
    expect(out).toContain("मीटिंग");
  });
  it("does not convert a hyphenated tag", () => {
    expect(prepareSpeechText("ठीक है [laugh-soft] ठीक।", { hindiVoice: true })).toContain(
      "[laugh-soft]",
    );
  });
  it("keeps a tag that carries trailing punctuation", () => {
    expect(prepareSpeechText("मैं यहाँ हूँ [sigh].", { hindiVoice: true })).toContain("[sigh]");
  });
  it("a tag does not change how the rest of an English sentence is read", () => {
    expect(prepareSpeechText("Open the file [soft] now.", { hindiVoice: true })).toBe(
      "Open the file [soft] now.",
    );
  });
});

describe("prepareForSpeech and delivery tags", () => {
  const prep = { enabled: true, hindiVoice: true, deliveryTags: true };
  it("removes tags by default", () => {
    expect(prepareForSpeech("Hello [warm] there.")).toBe("Hello there.");
    expect(prepareForSpeech("Hello [warm] there.", {}, { enabled: true })).toBe("Hello there.");
  });
  it("keeps allow-listed tags for the assistant's voice reply", () => {
    expect(prepareForSpeech("Hello [warm] there.", {}, prep)).toBe("Hello [warm] there.");
  });
  it("does not spell a number inside a tag", () => {
    expect(prepareForSpeech("Wait [pause:300] then go.", {}, prep)).toBe(
      "Wait [pause:300] then go.",
    );
  });
  it("numbers around a tag are still spelled", () => {
    expect(prepareForSpeech("It is 5 [calm] items.", {}, prep)).toBe("It is five [calm] items.");
  });
  it("the owner's pronunciation entries cannot rewrite a tag", () => {
    expect(prepareForSpeech("Hi [warm] there.", { warm: "vorm" }, prep)).toBe("Hi [warm] there.");
  });
  it("a Hinglish line keeps its tag and still gets the Devanagari tech words", () => {
    const out = prepareForSpeech("Aapka meeting [warm] kal hai.", {}, prep);
    expect(out).toContain("[warm]");
    expect(out).toMatch(/[ऀ-ॿ]/);
  });
  it("drops an unknown tag even when tags are kept", () => {
    expect(prepareForSpeech("Hi [giggle] there.", {}, prep)).toBe("Hi there.");
  });
});

describe("Hinglish tech-word pronunciations (Devanagari for the engine only)", () => {
  const say = (text: string): string =>
    prepareForSpeech(text, {}, { enabled: true, hindiVoice: true });
  it.each([
    ["FRIDAY", "फ़्राइडे"],
    ["WhatsApp", "व्हाट्सऐप"],
    ["Gmail", "जीमेल"],
    ["Chrome", "क्रोम"],
    ["YouTube", "यूट्यूब"],
    ["pdf", "पीडीएफ"],
    ["reminder", "रिमाइंडर"],
    ["meeting", "मीटिंग"],
    ["email", "ईमेल"],
    ["Google", "गूगल"],
    ["Wi-Fi", "वाईफ़ाई"],
    ["Bluetooth", "ब्लूटूथ"],
    ["download", "डाउनलोड"],
    ["file", "फ़ाइल"],
    ["app", "ऐप"],
    ["password", "पासवर्ड"],
    ["screenshot", "स्क्रीनशॉट"],
    ["calendar", "कैलेंडर"],
    ["alarm", "अलार्म"],
  ])("%s is said as %s in a Hindi sentence", (word, deva) => {
    expect(say(`मुझे यह ${word} चाहिए।`)).toContain(deva);
  });
  it("a capital PDF is spelled out letter by letter in Devanagari", () => {
    expect(say("मुझे यह PDF चाहिए।")).toContain("पी डी एफ़");
  });
  it("OK is said as ओके", () => {
    expect(say("ठीक है, OK।")).toContain("ओके");
  });
  it("never changes a pure English sentence", () => {
    expect(say("Open the Chrome app and download the file.")).toBe(
      "Open the Chrome app and download the file.",
    );
  });
  it("the English voice leaves everything in Latin", () => {
    expect(prepareForSpeech("Open Gmail now.", {}, { enabled: true, hindiVoice: false })).toBe(
      "Open Gmail now.",
    );
  });
});

describe("voice-mode prompt block", () => {
  const block = voiceModeBlock();
  it("names Role, Tone, Pacing, Pronunciation and Variety", () => {
    for (const part of ["Role:", "Tone:", "Pacing:", "Pronunciation:", "Variety:"]) {
      expect(block).toContain(part);
    }
  });
  it("says FRIDAY is an assistant, not a person, and speaks feminine in Hindi", () => {
    expect(block).toMatch(/not a person/);
    expect(block).toMatch(/never claim to be human/);
    expect(block).toMatch(/feminine/);
    expect(block).toMatch(/sweet, warm, polite young woman/);
  });
  it("asks for no markdown, a short first sentence and varied openers", () => {
    expect(block).toMatch(/No markdown/);
    expect(block).toMatch(/short first sentence/);
    expect(block).toMatch(/never begin two replies in a row the same way/);
  });
  it("leaves the tag rules out until the screen strips tags", () => {
    expect(block).not.toMatch(/Delivery:/);
    expect(block).not.toContain("[warm]");
  });
  it("states the tag rules with the allow-list when asked", () => {
    const withTags = voiceModeBlock({ deliveryTags: true });
    expect(withTags).toMatch(/at most one tag per sentence/);
    expect(withTags).toContain(deliveryTagList());
    expect(withTags).toMatch(/Never put a tag in code, numbers, or text copied from a tool/);
  });
  it("stays small (token cost)", () => {
    expect(voiceModeBlock({ deliveryTags: true }).length).toBeLessThan(900);
    expect(block.length).toBeLessThan(700);
  });
});

describe("voice-mode block wiring", () => {
  const brain = readFileSync(resolve(__dirname, "../../src/lib/friday/brain-engine.ts"), "utf8");
  it("is added to a spoken turn only, and describes the tags", () => {
    // one helper builds the block, and only for a spoken surface
    expect(brain).toMatch(
      /options\.voice \? voiceModeBlock\(\{ deliveryTags: options\.deliveryTags \}\) : ""/,
    );
    // the full turn asks for the tags only on the voice surface; the quick lane never (its reply is stripped)
    expect(brain).toMatch(
      /turnVoiceParts\(hints, \{\s*voice: surface === "voice",\s*deliveryTags: true,?\s*\}\)/,
    );
    expect(brain).toMatch(/voice: surface === "voice",\s*deliveryTags: false,?\s*\}\)/);
    expect(brain.match(/voiceModeBlock\(/g)?.length).toBe(1);
  });
  it("describes the tags only because the screen strips them", () => {
    expect(brain).toContain("stripDeliveryTagsLive(raw)");
    expect(brain).not.toMatch(/\btext: (event|raw)\.text/);
  });
});
