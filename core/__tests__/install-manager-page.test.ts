/**
 * Static audit of the Install Manager page: every button does something, every
 * call it makes exists, every panel sits under exactly one section, and the
 * services and details it promises are on the page.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { INSTALL_SECTIONS, PANEL_SECTIONS } from "../../src/lib/friday/installer-sections";

const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const PAGE = "src/routes/install-manager.tsx";

function walk(visit: (node: ts.Node, sf: ts.SourceFile) => void) {
  const sf = ts.createSourceFile(PAGE, read(PAGE), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const go = (node: ts.Node) => {
    visit(node, sf);
    ts.forEachChild(node, go);
  };
  go(sf);
}

describe("Install Manager page", () => {
  it("has no button without a handler", () => {
    const dead: string[] = [];
    walk((node, sf) => {
      if (!ts.isJsxOpeningElement(node) && !ts.isJsxSelfClosingElement(node)) return;
      if (!["Button", "button"].includes(node.tagName.getText(sf))) return;
      const names = node.attributes.properties.map((p) => p.name?.getText(sf));
      if (!["onClick", "asChild", "type", "disabled"].some((n) => names.includes(n))) {
        dead.push(`line ${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`);
      }
    });
    expect(dead).toEqual([]);
  });

  it("only calls store methods and desktop functions that exist", () => {
    const engine = read("src/lib/friday/installer-engine.ts");
    const body = engine.slice(engine.indexOf("class InstallerStore"));
    const methods = new Set(
      [...body.matchAll(/^ {2}(?:async |private )*([a-zA-Z0-9_]+)(?:\s*=|\()/gm)].map((m) => m[1]),
    );
    const missing: string[] = [];
    walk((node, sf) => {
      if (ts.isPropertyAccessExpression(node) && node.expression.getText(sf) === "installer") {
        if (!methods.has(node.name.text)) missing.push(`installer.${node.name.text}`);
      }
    });
    const preload = read("electron/preload.cjs");
    const exposed = new Set([...preload.matchAll(/^ {2}([A-Za-z0-9_]+):/gm)].map((m) => m[1]));
    for (const name of [
      "toolServices",
      "toolServiceAction",
      "setToolServiceIdle",
      "onToolServicesChanged",
      "detectTools",
      "latestToolVersions",
      "runToolJob",
    ]) {
      if (!exposed.has(name)) missing.push(`preload ${name}`);
    }
    expect(missing).toEqual([]);
  });

  it("puts every panel under exactly one section and shows each section", () => {
    const page = read(PAGE);
    const sections = INSTALL_SECTIONS.map((s) => s.key);
    for (const key of sections) expect(page, key).toContain(`section === "${key}"`);
    const titles = [
      ...page.matchAll(
        /<HudPanel[^>]*?\btitle=(?:"([^"]+)"|\{[^}]*?"([^"]+)"\s*:\s*"([^"]+)"[^}]*\})/g,
      ),
    ];
    const found = new Set<string>();
    for (const m of titles) for (const t of [m[1], m[2], m[3]]) if (t) found.add(t);
    for (const title of found) {
      expect(PANEL_SECTIONS[title], `${title} has no section`).toBeTruthy();
      const at = page.indexOf(`"${title}"`);
      const before = page.slice(0, at);
      const last = [...before.matchAll(/section === "([a-z]+)"/g)].pop();
      // Package details and the services panel are components defined after the page.
      if (
        last &&
        before.lastIndexOf("function PackageDetails") < 0 &&
        before.lastIndexOf("function ServicesPanel") < 0
      ) {
        expect(last[1], title).toBe(PANEL_SECTIONS[title]);
      }
    }
    for (const title of Object.keys(PANEL_SECTIONS)) expect(page, title).toContain(title);
  });

  it("does not run its own scan timer: the store polls on the shared poller", () => {
    expect(read(PAGE)).not.toContain("useLivePoll");
    const engine = read("src/lib/friday/installer-engine.ts");
    expect(engine).toContain('"installer.scan"');
    expect(engine).toContain('"installer.services"');
    expect(engine).toContain("this.stopPolls()");
  });

  it("shows a package's details and its service controls", () => {
    const page = read(PAGE);
    expect(page).toContain("<PackageDetails");
    expect(page).toContain("<ServiceButtons");
    expect(page).toContain("When to stop services FRIDAY started");
    expect(page).toContain("no official source names a newer version");
  });
});

describe("Install Manager page: local builds", () => {
  const page = read(PAGE);

  it("shows the local builds panel in the software section, not under a registered panel title", () => {
    const software = page.indexOf('section === "software"');
    const panel = page.indexOf("<LocalBuildsPanel />");
    expect(panel).toBeGreaterThan(software);
    expect(panel).toBeLessThan(page.indexOf('section === "queue"'));
    expect(page).not.toMatch(/<HudPanel[^>]*title="Local builds"/);
  });

  it("covers loading, empty, error with Retry and offline, and every control has a handler", () => {
    const body = page.slice(page.indexOf("function LocalBuildsPanel"));
    for (const needle of [
      "catalog.offline",
      "<LoadingState",
      "<EmptyState",
      "<ErrorState",
      "onRetry",
      "aria-label",
      "onToggle=",
      "onClick={() => adopt()}",
    ]) {
      expect(body, needle).toContain(needle);
    }
  });

  it("calls only a bridge function the preload exposes", () => {
    expect(read("electron/preload.cjs")).toMatch(/^ {2}adoptLocalBuilds:/m);
    expect(page).toContain("adoptLocalBuilds");
  });

  it("turning the toggle on or off writes the setting, then reads the list again", () => {
    const body = page.slice(page.indexOf("function LocalBuildsPanel"));
    const handler = body.slice(body.indexOf("const switchLocalBuilds"));
    expect(body).toContain("onToggle={() => void switchLocalBuilds()}");
    const write = handler.indexOf('preferences.setToggle("installUseLocalBuilds", !on)');
    const sent = handler.indexOf("await preferences.flush()");
    const reload = handler.indexOf("catalog.load()");
    expect(write).toBeGreaterThanOrEqual(0);
    expect(sent).toBeGreaterThan(write);
    expect(reload).toBeGreaterThan(sent);
    // The reload also runs when the write fails, and the existing loading and error-with-Retry states are kept.
    expect(handler.slice(0, handler.indexOf("\n  };")).includes("finally")).toBe(true);
    expect(body).toContain("<LoadingState");
    expect(body).toContain("onRetry={() => void catalog.load()}");
  });

  it("uses the typed bridge and shows the swept count only when something was swept", () => {
    const body = page.slice(page.indexOf("function LocalBuildsPanel"));
    expect(page).toMatch(
      /import \{[^}]*type InstallerAdoptResult[^}]*\} from "@\/lib\/friday\/desktop"/,
    );
    expect(body).toContain("desktopApi()?.adoptLocalBuilds");
    expect(body).not.toMatch(/desktopApi\(\) as \{/);
    expect(page).not.toMatch(/type AdoptReply\b/);
    expect(body).toMatch(/swept\?\.length \?\? 0\) > 0|swept\?\.length\) > 0/);
    expect(body).toMatch(/partly copied file/);
  });
});
