import * as ts from "typescript";
import type { SourceDiagnostic, SourceQuery } from "./types.ts";

const unsupported = Symbol("unsupported");
type StaticValue = string | false | null | undefined | typeof unsupported;

interface StaticContext {
  readonly sourceFile: ts.SourceFile;
  readonly constants: ReadonlyMap<string, ts.Expression>;
  readonly resolving: Set<string>;
  readonly xqlNames: ReadonlySet<string>;
}

function propertyCall(node: ts.CallExpression): { root: string; name: string } | null {
  if (!ts.isPropertyAccessExpression(node.expression)) return null;
  if (!ts.isIdentifier(node.expression.expression)) return null;
  return { root: node.expression.expression.text, name: node.expression.name.text };
}

function evalStatic(node: ts.Expression, context: StaticContext): StaticValue {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.UndefinedKeyword) return undefined;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (ts.isParenthesizedExpression(node)) return evalStatic(node.expression, context);

  if (ts.isIdentifier(node)) {
    if (node.text === "undefined") return undefined;
    if (context.resolving.has(node.text)) return unsupported;
    const initializer = context.constants.get(node.text);
    if (!initializer) return unsupported;
    context.resolving.add(node.text);
    const value = evalStatic(initializer, context);
    context.resolving.delete(node.text);
    return value;
  }

  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    if (node.left.kind === ts.SyntaxKind.FalseKeyword) return false;
    if (node.left.kind === ts.SyntaxKind.TrueKeyword) return evalStatic(node.right, context);
    return unsupported;
  }

  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const value = evalStatic(span.expression, context);
      if (typeof value !== "string") return unsupported;
      out += value + span.literal.text;
    }
    return out;
  }

  if (ts.isCallExpression(node)) {
    const call = propertyCall(node);
    if (!call || !context.xqlNames.has(call.root)) return unsupported;
    if (call.name === "cols" || call.name === "from" || call.name === "where") {
      const arg = node.arguments[0];
      if (!arg) return unsupported;
      const value = evalStatic(arg, context);
      if (typeof value !== "string") return unsupported;
      const marker = call.name === "cols" ? "c" : call.name === "from" ? "f" : "w";
      return `«${marker}:${value}»`;
    }
    if (call.name === "and" || call.name === "or") {
      const values = node.arguments.map((arg) => evalStatic(arg, context));
      if (values.some((value) => value === unsupported)) return unsupported;
      const kept = values.filter((value): value is string => typeof value === "string" && value !== "");
      const empty = call.name === "and" ? "true" : "false";
      const separator = call.name === "and" ? " AND " : " OR ";
      return `«w:${kept.length === 0 ? empty : kept.map((value) => `(${value})`).join(separator)}»`;
    }
  }

  return unsupported;
}

export function extractXqlQueries(
  text: string,
  file: string,
  xqlNames: readonly string[] = ["xql"],
): { queries: SourceQuery[]; diagnostics: SourceDiagnostic[] } {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const constants = new Map<string, ts.Expression>();
  const queries: SourceQuery[] = [];
  const diagnostics: SourceDiagnostic[] = [];
  const nameSet = new Set(xqlNames);

  const collect = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      node.parent.flags & ts.NodeFlags.Const
    ) constants.set(node.name.text, node.initializer);
    ts.forEachChild(node, collect);
  };
  collect(sourceFile);

  const context: StaticContext = {
    sourceFile,
    constants,
    resolving: new Set(),
    xqlNames: nameSet,
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && nameSet.has(node.expression.text)) {
      const arg = node.arguments[0];
      if (arg) {
        const position = sourceFile.getLineAndCharacterOfPosition(arg.getStart(sourceFile));
        const value = evalStatic(arg, context);
        if (typeof value === "string") {
          queries.push({
            source: value,
            file,
            line: position.line + 1,
            column: position.character + 1,
          });
        } else {
          diagnostics.push({
            file,
            line: position.line + 1,
            column: position.character + 1,
            message: "query is dynamic and cannot be compiler-materialized; XQL will use the type-level fallback",
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { queries, diagnostics };
}
