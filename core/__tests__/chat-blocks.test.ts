/**
 * Chat message blocks: fenced code is split out of plain text so the chat can
 * give it a Copy button. No markdown library, plain text stays plain.
 */
import { describe, expect, it } from "vitest";
import { splitChatBlocks } from "../../src/lib/friday/chat-blocks";

describe("splitChatBlocks", () => {
  it("returns nothing for empty text and one text block for prose", () => {
    expect(splitChatBlocks("")).toEqual([]);
    expect(splitChatBlocks("Hello, sir.\nAll systems nominal.")).toEqual([
      { kind: "text", text: "Hello, sir.\nAll systems nominal." },
    ]);
  });

  it("splits a fenced block with its language between prose", () => {
    const blocks = splitChatBlocks("Run this:\n```bash\nnpm ci\nnpm test\n```\nThen report.");
    expect(blocks).toEqual([
      { kind: "text", text: "Run this:" },
      { kind: "code", lang: "bash", code: "npm ci\nnpm test", closed: true },
      { kind: "text", text: "Then report." },
    ]);
  });

  it("accepts tilde fences and a fence with no language", () => {
    expect(splitChatBlocks("~~~\nx = 1\n~~~")).toEqual([
      { kind: "code", lang: "", code: "x = 1", closed: true },
    ]);
    expect(splitChatBlocks("```\n\n```")).toEqual([
      { kind: "code", lang: "", code: "", closed: true },
    ]);
  });

  it("runs an unclosed fence (a streaming reply) to the end", () => {
    expect(splitChatBlocks("Here:\n```ts\nconst a = 1;\nconst b")).toEqual([
      { kind: "text", text: "Here:" },
      { kind: "code", lang: "ts", code: "const a = 1;\nconst b", closed: false },
    ]);
  });

  it("keeps shorter or different fences inside a longer one (nested backticks)", () => {
    const text = "````md\nUse:\n```js\nlog()\n```\n~~~\n````\nafter";
    expect(splitChatBlocks(text)).toEqual([
      { kind: "code", lang: "md", code: "Use:\n```js\nlog()\n```\n~~~", closed: true },
      { kind: "text", text: "after" },
    ]);
  });

  it("leaves inline backticks and a backtick info string as prose", () => {
    expect(splitChatBlocks("Use `npm ci` and ``a`` here.")).toEqual([
      { kind: "text", text: "Use `npm ci` and ``a`` here." },
    ]);
    expect(splitChatBlocks("```not`a fence")).toEqual([{ kind: "text", text: "```not`a fence" }]);
  });

  it("handles very long text in one linear pass", () => {
    const chunk = "line of prose\n```py\nprint(1)\n```\n";
    const text = chunk.repeat(5000);
    const blocks = splitChatBlocks(text);
    expect(blocks.filter((b) => b.kind === "code")).toHaveLength(5000);
    expect(blocks.filter((b) => b.kind === "text")).toHaveLength(5000);
    const huge = splitChatBlocks(`\`\`\`\n${"x".repeat(200_000)}`);
    expect(huge).toHaveLength(1);
    expect(huge[0]).toMatchObject({ kind: "code", closed: false });
  });
});
