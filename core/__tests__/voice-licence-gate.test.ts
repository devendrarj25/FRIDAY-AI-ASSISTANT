/**
 * The licence gate of the voice weight pins: every pin carries a structured licence record, the bundle gate refuses
 * GPL, LGPL, non-commercial, share-alike and unknown licences. The record holds machine fields only: no notice or
 * attribution text. Offline: no network, no weights, no clock.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

type LicRecord = {
  id: string;
  url: string;
  redistribution: string;
  checkedAt?: string;
  upstream?: { id: string; url: string; source: string; checkedAt: string };
};
type Pin = { license: string; licenseRecord?: LicRecord };
const req = createRequire(import.meta.url);
const pins = req("../../electron/voice-pins.cjs") as {
  PINS: Record<string, Pin>;
  LICENCES: Record<string, { url: string; redistribution: string }>;
  bundleAllowed: (pin: unknown) => boolean;
};

const STREAM_EAR = "soniqo/Nemotron-3.5-ASR-Streaming-Multilingual-0.6B-ONNX-INT8";
const CLASSES = ["permissive", "attribution", "use-restricted", "refused"];
const record = (id: string, extra: Partial<LicRecord> = {}): { licenseRecord: LicRecord } => ({
  licenseRecord: {
    id,
    url: "https://example.org/licence",
    redistribution: "permissive",
    ...extra,
  },
});

describe("every pin has a known licence record", () => {
  const entries = Object.entries(pins.PINS);

  it("covers all 18 pinned repositories", () => {
    expect(entries.length).toBe(18);
  });

  it.each(entries)("%s: id, official url, class, date", (repo, pin) => {
    const rec = pin.licenseRecord;
    expect(rec, `${repo} licence record`).toBeTruthy();
    expect(Object.keys(pins.LICENCES), `${repo} id`).toContain(rec!.id);
    expect(rec!.id, `${repo} agrees with the plain licence field`).toBe(pin.license);
    expect(rec!.url, `${repo} url`).toBe(pins.LICENCES[rec!.id]!.url);
    expect(rec!.url.startsWith("https://"), `${repo} https`).toBe(true);
    expect(CLASSES, `${repo} class`).toContain(rec!.redistribution);
    expect(rec!.redistribution, `${repo} class from the table`).toBe(
      pins.LICENCES[rec!.id]!.redistribution,
    );
    expect(Object.keys(rec!).sort(), `${repo} machine fields only`).toEqual(
      (rec!.upstream
        ? ["checkedAt", "id", "redistribution", "upstream", "url"]
        : ["checkedAt", "id", "redistribution", "url"]
      ).sort(),
    );
    expect(rec!.checkedAt, `${repo} checked date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("no record carries a notice or attribution text, and the file names no one to credit", () => {
    for (const [repo, pin] of entries) {
      expect(pin.licenseRecord, repo).not.toHaveProperty("notice");
      expect(JSON.stringify(pin.licenseRecord), repo).not.toMatch(/credit|copyright|based on/i);
    }
    expect(pins).not.toHaveProperty("noticesFor");
  });

  it("every shipped pin passes the bundle gate", () => {
    for (const [repo, pin] of entries) expect(pins.bundleAllowed(pin), repo).toBe(true);
  });

  it("no pin is copyleft, non-commercial or share-alike", () => {
    for (const pin of Object.values(pins.PINS)) {
      expect(pin.licenseRecord!.id).not.toMatch(/GPL|(^|-)NC(-|$)|(^|-)SA(-|$)/);
    }
  });
});

describe("the stream ear licence conflict is resolved and recorded", () => {
  const pin = () => pins.PINS[STREAM_EAR]!;

  it("the pinned repository is the NVIDIA Open Model License, as its own tag and card say (2026-11-27)", () => {
    expect(pin().license).toBe("NVIDIA-Open-Model-License");
    expect(pin().licenseRecord!.id).toBe("NVIDIA-Open-Model-License");
    expect(pin().licenseRecord!.url).toBe(
      "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/",
    );
    expect(pin().licenseRecord!.redistribution).toBe("attribution");
  });

  it("the upstream NVIDIA card's OpenMDW-1.1 is kept beside it, with its source and date", () => {
    const up = pin().licenseRecord!.upstream!;
    expect(up.id).toBe("OpenMDW-1.1");
    expect(up.url).toBe("https://openmdw.ai/license/1-1/");
    expect(up.source).toBe("https://huggingface.co/nvidia/nemotron-3.5-asr-streaming-0.6b");
    expect(up.checkedAt).toBe("2026-11-27");
    expect(Object.keys(pins.LICENCES)).toContain("OpenMDW-1.1");
  });

  it("only this pin carries an upstream note", () => {
    const withUpstream = Object.entries(pins.PINS)
      .filter(([, p]) => p.licenseRecord?.upstream)
      .map(([repo]) => repo);
    expect(withUpstream).toEqual([STREAM_EAR]);
  });
});

describe("bundleAllowed", () => {
  it.each([
    "GPL-3.0-only",
    "BSD-2-Clause-NC",
    "GPL-2.0-or-later",
    "LGPL-2.1",
    "LGPL-3.0-only",
    "AGPL-3.0",
    "CC-BY-NC-4.0",
    "CC-BY-NC-SA-4.0",
    "CC-BY-SA-4.0",
    "CC-BY-NC-ND-4.0",
    "Proprietary",
    "Llama-3-Community",
    "unknown",
    "",
  ])("refuses %s", (id) => {
    expect(pins.bundleAllowed(record(id))).toBe(false);
  });

  it.each([
    "MIT",
    "Apache-2.0",
    "BSD-2-Clause",
    "CC-BY-4.0",
    "OpenRAIL-M",
    "NVIDIA-Open-Model-License",
    "OpenMDW-1.1",
  ])("allows the listed %s", (id) => {
    expect(pins.bundleAllowed(record(id))).toBe(true);
  });

  it("refuses a pin with no record, a refused class, a bad class, a non-https url or a missing url", () => {
    expect(pins.bundleAllowed({})).toBe(false);
    expect(pins.bundleAllowed(null)).toBe(false);
    expect(pins.bundleAllowed(undefined)).toBe(false);
    expect(pins.bundleAllowed({ licenseRecord: "MIT" })).toBe(false);
    expect(pins.bundleAllowed({ license: "MIT" })).toBe(false);
    expect(pins.bundleAllowed(record("MIT", { redistribution: "refused" }))).toBe(false);
    expect(pins.bundleAllowed(record("MIT", { redistribution: "anything" }))).toBe(false);
    expect(pins.bundleAllowed(record("MIT", { url: "http://example.org/x" }))).toBe(false);
    expect(pins.bundleAllowed(record("MIT", { url: "" }))).toBe(false);
    const noUrl = record("MIT");
    delete (noUrl.licenseRecord as Partial<LicRecord>).url;
    expect(pins.bundleAllowed(noUrl)).toBe(false);
  });

  it("is pure: the same pin gives the same answer and nothing is changed", () => {
    const pin = record("CC-BY-4.0", { redistribution: "attribution" });
    const before = JSON.stringify(pin);
    expect(pins.bundleAllowed(pin)).toBe(true);
    expect(pins.bundleAllowed(pin)).toBe(true);
    expect(JSON.stringify(pin)).toBe(before);
  });
});
