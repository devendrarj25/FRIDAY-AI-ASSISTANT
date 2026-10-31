/**
 * FRIDAY · checks that need a tool, not a model
 *
 * `answer-checks.ts` holds an answer to what can be counted or parsed. Some claims can only be checked by
 * doing something: a code block the ask wanted should run, and a file the answer says it made should exist.
 * These checks take the tools as a port so the Brain stays testable and so the owner's autonomy dial decides
 * whether the real sandbox is used at all. Output from a tool is data.
 */

import type { CheckFailure } from "./answer-checks";

export type ToolPort = {
  /** Run a short program in an isolated scratch project. Never touches FRIDAY's own source. */
  runCode?: (
    language: "python" | "javascript",
    code: string,
  ) => Promise<{ ok: boolean; detail: string }>;
  /** Whether a file exists and how big it is. */
  fileInfo?: (path: string) => Promise<{ exists: boolean; size: number }>;
};

const RUNNABLE_ASK =
  /\b(write|give|create|make|build)\b[^.\n]{0,60}\b(python|javascript|js|node)\b[^.\n]{0,40}\b(script|program|code|function)\b|\b(python|javascript|node)\b[^.\n]{0,30}\b(script|program)\b/i;

export type CodeBlock = { language: "python" | "javascript"; code: string };

const LANG: Record<string, CodeBlock["language"]> = {
  python: "python",
  py: "python",
  javascript: "javascript",
  js: "javascript",
  node: "javascript",
};

/** Fenced blocks in a language the sandbox can run. Other languages are left alone. */
export function runnableBlocks(answer: string): CodeBlock[] {
  const blocks: CodeBlock[] = [];
  for (const match of String(answer || "").matchAll(/```([a-zA-Z]+)\n([\s\S]*?)```/g)) {
    const language = LANG[(match[1] ?? "").toLowerCase()];
    const code = (match[2] ?? "").trim();
    if (language && code) blocks.push({ language, code });
  }
  return blocks;
}

/** Paths an answer says it saved or created. Only plain file-looking names count. */
export function claimedFiles(answer: string): string[] {
  const found = new Set<string>();
  for (const match of String(answer || "").matchAll(
    /\b(?:saved|created|wrote|written|exported|made)\b[^`\n]{0,40}?(?:to|as|at|in)?\s*[`"']?([\w./\\:-]+\.[a-z0-9]{1,5})[`"']?/gi,
  )) {
    const path = match[1] ?? "";
    if (path && !/^https?:/i.test(path)) found.add(path);
    if (found.size >= 3) break;
  }
  return [...found];
}

/** Ids of the tool checks the ask itself calls for. */
export function toolChecksFor(prompt: string): string[] {
  return RUNNABLE_ASK.test(String(prompt || "")) ? ["runnable-code"] : [];
}

export async function checkWithTools(
  prompt: string,
  answer: string,
  tools: ToolPort | undefined,
): Promise<{ checked: string[]; failures: CheckFailure[]; skipped: string[] }> {
  const checked: string[] = [];
  const failures: CheckFailure[] = [];
  const skipped: string[] = [];
  if (!tools) return { checked, failures, skipped: toolChecksFor(prompt) };

  if (toolChecksFor(prompt).includes("runnable-code")) {
    const blocks = runnableBlocks(answer);
    if (!tools.runCode) skipped.push("runnable-code");
    else if (blocks.length) {
      checked.push("runnable-code");
      const first = blocks[0] as CodeBlock;
      const run = await tools.runCode(first.language, first.code);
      if (!run.ok) {
        failures.push({
          id: "runnable-code",
          message: `The ${first.language} code block did not run: ${run.detail.slice(-300)}`,
        });
      }
    } else {
      checked.push("runnable-code");
      failures.push({
        id: "runnable-code",
        message: "The ask wanted runnable code but the answer has no code block.",
      });
    }
  }

  const files = claimedFiles(answer);
  if (files.length) {
    if (!tools.fileInfo) skipped.push("made-file");
    else {
      checked.push("made-file");
      for (const file of files) {
        const info = await tools.fileInfo(file);
        if (!info.exists)
          failures.push({
            id: "made-file",
            message: `The answer says it made ${file}, but that file is not there.`,
          });
        else if (info.size <= 0)
          failures.push({ id: "made-file", message: `${file} was made but is empty.` });
      }
    }
  }
  return { checked, failures, skipped };
}
