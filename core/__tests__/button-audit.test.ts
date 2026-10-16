/**
 * Static control audit. There is no DOM test renderer in this tree.
 * The rules cover empty handlers, controls with no accessible name, async
 * clicks with no disabled state, and destructive actions with no confirm.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(__dirname, "../..");

function walk(dir: string): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) out.push(...walk(full));
    else if (name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function attr(node: ts.JsxOpeningLikeElement, source: ts.SourceFile, name: string) {
  return node.attributes.properties.find(
    (property) => ts.isJsxAttribute(property) && property.name.getText(source) === name,
  ) as ts.JsxAttribute | undefined;
}

function textOf(node: ts.Node | undefined, source: ts.SourceFile) {
  if (!node) return "";
  return node.getText(source);
}

function isEmptyHandler(attribute: ts.JsxAttribute | undefined, source: ts.SourceFile) {
  if (!attribute || !attribute.initializer || !ts.isJsxExpression(attribute.initializer))
    return false;
  const expr = attribute.initializer.expression;
  if (!expr) return true;
  if (expr.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(expr) && expr.getText(source) === "undefined") return true;
  if (ts.isArrowFunction(expr) && ts.isBlock(expr.body) && expr.body.statements.length === 0)
    return true;
  return false;
}

function isAsyncHandler(attribute: ts.JsxAttribute | undefined) {
  if (!attribute || !attribute.initializer || !ts.isJsxExpression(attribute.initializer))
    return false;
  const expr = attribute.initializer.expression;
  return Boolean(
    expr &&
    ts.isArrowFunction(expr) &&
    expr.modifiers?.some((mod) => mod.kind === ts.SyntaxKind.AsyncKeyword),
  );
}

function ancestorTrigger(node: ts.Node, source: ts.SourceFile) {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (ts.isJsxElement(current)) {
      const open = current.openingElement;
      const tag = open.tagName.getText(source);
      if (/Trigger$/.test(tag)) {
        const asChild = open.attributes.properties.find(
          (property) => ts.isJsxAttribute(property) && property.name.getText(source) === "asChild",
        );
        if (asChild) return true;
      }
    }
    current = current.parent;
  }
  return false;
}

function hasDisabled(node: ts.JsxOpeningLikeElement, source: ts.SourceFile) {
  return Boolean(attr(node, source, "disabled") || attr(node, source, "aria-disabled"));
}

function accessibleName(node: ts.JsxOpeningLikeElement, source: ts.SourceFile, parent: ts.Node) {
  if (attr(node, source, "aria-label") || attr(node, source, "title")) return "named";
  const labelled = attr(node, source, "aria-labelledby");
  if (labelled) return "named";
  if (ts.isJsxElement(parent)) {
    const text = parent
      .getText(source)
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (text.length > 0) return text.slice(0, 80);
  }
  return "";
}

function auditFile(file: string) {
  const text = fs.readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  const rel = path.relative(root, file).split(path.sep).join("/");
  const fileHasConfirm = /confirm|Confirm|Dialog|showMessageBox|Cancel/.test(text);

  function visit(node: ts.Node) {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tag = node.tagName.getText(source);
      if (tag === "button" || tag === "Button") {
        const click = attr(node, source, "onClick");
        const typeAttr = attr(node, source, "type");
        const typeText = textOf(typeAttr?.initializer, source).replace(/['"]/g, "");
        const parent = node.parent;
        const name = accessibleName(node, source, parent);
        const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        const where = `${rel}:${line}`;
        if (isEmptyHandler(click, source)) {
          problems.push(
            `${where} has an empty onClick. Give it a real handler or remove the control.`,
          );
        }
        if (!click && typeText !== "submit" && typeText !== "reset" && tag === "button") {
          const spread = node.attributes.properties.some((property) =>
            ts.isJsxSpreadAttribute(property),
          );
          const trigger = ancestorTrigger(node, source);
          if (!spread && !trigger) {
            problems.push(
              `${where} is a button with no onClick. Add a handler, or set type="submit" when it submits a form. A trigger with asChild already supplies the handler.`,
            );
          }
        }
        if (!name && tag === "button") {
          problems.push(`${where} has no accessible name. Add text, aria-label, or title.`);
        }
        if (isAsyncHandler(click) && !hasDisabled(node, source)) {
          problems.push(
            `${where} starts an async action with no disabled state. Disable the control while it runs so a second click cannot start it again.`,
          );
        }
        if (
          tag === "button" &&
          /^(Delete|Remove|Shutdown|Shut down)$/i.test(name) &&
          !fileHasConfirm
        ) {
          problems.push(
            `${where} is destructive and this file has no confirm. Ask before the action runs.`,
          );
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return problems;
}

describe("button audit", () => {
  it("finds no dead, unnamed, unprotected, or double-clickable controls", () => {
    const files = [
      ...walk(path.join(root, "src", "components")),
      ...walk(path.join(root, "src", "routes")),
    ];
    const problems = files.flatMap((file) => auditFile(file));
    expect(problems).toEqual([]);
  });
});
