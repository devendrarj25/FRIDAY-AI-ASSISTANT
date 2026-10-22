/**
 * FRIDAY · chat message blocks
 *
 * Splits a plain-text chat message into prose and fenced code blocks so the
 * chat can show code in its own box with a Copy button. No markdown library:
 * only CommonMark-style fences (``` or ~~~, three or more) are recognised. A
 * closing fence must use the same character and be at least as long as the
 * opening one, so a ```` fence can contain ``` lines. A fence that is never
 * closed (a reply still streaming) runs to the end of the text.
 */

export type ChatBlock =
  { kind: "text"; text: string } | { kind: "code"; lang: string; code: string; closed: boolean };

const OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;

export function splitChatBlocks(text: string): ChatBlock[] {
  if (!text) return [];
  const lines = text.split("\n");
  const blocks: ChatBlock[] = [];
  let prose: string[] = [];
  let i = 0;
  const flushProse = () => {
    const joined = prose.join("\n");
    if (joined.trim()) blocks.push({ kind: "text", text: joined });
    prose = [];
  };
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const open = OPEN.exec(line);
    if (!open) {
      prose.push(line);
      i += 1;
      continue;
    }
    const fence = open[1] ?? "```";
    const char = fence[0] ?? "`";
    const lang = (open[2] ?? "").toLowerCase();
    const body: string[] = [];
    let closed = false;
    i += 1;
    while (i < lines.length) {
      const inner = lines[i] ?? "";
      const trimmed = inner.trim();
      if (
        trimmed.length >= fence.length &&
        trimmed.split("").every((c) => c === char) &&
        /^ {0,3}\S/.test(inner)
      ) {
        closed = true;
        i += 1;
        break;
      }
      body.push(inner);
      i += 1;
    }
    flushProse();
    blocks.push({ kind: "code", lang, code: body.join("\n"), closed });
  }
  flushProse();
  return blocks;
}
