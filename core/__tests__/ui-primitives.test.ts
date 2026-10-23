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
  SegmentedControl,
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
    // A known title gets its icon from the vocabulary; an unknown one keeps the dot.
    expect(plain).toMatch(/<svg[^>]*aria-hidden="true"[^>]*>.*?<\/svg><h2/);
    const unknown = html(createElement(HudPanel, { title: "Zebra", children: "z" }));
    expect(unknown).toContain("shadow-[0_0_10px_2px_var(--color-primary)]");
    expect(unknown).not.toContain("<svg");
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

describe("every text button gets an icon from one vocabulary", () => {
  it("adds the icon only to plain-text buttons, never a second one", async () => {
    const { Button } = await import("../../src/components/ui/button");
    const { Plus } = await import("lucide-react");
    const auto = html(createElement(Button, null, "Refresh now"));
    expect(auto).toMatch(
      /<svg[^>]*class="[^"]*friday-auto-icon[^"]*"[^>]*>.*<\/svg>Refresh now<\/button>/,
    );
    expect(auto).toContain('aria-hidden="true"');
    // Expression children resolve to text too: {busy ? "Saving…" : "Save"}.
    expect(html(createElement(Button, null, "Install ", "llama3"))).toContain("friday-auto-icon");
    // Already has an icon, is icon-sized, opted out, a link, or an unknown word.
    expect(html(createElement(Button, null, createElement(Plus), "Add"))).not.toContain(
      "friday-auto-icon",
    );
    expect(html(createElement(Button, { size: "icon", "aria-label": "Add" }, "+"))).not.toContain(
      "friday-auto-icon",
    );
    expect(html(createElement(Button, { "data-no-icon": "" } as never, "Install"))).not.toContain(
      "friday-auto-icon",
    );
    expect(
      html(createElement(Button, { asChild: true }, createElement("a", { href: "/x" }, "Open"))),
    ).not.toContain("friday-auto-icon");
    expect(html(createElement(Button, null, "Mermaid-ish thing"))).not.toContain(
      "friday-auto-icon",
    );
  });

  it("knows the verbs the app actually uses", async () => {
    const { iconForLabel, leadingVerb, BUTTON_VERB_COUNT } =
      await import("../../src/components/friday/button-icons");
    expect(leadingVerb("  Install llama3 ")).toBe("install");
    expect(leadingVerb("YES · run it")).toBe("yes");
    for (const label of [
      "Open full",
      "Cancel",
      "Ask FRIDAY",
      "Clear all",
      "Allow once",
      "Add folder",
      "Deny",
      "Save chat",
      "Install",
      "Reset appearance",
      "Refresh now",
      "Export as JSON",
      "Approve",
      "Delete",
      "Stop",
      "Run",
      "Verify",
      "Test",
      "Copy",
    ]) {
      expect(iconForLabel(label), label).not.toBeNull();
    }
    expect(iconForLabel("")).toBeNull();
    expect(iconForLabel("constructor")).toBeNull();
    expect(BUTTON_VERB_COUNT).toBeGreaterThan(100);
  });
});

describe("panel headers get an icon from the title vocabulary", () => {
  it("matches the titles the pages use", async () => {
    const { iconForTitle } = await import("../../src/components/friday/button-icons");
    for (const title of [
      "Memory tiers",
      "Cloud models",
      "Active Agents",
      "Waiting for your approval",
      "Backup & Restore",
      "Voice & Wake Word",
      "Hardware Overview",
      "Brain log",
      "Connected repositories",
      "Appearance",
    ]) {
      expect(iconForTitle(title), title).not.toBeNull();
    }
    expect(iconForTitle("Zebra")).toBeNull();
  });
});

