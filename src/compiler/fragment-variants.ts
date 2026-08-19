import {
  extractQueriesFromSource,
  type ExtractResult,
} from "./extract.ts";
import type { CompilerDiagnostic, ExtractedQuery } from "./types.ts";

interface Span {
  readonly start: number;
  readonly end: number;
}

interface ConditionalIdentifier extends Span {
  readonly name: string;
}

interface FragmentCall extends Span {
  readonly firstArg: Span;
  readonly condition?: ConditionalIdentifier;
}

interface Edit extends Span {
  readonly replacement: string;
}

const MAX_DYNAMIC_CONDITIONS = 6;

const isIdentStart = (c: string | undefined) =>
  c !== undefined && /[A-Za-z_$]/.test(c);
const isIdent = (c: string | undefined) =>
  c !== undefined && /[A-Za-z0-9_$]/.test(c);

function readIdentifier(text: string, start: number): Span | null {
  if (!isIdentStart(text[start])) return null;
  let end = start + 1;
  while (isIdent(text[end])) end++;
  return { start, end };
}

function quotedEnd(text: string, start: number, quote: "'" | '"'): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i++;
  }
  return text.length;
}

function lineCommentEnd(text: string, start: number): number {
  const newline = text.indexOf("\n", start + 2);
  return newline === -1 ? text.length : newline + 1;
}

function blockCommentEnd(text: string, start: number): number {
  const end = text.indexOf("*/", start + 2);
  return end === -1 ? text.length : end + 2;
}

function balancedEnd(
  text: string,
  openIndex: number,
  open: string,
  close: string,
): number {
  let depth = 1;
  let i = openIndex + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === "'" || ch === '"') {
      i = quotedEnd(text, i, ch);
      continue;
    }
    if (ch === "`") {
      i = templateEnd(text, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i = lineCommentEnd(text, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = blockCommentEnd(text, i);
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return text.length;
}

function templateEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "`") return i + 1;
    if (text[i] === "$" && text[i + 1] === "{") {
      i = balancedEnd(text, i + 1, "{", "}");
      continue;
    }
    i++;
  }
  return text.length;
}

function skipNonCode(text: string, start: number): number | null {
  const ch = text[start];
  if (ch === "'" || ch === '"') return quotedEnd(text, start, ch);
  if (ch === "`") return templateEnd(text, start);
  if (ch === "/" && text[start + 1] === "/") return lineCommentEnd(text, start);
  if (ch === "/" && text[start + 1] === "*") return blockCommentEnd(text, start);
  return null;
}

function skipWhitespace(text: string, start: number): number {
  let i = start;
  while (/\s/.test(text[i] ?? "")) i++;
  return i;
}

function trimSpan(text: string, span: Span): Span {
  let start = span.start;
  let end = span.end;
  while (start < end && /\s/.test(text[start]!)) start++;
  while (end > start && /\s/.test(text[end - 1]!)) end--;
  return { start, end };
}

function firstArgument(text: string, open: number, close: number): Span | null {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let i = open + 1;
  while (i < close - 1) {
    const skipped = skipNonCode(text, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    const ch = text[i]!;
    if (ch === "(") paren++;
    else if (ch === ")") paren--;
    else if (ch === "[") bracket++;
    else if (ch === "]") bracket--;
    else if (ch === "{") brace++;
    else if (ch === "}") brace--;
    else if (ch === "," && paren === 0 && bracket === 0 && brace === 0)
      return trimSpan(text, { start: open + 1, end: i });
    i++;
  }
  return trimSpan(text, { start: open + 1, end: close - 1 });
}

function conditionBefore(text: string, callStart: number): ConditionalIdentifier | undefined {
  let i = callStart - 1;
  while (i >= 0 && /\s/.test(text[i]!)) i--;
  if (i < 1 || text[i] !== "&" || text[i - 1] !== "&") return undefined;
  i -= 2;
  while (i >= 0 && /\s/.test(text[i]!)) i--;
  const end = i + 1;
  while (i >= 0 && isIdent(text[i])) i--;
  const start = i + 1;
  if (start === end || !isIdentStart(text[start])) return undefined;
  const name = text.slice(start, end);
  const before = text[i];
  if (before !== undefined && (isIdent(before) || before === "." || before === "!"))
    return undefined;
  return { name, start, end };
}

function scanTemplateExpressions(
  text: string,
  start: number,
  end: number,
  helperNames: ReadonlySet<string>,
  calls: FragmentCall[],
): number {
  let i = start + 1;
  while (i < end) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === "`") return i + 1;
    if (text[i] === "$" && text[i + 1] === "{") {
      const expressionEnd = balancedEnd(text, i + 1, "{", "}");
      scanCode(text, i + 2, expressionEnd - 1, helperNames, calls);
      i = expressionEnd;
      continue;
    }
    i++;
  }
  return end;
}

