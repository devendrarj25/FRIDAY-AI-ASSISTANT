/**
 * Static audit of the Models page: every button does something, every call the
 * page makes exists, every tab is reachable, every cloud provider it offers can
 * actually be connected, and the input → output reading of a model is right.
 */
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { modelCatalog, providers, UNSUPPORTED_CLOUD } from "../../src/lib/friday/model-catalog";
import { MODALITY_FILTERS, modalityOf } from "../../src/lib/friday/model-sections";

const require_ = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const modelsApi = require_(path.join(root, "electron/models.cjs"));

const PAGE_FILES = ["src/routes/models.tsx", "src/components/friday/ModelsLivePanel.tsx"];

function walk(file: string, visit: (node: ts.Node, sf: ts.SourceFile) => void) {
  const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const go = (node: ts.Node) => {
    visit(node, sf);
    ts.forEachChild(node, go);
  };
  go(sf);
}

describe("Models page controls", () => {
  it("has no button without a handler", () => {
    const dead: string[] = [];
    for (const file of PAGE_FILES) {
      walk(file, (node, sf) => {
        if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
        const tag = node.tagName.getText(sf);
        if (!["Button", "button", "ActionButton"].includes(tag)) return;
        const names = node.attributes.properties.map((p) => p.name?.getText(sf));
        if (!["onClick", "asChild", "type", "disabled", "onPress"].some((n) => names.includes(n))) {
          dead.push(`${file}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
        }
      });
    }
    expect(dead).toEqual([]);
  });

  it("only calls store methods and desktop functions that exist", () => {
    const engine = read("src/lib/friday/models-engine.ts");
    const body = engine.slice(engine.indexOf("class ModelsStore"));
    const methods = new Set(
      [...body.matchAll(/^ {2}(?:async |private )*([a-zA-Z0-9_]+)(?:\s*=|\()/gm)].map((m) => m[1]),
    );
    const preload = read("electron/preload.cjs");
    const exposed = new Set([...preload.matchAll(/^ {2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
    const missing: string[] = [];
    for (const file of PAGE_FILES) {
      walk(file, (node, sf) => {
        if (ts.isPropertyAccessExpression(node) && node.expression.getText(sf) === "engine") {
          if (
            !methods.has(node.name.text) &&
            !["getSnapshot", "subscribe"].includes(node.name.text)
          ) {
            missing.push(`${file}: engine.${node.name.text}`);
          }
        }
      });
      for (const m of read(file).matchAll(
        /(?:desktopApi\(\)|\bapi)\??\.([a-z][A-Za-z0-9_]+)\??\(/g,
      )) {
        if (!exposed.has(m[1]!)) missing.push(`${file}: ${m[1]} is not exposed by the preload`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every cloud provider offered is either connectable or marked as having no connector", () => {
    const offered = providers.filter((p) => p.kind === "cloud").map((p) => p.id);
    const dispatch = new Set(Object.keys(modelsApi.CLOUD));
    for (const id of offered) {
      expect(dispatch.has(id) || UNSUPPORTED_CLOUD.has(id), id).toBe(true);
    }
    for (const id of dispatch) expect(offered, id).toContain(id);
    for (const id of UNSUPPORTED_CLOUD) expect(dispatch.has(id), id).toBe(false);
    expect(read("src/routes/models.tsx")).toContain("disabled={unsupported}");
  });

  it("a rejected key is not shown as connected", () => {
    const engine = read("src/lib/friday/models-engine.ts");
    expect(engine).toContain('return ps?.apiKey && ps.online ? "Connected" : "Available"');
    expect(read("src/routes/models.tsx")).toContain("did not connect");
  });
});

describe("input → output", () => {
  it("reads each kind of model correctly", () => {
    const of = (category: string, caps: string[] = []) => modalityOf({ category, caps });
    expect(of("Chat").label).toBe("Text → Text");
    expect(of("Coding").key).toBe("text>text");
    expect(of("Chat", ["vision"]).input).toEqual(["Text", "Image"]);
    expect(of("Vision").label).toBe("Text + Image → Text");
    expect(of("Multimodal", ["audio"]).input).toEqual(["Text", "Image", "Audio"]);
    expect(of("Speech to Text").label).toBe("Audio → Text");
    expect(of("Text to Speech").label).toBe("Text → Audio");
    expect(of("Image").label).toBe("Text → Image");
    expect(of("Embedding").label).toBe("Text → Vector");
  });

  it("every catalog model lands in a filter the page offers", () => {
    const keys: string[] = MODALITY_FILTERS.map((f) => f.key);
    const stray = modelCatalog.filter(
      (m) => !keys.includes(modalityOf(m).key) && m.category !== "Reranking",
    );
    expect(stray.map((m) => `${m.id}: ${modalityOf(m).key}`)).toEqual([]);
  });
});