describe("responsive, motion and performance contracts", () => {
  const css = read("src/styles.css");

  it("adds no timers, frame loops or polling in the design layer", () => {
    for (const file of [
      "src/components/friday/ui.tsx",
      "src/components/friday/button-icons.ts",
      "src/components/ui/button.tsx",
      "src/lib/friday/appearance.ts",
      "src/components/friday/settings/AppearanceSettings.tsx",
    ]) {
      const text = read(file);
      expect(text, file).not.toContain("setInterval");
      expect(text, file).not.toContain("requestAnimationFrame");
    }
  });

  it("animates only transform and opacity, and Reduce motion makes it instant", () => {
    const keyframes = [
      ...css.matchAll(/@keyframes (friday-(?:mode-enter|nav-bar)) \{([\s\S]*?)\n\}/g),
    ];
    expect(keyframes.length).toBe(2);
    for (const [, name, body] of keyframes) {
      const props = [...(body ?? "").matchAll(/^\s*([a-z-]+):/gm)].map((m) => m[1]);
      expect(
        props.every((p) => p === "transform" || p === "opacity"),
        name,
      ).toBe(true);
    }
    expect(css).toMatch(
      /html\.no-motion \*,\s*html\.no-motion \*::before,\s*html\.no-motion \*::after \{[\s\S]*?transition-duration: 0\.001ms !important;/,
    );
    expect(css).toContain("html.no-motion .page-enter {\n  animation: none;\n}");
    expect(css).toContain("html.no-motion .nav-active-bar {\n  animation: none;\n}");
  });

  it("keeps blur switchable and off the animated graphic panels", () => {
    expect(css).toContain("@utility glass-backdrop-blur {");
    expect(css).toContain(
      'html.no-blur [class*="backdrop-blur"] { backdrop-filter: none !important; }',
    );
    // The Auto stage and the Manual graphic panel are translucent, never blurred.
    expect(read("src/components/friday/AutoMode.tsx")).toContain(
      '"hud-panel relative flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg"',
    );
    expect(read("src/routes/index.tsx")).toContain(
      '"hud-panel relative min-h-0 flex-1 overflow-hidden rounded-lg rounded-b-none border-b-0"',
    );
    expect(css).not.toMatch(/\.hud-panel[^{]*\{[^}]*backdrop-filter/);
  });

  it("keeps the app inside the no-drag region with the cursor rules", () => {
    expect(css).toContain(".friday-interactive-region button:disabled,");
    expect(css).toMatch(/\.friday-interactive-region button:disabled,[\s\S]*?cursor: not-allowed;/);
    expect(css).toContain(".friday-select-text,\n.friday-select-text * {\n  cursor: text;");
    expect(css).toContain("caret-color: transparent;");
    expect(read("src/components/friday/AppShell.tsx")).toContain(
      'className="friday-interactive-region flex min-h-0 flex-1"',
    );
  });
});

describe("Windows transparency setting", () => {
  it("turns glass solid and switches blur off under prefers-reduced-transparency", () => {
    const css = read("src/styles.css");
    const block = css.slice(css.indexOf("@media (prefers-reduced-transparency: reduce) {"));
    expect(block).toContain('html[data-ui-style="glass"] .hud-panel,');
    expect(block).toContain("background: var(--color-card);");
    expect(block).toContain('[class*="backdrop-blur"],');
    expect(block).toContain("backdrop-filter: none !important;");
  });
});

describe("iOS segmented control, switch and chips", () => {
  it("FilterTabs and SectionTabs keep their tab roles and gain the sliding thumb", () => {
    const filter = html(
      createElement(FilterTabs, {
        tabs: [
          { key: "a", label: "All" },
          { key: "b", label: "Live" },
        ],
        value: "a",
        onChange: () => undefined,
      }),
    );
    expect(filter).toContain('role="tablist"');
    expect(filter).toContain("friday-seg");
    expect(filter).toContain('class="friday-seg-thumb"');
    expect(filter.match(/role="tab"/g)?.length).toBe(2);
    expect(filter).toContain('aria-selected="true"');
    const section = html(
      createElement(SectionTabs, {
        tabs: [{ key: "x", label: "X", count: 3 }],
        value: "x",
        onChange: () => undefined,
      }),
    );
    expect(section).toContain("friday-seg");
    expect(section).toContain("friday-seg-thumb");
  });

  it("SegmentedControl is a named group of pressed buttons", () => {
    const control = html(
      createElement(SegmentedControl, {
        label: "Corner style",
        value: "Round",
        options: [
          { id: "Round", label: "Round" },
          { id: "Sharp", label: "Sharp" },
        ],
        onChange: () => undefined,
      }),
    );
    expect(control).toContain('role="group"');
    expect(control).toContain('aria-label="Corner style"');
    expect(control).toContain('aria-pressed="true"');
    expect(control).toContain('aria-pressed="false"');
    expect(control).toContain("friday-seg-thumb");
  });

  it("ToggleRow is an iOS switch (track and thumb hooks, same role and name)", () => {
    const row = html(
      createElement(ToggleRow, { label: "Auto-sync", on: true, onToggle: () => undefined }),
    );
    expect(row).toContain('role="switch"');
    expect(row).toContain('aria-checked="true"');
    expect(row).toContain('aria-label="Auto-sync"');
    expect(row).toContain("friday-switch");
    expect(row).toContain("friday-switch-thumb");
  });

  it("status pills are capsules in glass and the button carries its variant", () => {
    expect(html(createElement(StatusPill, { label: "ready" }))).toContain("friday-chip");
    const button = read("src/components/ui/button.tsx");
    expect(button).toContain('data-variant={variant ?? "default"}');
    expect(button).toContain('data-size={size ?? "default"}');
    expect(read("src/components/ui/switch.tsx")).toContain("friday-switch-thumb");
  });
});
