/**
 * Reads the visible control vocabulary out of the renderer source: button and
 * link text, titles, aria-labels and `label` props. The parity test compares
 * it with core/fixtures/ui-control-baseline.json so a redesign can move a
 * control, but never lose one without an explicit rename.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

export const CONTROL_ROOTS = ["src/routes", "src/components/friday"];

export function controlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith(".tsx")) out.push(full);
    }
  };
  for (const sub of CONTROL_ROOTS) walk(join(root, sub));
  return out.sort();
}

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/** A label worth tracking: has a letter, is not a class string or a path. */
function keep(text: string): boolean {
  const t = clean(text);
  if (t.length < 2 || t.length > 120) return false;
  if (!/[A-Za-z]/.test(t)) return false;
  if (/^[/.@#]/.test(t)) return false;
  if (/^[a-z0-9:[\]/.%-]+( [a-z0-9:[\]/.%-]+){2,}$/.test(t)) return false; // tailwind-like
  return true;
}

/** Strip JSX tags and `{…}` expressions, leaving literal text. */
function literalText(children: string): string {
  let out = "";
  let depth = 0;
  let inTag = false;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (depth === 0 && !inTag && c === "<") inTag = true;
    else if (inTag && depth === 0 && c === ">") inTag = false;
    else if (c === "{") depth++;
    else if (c === "}") depth = Math.max(0, depth - 1);
    else if (!inTag && depth === 0) out += c;
  }
  return clean(out);
}

export type ControlElement = { tag: string; open: string; children: string; line: number };

/** Every <button>, <Button> and <a>/<Link> element with its opening tag. */
export function controlElements(source: string): ControlElement[] {
  const out: ControlElement[] = [];
  const re = /<(button|Button|Link|a)(\s[^]*?)?>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const tag = m[1] ?? "";
    // Opening tags span JSX attributes with `>` inside arrows; extend to the
    // first `>` at brace depth zero.
    let depth = 0;
    let end = m.index;
    for (let i = m.index; i < source.length; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0 && source[i - 1] !== "=") {
        end = i;
        break;
      }
    }
    const open = source.slice(m.index, end + 1);
    if (open.endsWith("/>")) {
      re.lastIndex = end + 1;
      continue;
    }
    const close = source.indexOf(`</${tag}>`, end + 1);
    if (close < 0) continue;
    const children = source.slice(end + 1, close);
    const line = source.slice(0, m.index).split("\n").length;
    out.push({ tag, open, children, line });
    re.lastIndex = end + 1;
  }
  return out;
}

export function controlLabels(source: string): string[] {
  const labels = new Set<string>();
  const attr =
    /\b(?:title|aria-label|label|placeholder)=(?:"([^"]+)"|\{"([^"]+)"\}|\{`([^`$]+)`\})/g;
  for (const m of source.matchAll(attr)) {
    const v = m[1] ?? m[2] ?? m[3] ?? "";
    if (keep(v)) labels.add(clean(v));
  }
  const prop = /\b(?:label|title):\s*"([^"]+)"/g;
  for (const m of source.matchAll(prop)) {
    if (keep(m[1] ?? "")) labels.add(clean(m[1] ?? ""));
  }
  // Labels chosen by an expression: title={a ? "Close" : "Open"}.
  const exprAttr = /\b(?:title|aria-label|label)=\{([^{}]*)\}/g;
  for (const m of source.matchAll(exprAttr)) {
    for (const q of (m[1] ?? "").matchAll(/"([^"]+)"/g)) {
      if (keep(q[1] ?? "")) labels.add(clean(q[1] ?? ""));
    }
  }
  for (const el of controlElements(source)) {
    const text = literalText(el.children);
    if (keep(text)) labels.add(text);
    // String literals rendered by an expression child, outside any tag.
    const bare = el.children.replace(/<[^>]*>/g, " ");
    for (const q of bare.matchAll(/"([^"]+)"/g)) {
      if (keep(q[1] ?? "")) labels.add(clean(q[1] ?? ""));
    }
  }
  return [...labels];
}

/** Icon-only: no literal text and no expression child, just tags. */
export function iconOnlyWithoutName(source: string): ControlElement[] {
  return controlElements(source).filter((el) => {
    if (el.tag === "a" || el.tag === "Link") return false;
    if (/\{\.\.\./.test(el.open)) return false; // spread props may carry the name
    if (/\b(aria-label|title|aria-labelledby)=/.test(el.open)) return false;
    if (literalText(el.children)) return false;
    // An expression child ({label}, {busy ? "x" : "y"}) renders text.
    const noTags = el.children.replace(/<[^>]*>/g, "");
    if (/\{[^}]/.test(noTags)) return false;
    return true;
  });
}

export function collectLabels(root: string): Record<string, string[]> {
  const map: Record<string, Set<string>> = {};
  for (const file of controlFiles(root)) {
    const rel = relative(root, file).replace(/\\/g, "/");
    for (const label of controlLabels(readFileSync(file, "utf8"))) {
      (map[label] ??= new Set()).add(rel);
    }
  }
  return Object.fromEntries(
    Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, [...v].sort()]),
  );
}

/**
 * Controls that cannot do anything: an empty handler, or a button with no
 * handler at all (and not a submit button, a trigger that spreads props, or
 * permanently disabled).
 */
export function deadControls(source: string): ControlElement[] {
  return controlElements(source).filter((el) => {
    if (el.tag !== "button" && el.tag !== "Button") return false;
    if (/\bon\w+=\{(?:\(\)|\(_\w*\)|\(\w+\)) => (?:\{\s*\}|undefined|void 0)\}/.test(el.open)) {
      return true;
    }
    if (/\{\.\.\./.test(el.open)) return false;
    if (/\b(asChild|disabled)\b|type="(?:submit|reset)"/.test(el.open)) return false;
    // A trigger wrapper (`<XTrigger asChild>`) supplies the handler.
    const at = source.indexOf(el.open);
    const before = source.slice(Math.max(0, at - 600), at);
    const trigger = before.lastIndexOf("asChild");
    if (trigger >= 0 && !/<\/\w*(?:Trigger|Slot)>/.test(before.slice(trigger))) return false;
    // A decorative preview is hidden from keyboards and screen readers.
    if (/aria-hidden="true"/.test(el.open)) return false;
    return !/\bon[A-Z]\w+=/.test(el.open);
  });
}