function scanCode(
  text: string,
  start: number,
  end: number,
  helperNames: ReadonlySet<string>,
  calls: FragmentCall[],
): void {
  let i = start;
  while (i < end) {
    const ch = text[i];
    if (ch === "`") {
      i = scanTemplateExpressions(text, i, end, helperNames, calls);
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = quotedEnd(text, i, ch);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i = lineCommentEnd(text, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i = blockCommentEnd(text, i);
      continue;
    }

    const owner = readIdentifier(text, i);
    if (owner === null) {
      i++;
      continue;
    }
    const ownerName = text.slice(owner.start, owner.end);
    i = owner.end;
    if (!helperNames.has(ownerName)) continue;

    let cursor = skipWhitespace(text, owner.end);
    if (text[cursor] !== ".") continue;
    cursor = skipWhitespace(text, cursor + 1);
    const method = readIdentifier(text, cursor);
    if (method === null || text.slice(method.start, method.end) !== "fragment") continue;
    cursor = skipWhitespace(text, method.end);
    if (text[cursor] !== "(") continue;
    const close = balancedEnd(text, cursor, "(", ")");
    if (close <= cursor + 1) continue;
    const arg = firstArgument(text, cursor, close);
    if (arg === null || arg.start === arg.end) continue;
    const condition = conditionBefore(text, owner.start);
    calls.push({
      start: owner.start,
      end: close,
      firstArg: arg,
      ...(condition === undefined ? {} : { condition }),
    });
    i = close;
  }
}

function findFragmentCalls(
  text: string,
  helperNames: ReadonlySet<string>,
): FragmentCall[] {
  const calls: FragmentCall[] = [];
  scanCode(text, 0, text.length, helperNames, calls);
  return calls;
}

function applyEdits(text: string, edits: readonly Edit[]): string {
  let out = text;
  for (const edit of [...edits].sort((a, b) => b.start - a.start))
    out = out.slice(0, edit.start) + edit.replacement + out.slice(edit.end);
  return out;
}

function queryKey(query: ExtractedQuery): string {
  return `${query.file}\0${query.line}\0${query.column}\0${query.source}`;
}

function diagnosticAt(
  diagnostic: CompilerDiagnostic,
  result: ExtractResult,
): boolean {
  return result.diagnostics.some((candidate) =>
    candidate.code === "XQL_DYNAMIC_SOURCE"
    && candidate.file === diagnostic.file
    && candidate.line === diagnostic.line
    && candidate.column === diagnostic.column
  );
}

/**
 * A runtime boolean guarding xql.fragment() is not arbitrary dynamic SQL: it
 * creates a finite set of query shapes. Enumerate those shapes by substituting
 * each direct boolean guard with true/false, while replacing fragment(sql,
 * params) with its SQL argument, then feed every variant through the normal
 * static extractor. Genuinely dynamic interpolation remains fail-closed.
 */
export function extractQueriesWithFragmentVariants(
  text: string,
  fileName = "source.ts",
  calleeNames: readonly string[] = ["xql"],
): ExtractResult {
  const base = extractQueriesFromSource(text, fileName, calleeNames);
  const calls = findFragmentCalls(text, new Set(calleeNames));
  if (calls.length === 0) return base;

  const conditionNames = [...new Set(
    calls
      .map((call) => call.condition?.name)
      .filter((name): name is string =>
        name !== undefined && name !== "true" && name !== "false"
      ),
  )];
  if (conditionNames.length > MAX_DYNAMIC_CONDITIONS) return base;

  const variants: ExtractResult[] = [];
  const combinations = 1 << conditionNames.length;
  for (let mask = 0; mask < combinations; mask++) {
    const values = new Map<string, boolean>();
    conditionNames.forEach((name, index) => values.set(name, (mask & (1 << index)) !== 0));

    const edits: Edit[] = calls.map((call) => ({
      start: call.start,
      end: call.end,
      replacement: `(${text.slice(call.firstArg.start, call.firstArg.end)})`,
    }));
    for (const call of calls) {
      const condition = call.condition;
      if (condition === undefined) continue;
      const value = values.get(condition.name);
      if (value === undefined) continue;
      edits.push({
        start: condition.start,
        end: condition.end,
        replacement: value ? "true" : "false",
      });
    }
    variants.push(extractQueriesFromSource(
      applyEdits(text, edits),
      fileName,
      calleeNames,
    ));
  }

  const queries = new Map<string, ExtractedQuery>();
  for (const query of base.queries) queries.set(queryKey(query), query);
  for (const variant of variants)
    for (const query of variant.queries) queries.set(queryKey(query), query);

  const diagnostics = base.diagnostics.filter((diagnostic) => {
    if (diagnostic.code !== "XQL_DYNAMIC_SOURCE") return true;
    return !variants.every((variant) => !diagnosticAt(diagnostic, variant));
  });

  return { queries: [...queries.values()], diagnostics };
}
