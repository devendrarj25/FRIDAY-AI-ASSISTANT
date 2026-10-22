/**
 * FRIDAY Glass primitives: server-rendered markup (no browser, no window),
 * so pages built on them keep every name, role and state.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Cpu, Download, RefreshCw, Trash2 } from "lucide-react";
import {
  ActionButton,
  DataTable,
  EmptyState,
  FilterTabs,
  HudPanel,
  LoadingState,
  Panel,
  SectionTabs,
  StatTile,
  StatusPill,
  ToggleRow,
  Toolbar,
} from "../../src/components/friday/ui";

const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("panels and tiles", () => {
  it("keeps HudPanel and its legacy alias, with an optional header icon", () => {
    const plain = html(
      createElement(HudPanel, { title: "Memory", hint: "12 records", children: "body" }),
    );
    expect(plain).toContain('class="hud-panel relative overflow-hidden rounded-md"');
    expect(plain).toContain('title="Memory"');
    expect(plain).toContain("12 records");
    expect(plain).toContain("shadow-[0_0_10px_2px_var(--color-primary)]");
    const withIcon = html(createElement(HudPanel, { title: "CPU", icon: Cpu, children: "x" }));
    expect(withIcon).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg><h2/);
    expect(html(createElement(Panel, { title: "Legacy", children: "y" }))).toContain("Legacy");
  });

  it("gives tiles a motion state without moving layout", () => {
    const tile = html(createElement(StatTile, { label: "Runs", value: 3 }));
    expect(tile).toContain("hover:-translate-y-px");
    expect(tile).toContain("motion-friday");
    expect(html(createElement(StatusPill, { label: "ready" }))).toContain("ready");
  });
});

describe("tabs and toggles are real controls", () => {
  it("FilterTabs is a tab list with one tab in the Tab order", () => {
    const out = html(
      createElement(FilterTabs, {
        tabs: [
          { key: "all", label: "All" },
          { key: "on", label: "Enabled" },
        ],
        value: "on",
        onChange: () => undefined,
      }),
    );
    expect(out).toContain('role="tablist"');
    expect(out.match(/role="tab"/g)).toHaveLength(2);
    expect(out).toContain('aria-selected="true" tabindex="0" data-tab-key="on"');
    expect(out).toContain('aria-selected="false" tabindex="-1" data-tab-key="all"');
    expect(out).toContain("focus-visible:ring-1");
  });

  it("SectionTabs shows icons and live counts", () => {
    const out = html(
      createElement(SectionTabs, {
        tabs: [
          { key: "installed", label: "Installed", icon: Download, count: 4 },
          { key: "catalog", label: "Catalog" },
        ],
        value: "installed",
        onChange: () => undefined,
        label: "Model sections",
      }),
    );
    expect(out).toContain('role="tablist" aria-label="Model sections"');
    expect(out).toMatch(/<svg[^>]*>.*?<\/svg>Installed<span[^>]*>4<\/span>/);
    expect(out).toContain("Catalog");
  });

  it("ToggleRow stays a named switch with a focus ring", () => {
    const out = html(
      createElement(ToggleRow, { label: "Neon glow", on: true, onToggle: () => undefined }),
    );
    expect(out).toContain('role="switch" aria-checked="true" aria-label="Neon glow"');
    expect(out).toContain("focus-visible:ring-1");
  });
});

describe("ActionButton and Toolbar", () => {
  it("keeps the label in the DOM right after the icon and in the accessible name", () => {
    const out = html(createElement(ActionButton, { icon: RefreshCw, label: "Refresh now" }));
    expect(out).toContain('aria-label="Refresh now"');
    expect(out).toContain('title="Refresh now"');
    expect(out).toMatch(/<\/svg><span class="action-label">Refresh now<\/span>/);
    expect(out).toContain("action-btn");
    expect(out).toContain("friday-btn");
  });

  it("shows a spinner and disables itself while busy, and can stay inline", () => {
    const busy = html(
      createElement(ActionButton, { icon: Download, label: "Install", busy: true }),
    );
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain("disabled");
    expect(busy).toContain("animate-spin");
    const inline = html(
      createElement(ActionButton, { icon: Download, label: "Install", labelMode: "inline" }),
    );
    expect(inline).toContain('data-label-mode="inline"');
  });

  it("renders every action inline before it is measured (static render)", () => {
    const out = html(
      createElement(Toolbar, {
        actions: [
          { id: "r", label: "Refresh", icon: RefreshCw, onSelect: () => undefined, primary: true },
          { id: "d", label: "Delete", icon: Trash2, onSelect: () => undefined },
        ],
      }),
    );
    expect(out).toContain('role="toolbar"');
    expect(out).toContain('aria-label="Refresh"');
    expect(out).toContain('aria-label="Delete"');
    expect(out).not.toContain('aria-label="More"');
  });
});

describe("empty, loading and tables", () => {
  it("EmptyState and LoadingState announce themselves", () => {
    const empty = html(
      createElement(EmptyState, { title: "No plugins yet", hint: "Install one from the catalog." }),
    );
    expect(empty).toContain('role="status"');
    expect(empty).toContain("No plugins yet");
    const loading = html(createElement(LoadingState, { rows: 2 }));
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("Loading…");
    expect(loading.match(/aria-hidden="true" class="h-3/g)).toHaveLength(2);
  });

  it("DataTable scrolls sideways inside its own container", () => {
    const out = html(
      createElement(DataTable, { columns: ["Name", "State"], rows: [["a", "b"]], pinLast: true }),
    );
    expect(out).toContain("overflow-x-auto");
    expect(out).toContain("backdrop-blur-sm");
  });
});

describe("shadcn primitives carry the FRIDAY Glass hooks", () => {
  it("buttons, fields, menus and dialogs", () => {
    const button = read("src/components/ui/button.tsx");
    expect(button).toContain('"friday-btn inline-flex');
    expect(button).toContain("disabled:cursor-not-allowed");
    expect(button).not.toContain("disabled:pointer-events-none");
    expect(button).not.toMatch(/(?<![\w:-])hover:/);
    expect(button).toContain("not-disabled:hover:bg-primary/90");
    for (const file of ["input", "textarea", "select"]) {
      expect(read(`src/components/ui/${file}.tsx`)).toContain("friday-field");
    }
    for (const file of [
      "dropdown-menu",
      "context-menu",
      "menubar",
      "popover",
      "hover-card",
      "select",
    ]) {
      expect(read(`src/components/ui/${file}.tsx`)).toContain("glass-menu glass-backdrop-blur");
    }
    for (const file of ["dialog", "alert-dialog", "sheet"]) {
      expect(read(`src/components/ui/${file}.tsx`)).toContain("glass-dialog glass-backdrop-blur");
    }
  });
});

describe("chrome keeps its locked behaviour under the new look", () => {
  const shell = read("src/components/friday/AppShell.tsx");
  const strip = read("src/components/friday/TitleStrip.tsx");

  it("auto-collapses a narrow window without touching the saved choice", () => {
    expect(shell).toContain('const NARROW_SIDEBAR_QUERY = "(max-width: 1199px)";');
    expect(shell).toContain("const collapsed = savedCollapsed || (narrow && !peek);");
    const toggle = shell.slice(
      shell.indexOf("const toggleCollapsed"),
      shell.indexOf("const askLife"),
    );
    // Narrow: only the session peek flips, then returns before the saved write.
    expect(toggle.indexOf("setPeek((open) => !open);")).toBeLessThan(
      toggle.indexOf('localStorage.setItem("friday.sidebar.collapsed"'),
    );
    expect(toggle).toContain("return;");
    expect(shell).toContain('localStorage.getItem("friday.sidebar.collapsed")');
  });

  it("keeps the nav from navigation.ts, the scroll restore and one shell", () => {
    expect(shell).toContain("NAV_GROUPS.map((group) =>");
    expect(shell).toContain("savedSidebarScroll = event.currentTarget.scrollTop;");
    expect(shell).toContain("if (inShell) return <AppShellPage {...props} />;");
    expect(shell).toContain('aria-current={active ? "page" : undefined}');
    expect(shell).toContain('className="nav-active-bar"');
  });

  it("gives every page one header with its sidebar icon, a Flow button and a page-enter", () => {
    expect(shell).toContain("function pageNav(pathname: string)");
    expect(shell).toContain('<nav.icon className="size-4" />');
    expect(shell).toMatch(/<Workflow className="size-3\.5" \/>\s*Flow/);
    expect(shell).toContain('<div key={pathname} className="page-enter min-w-0">');
    expect(shell).toContain('"overflow-y-auto overflow-x-hidden"');
  });

  it("keeps the title strip as the only drag region with its window controls", () => {
    expect(strip).toContain('WebkitAppRegion: "drag"');
    expect(strip).toContain('WebkitAppRegion: "no-drag"');
    expect(strip).toContain('aria-label="Minimize FRIDAY"');
    expect(strip).toContain('aria-label="Close FRIDAY"');
    expect(strip).toContain("<FridayOrb size={18}");
  });
});

describe("chat and voice levels use the FRIDAY Glass tokens", () => {
  it("takes blur strength from Glass depth and the Blur switch", () => {
    const css = read("src/styles.css");
    expect(css.match(/blur\(var\(--friday-glass-blur, 12px\)\) saturate\(1\.1\)/g)).toHaveLength(2);
    expect(css).not.toContain("blur(12px) saturate(1.1)");
    expect(css).toContain("html.no-blur .friday-chat-full,");
  });

  it("gives the size switches and voice HUD buttons the shared button states", () => {
    expect(read("src/components/friday/ChatToolbar.tsx")).toContain('"friday-btn h-6 min-w-6');
    const voice = read("src/components/friday/VoiceControlBar.tsx");
    expect(voice).toContain('"voice-btn friday-btn inline-flex');
    expect(voice).toContain('"friday-btn px-2 transition-colors');
  });
});
