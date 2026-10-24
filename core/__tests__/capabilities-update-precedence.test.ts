/**
 * A new FRIDAY ships newer built-in capabilities. A copy in the workspace (an
 * older "Update content" merge, an old customisation) must not silently block
 * them, while a copy that is as new or newer still wins as before.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require_ = createRequire(import.meta.url);
const capabilities = require_(
  path.resolve(import.meta.dirname, "../../electron/capabilities.cjs"),
) as {
  list: (roots: { appRoot: string; workspaceRoot: string }) => {
    items: {
      id: string;
      origin: string;
      version: string | null;
      shadows: { origin: string; version: string | null } | null;
      staleOverride?: { origin: string; version: string | null };
    }[];
  };
};

let appRoot = "";
let workspaceRoot = "";

const write = (root: string, version: string | null, extra: Record<string, unknown> = {}) => {
  const dir = path.join(root, "agents", "core", "demo");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ name: "Demo", ...(version ? { version } : {}), ...extra }),
  );
};
const pick = () =>
  capabilities
    .list({ appRoot, workspaceRoot })
    .items.find((item) => item.id.endsWith("demo")) as NonNullable<
    ReturnType<typeof capabilities.list>["items"][number]
  >;

beforeEach(() => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "friday-cap-"));
  appRoot = path.join(base, "app");
  workspaceRoot = path.join(base, "workspace");
  fs.mkdirSync(appRoot);
  fs.mkdirSync(workspaceRoot);
});
afterEach(() => fs.rmSync(path.dirname(appRoot), { recursive: true, force: true }));

describe("built-in versus workspace copy of the same capability", () => {
  it("lets a strictly newer built-in replace an older workspace copy, and says so", () => {
    write(appRoot, "1.2.0");
    write(workspaceRoot, "1.1.0");
    const item = pick();
    expect(item.origin).toBe("app");
    expect(item.version).toBe("1.2.0");
    expect(item.staleOverride).toMatchObject({ origin: "workspace", version: "1.1.0" });
  });

  it("keeps the workspace copy when it is as new or newer", () => {
    write(appRoot, "1.2.0");
    write(workspaceRoot, "1.2.0");
    expect(pick().origin).toBe("workspace");
    write(workspaceRoot, "1.10.0");
    const item = pick();
    expect(item.origin).toBe("workspace");
    expect(item.version).toBe("1.10.0");
    expect(item.shadows).toMatchObject({ origin: "app", version: "1.2.0" });
  });

  it("keeps the old rule when a version is missing or not a number", () => {
    write(appRoot, "2.0.0");
    write(workspaceRoot, null);
    expect(pick().origin).toBe("workspace");
    write(workspaceRoot, "custom");
    expect(pick().origin).toBe("workspace");
  });

  it("adds a capability only the workspace has, and one only the app has", () => {
    write(appRoot, "1.0.0");
    const solo = path.join(workspaceRoot, "agents", "core", "mine");
    fs.mkdirSync(solo, { recursive: true });
    fs.writeFileSync(
      path.join(solo, "manifest.json"),
      JSON.stringify({ name: "Mine", version: "0.1.0" }),
    );
    const items = capabilities.list({ appRoot, workspaceRoot }).items;
    expect(items.find((i) => i.id.endsWith("mine"))?.origin).toBe("workspace");
    expect(items.find((i) => i.id.endsWith("demo"))?.origin).toBe("app");
  });
});
