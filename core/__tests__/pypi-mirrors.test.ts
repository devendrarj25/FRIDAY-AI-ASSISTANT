import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const shared = require("../../electron/pypi-mirrors.cjs") as {
  WHEEL_HOST: string;
  validMirrors: (list: unknown) => { id?: string; packages: string; simple: string }[];
  mirrorUrls: (url: string, mirrors: { packages: string }[]) => string[];
};
const engines = require("../../electron/engine-install.cjs");
const wheelhouse = require("../../scripts/wheelhouse.cjs");

const WHEEL = "https://files.pythonhosted.org/packages/ab/cd/ef/torch-1.whl";

describe("shared PyPI mirror helpers", () => {
  it("keeps only mirrors with https packages and simple roads, in order", () => {
    const list = [
      { id: "a", packages: "https://a.example/packages/", simple: "https://a.example/simple" },
      { id: "bad", packages: "http://b.example/packages", simple: "https://b.example/simple" },
      { id: "nosimple", packages: "https://c.example/packages" },
      null,
      { id: "d", packages: "https://d.example/packages", simple: "https://d.example/simple" },
    ];
    expect(shared.validMirrors(list).map((m) => m.id)).toEqual(["a", "d"]);
    expect(shared.validMirrors(undefined)).toEqual([]);
    expect(shared.validMirrors("x")).toEqual([]);
  });

  it("maps a pythonhosted wheel onto each mirror and refuses other hosts", () => {
    const mirrors = shared.validMirrors([
      { packages: "https://a.example/packages//", simple: "https://a.example/simple" },
    ]);
    expect(shared.mirrorUrls(WHEEL, mirrors)).toEqual([
      "https://a.example/packages/ab/cd/ef/torch-1.whl",
    ]);
    expect(shared.mirrorUrls("https://example.com/packages/a/b.whl", mirrors)).toEqual([]);
    expect(shared.mirrorUrls("https://files.pythonhosted.org/nopath.whl", mirrors)).toEqual([]);
    expect(shared.WHEEL_HOST).toBe("files.pythonhosted.org");
  });

  it("is the one implementation behind the engine installer and the wheelhouse", () => {
    const mirrors = shared.validMirrors([
      { packages: "https://a.example/packages", simple: "https://a.example/simple" },
    ]);
    expect(engines.mirrorUrls(WHEEL, mirrors)).toEqual(shared.mirrorUrls(WHEEL, mirrors));
    expect(wheelhouse.mirrorUrls(WHEEL, mirrors)).toEqual(shared.mirrorUrls(WHEEL, mirrors));
    expect(engines.pypiMirrors()).toEqual(wheelhouse.pypiMirrors());
  });
});
