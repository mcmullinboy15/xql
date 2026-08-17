import type { CompilerDiagnostic, ExtractedQuery } from "./types.ts";

export interface ExtractResult {
  readonly queries: readonly ExtractedQuery[];
  readonly diagnostics: readonly CompilerDiagnostic[];
}

interface Span {
  readonly start: number;
  readonly end: number;
}

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

function lineCommentEnd(text: string, start: number): number {
  const newline = text.indexOf("\n", start + 2);
  return newline === -1 ? text.length : newline + 1;
}

function blockCommentEnd(text: string, start: number): number {
  const end = text.indexOf("*/", start + 2);
  return end === -1 ? text.length : end + 2;
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

function skipTrivia(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    if (/\s/.test(text[i]!)) {
      i++;
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "/") {
      i = lineCommentEnd(text, i);
      continue;
    }
    if (text[i] === "/" && text[i + 1] === "*") {
      i = blockCommentEnd(text, i);
      continue;
    }
    break;
  }
  return i;
}

function skipNonCode(text: string, start: number): number | null {
  const ch = text[start];
  if (ch === "'" || ch === '"') return quotedEnd(text, start, ch);
  if (ch === "`") return templateEnd(text, start);
  if (ch === "/" && text[start + 1] === "/") return lineCommentEnd(text, start);
  if (ch === "/" && text[start + 1] === "*") return blockCommentEnd(text, start);
  return null;
}

function expressionEnd(text: string, start: number): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let i = start;
  while (i < text.length) {
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
    else if ((ch === ";" || ch === ",") && paren === 0 && bracket === 0 && brace === 0)
      return i;
    else if (ch === "\n" && paren === 0 && bracket === 0 && brace === 0) {
      const next = skipTrivia(text, i + 1);
      const id = readIdentifier(text, next);
      if (id !== null && ["const", "let", "var", "export", "import", "function", "class"].includes(text.slice(id.start, id.end)))
        return i;
    }
    i++;
  }
  return text.length;
}

function collectDeclarations(text: string): Map<string, string> {
  const declarations = new Map<string, string>();
  let i = 0;
  while (i < text.length) {
    const skipped = skipNonCode(text, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    const id = readIdentifier(text, i);
    if (id === null) {
      i++;
      continue;
    }
    const token = text.slice(id.start, id.end);
    i = id.end;
    if (token !== "const") continue;

    let cursor = skipTrivia(text, i);
    const name = readIdentifier(text, cursor);
    if (name === null) continue;
    const variableName = text.slice(name.start, name.end);
    cursor = name.end;

    let paren = 0;
    let bracket = 0;
    let brace = 0;
    let equals = -1;
    while (cursor < text.length) {
      const nonCode = skipNonCode(text, cursor);
      if (nonCode !== null) {
        cursor = nonCode;
        continue;
      }
      const ch = text[cursor]!;
      if (ch === "(") paren++;
      else if (ch === ")") paren--;
      else if (ch === "[") bracket++;
      else if (ch === "]") bracket--;
      else if (ch === "{") brace++;
      else if (ch === "}") brace--;
      else if (ch === "=" && paren === 0 && bracket === 0 && brace === 0) {
        equals = cursor;
        break;
      } else if ((ch === ";" || ch === "\n") && paren === 0 && bracket === 0 && brace === 0) {
        break;
      }
      cursor++;
    }
    if (equals === -1) continue;
    const start = skipTrivia(text, equals + 1);
    const end = expressionEnd(text, start);
    declarations.set(variableName, text.slice(start, end).trim());
    i = end;
  }
  return declarations;
}

function stripTrailingAssertions(expression: string): string {
  let out = expression.trim();
  while (/\s+as\s+const\s*$/.test(out)) out = out.replace(/\s+as\s+const\s*$/, "").trim();
  return out;
}

function outerParens(expression: string): string | null {
  if (!expression.startsWith("(")) return null;
  const end = balancedEnd(expression, 0, "(", ")");
  return end === expression.length ? expression.slice(1, -1) : null;
}

function decodeEscapes(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = raw[++i];
    if (next === undefined) return out + "\\";
    if (next === "\n") continue;
    if (next === "\r") {
      if (raw[i + 1] === "\n") i++;
      continue;
    }
    const simple: Record<string, string> = {
      n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v",
      "0": "\0", "\\": "\\", "'": "'", '"': '"', "`": "`", "$": "$",
    };
    if (simple[next] !== undefined) {
      out += simple[next];
      continue;
    }
    if (next === "x") {
      const hex = raw.slice(i + 1, i + 3);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        out += String.fromCharCode(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    if (next === "u") {
      if (raw[i + 1] === "{") {
        const close = raw.indexOf("}", i + 2);
        const hex = close === -1 ? "" : raw.slice(i + 2, close);
        if (/^[0-9A-Fa-f]+$/.test(hex)) {
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i = close;
          continue;
        }
      } else {
        const hex = raw.slice(i + 1, i + 5);
        if (/^[0-9A-Fa-f]{4}$/.test(hex)) {
          out += String.fromCharCode(Number.parseInt(hex, 16));
          i += 4;
          continue;
        }
      }
    }
    out += next;
  }
  return out;
}

function splitTopLevel(text: string, delimiter: string): string[] {
  const out: string[] = [];
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let start = 0;
  let i = 0;
  while (i < text.length) {
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
    if (paren === 0 && bracket === 0 && brace === 0 && text.startsWith(delimiter, i)) {
      out.push(text.slice(start, i));
      i += delimiter.length;
      start = i;
      continue;
    }
    i++;
  }
  out.push(text.slice(start));
  return out;
}

function findTopLevelOperator(text: string, operator: string): number {
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  let i = 0;
  while (i < text.length) {
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
    else if (paren === 0 && bracket === 0 && brace === 0 && text.startsWith(operator, i))
      return i;
    i++;
  }
  return -1;
}

function parseTemplate(
  expression: string,
  resolve: (expression: string) => string | null,
): string | null {
  if (!expression.startsWith("`") || templateEnd(expression, 0) !== expression.length) return null;
  let out = "";
  let rawStart = 1;
  let i = 1;
  while (i < expression.length - 1) {
    if (expression[i] === "\\") {
      i += 2;
      continue;
    }
    if (expression[i] === "$" && expression[i + 1] === "{") {
      out += decodeEscapes(expression.slice(rawStart, i));
      const end = balancedEnd(expression, i + 1, "{", "}");
      if (end > expression.length) return null;
      const inner = expression.slice(i + 2, end - 1);
      const value = resolve(inner);
      if (value === null) return null;
      out += value;
      i = end;
      rawStart = i;
      continue;
    }
    i++;
  }
  out += decodeEscapes(expression.slice(rawStart, -1));
  return out;
}

function parseCall(expression: string): { callee: string; args: string[] } | null {
  let open = -1;
  for (let i = 0; i < expression.length; i++) {
    const skipped = skipNonCode(expression, i);
    if (skipped !== null) {
      i = skipped - 1;
      continue;
    }
    if (expression[i] === "(") {
      open = i;
      break;
    }
  }
  if (open === -1) return null;
  const end = balancedEnd(expression, open, "(", ")");
  if (end !== expression.length) return null;
  return {
    callee: expression.slice(0, open).replace(/\s+/g, "").trim(),
    args: splitTopLevel(expression.slice(open + 1, -1), ",").map((arg) => arg.trim()),
  };
}

function isFalsyExpression(expression: string): boolean {
  const value = expression.trim();
  return value === "false" || value === "null" || value === "undefined" || value === "0" ||
    value === "0n" || value === "''" || value === '""' || value === "``";
}

function makeResolver(
  declarations: ReadonlyMap<string, string>,
  helperNames: ReadonlySet<string>,
): (expression: string) => string | null {
  const cache = new Map<string, string | null>();
  const resolving = new Set<string>();

  const resolveIdentifier = (name: string): string | null => {
    if (cache.has(name)) return cache.get(name) ?? null;
    const expression = declarations.get(name);
    if (expression === undefined || resolving.has(name)) return null;
    resolving.add(name);
    const value = resolve(expression);
    resolving.delete(name);
    cache.set(name, value);
    return value;
  };

  const resolve = (sourceExpression: string): string | null => {
    const expression = stripTrailingAssertions(sourceExpression);
    if (expression === "") return "";

    const wrapped = outerParens(expression);
    if (wrapped !== null) return resolve(wrapped);

    if ((expression.startsWith("'") && quotedEnd(expression, 0, "'") === expression.length) ||
        (expression.startsWith('"') && quotedEnd(expression, 0, '"') === expression.length))
      return decodeEscapes(expression.slice(1, -1));

    if (expression.startsWith("`")) {
      const template = parseTemplate(expression, resolve);
      if (template !== null) return template;
    }

    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expression)) {
      if (expression === "true") return "true";
      if (isFalsyExpression(expression)) return "";
      return resolveIdentifier(expression);
    }
    if (/^-?(?:\d+(?:\.\d+)?|\d+n)$/.test(expression)) return expression;

    const andAt = findTopLevelOperator(expression, "&&");
    if (andAt !== -1) {
      const left = expression.slice(0, andAt).trim();
      const right = expression.slice(andAt + 2);
      if (isFalsyExpression(left)) return "";
      if (left === "true") return resolve(right);
      return null;
    }

    const plusAt = findTopLevelOperator(expression, "+");
    if (plusAt !== -1) {
      const left = resolve(expression.slice(0, plusAt));
      const right = resolve(expression.slice(plusAt + 1));
      return left === null || right === null ? null : left + right;
    }

    const call = parseCall(expression);
    if (call !== null) {
      const dot = call.callee.indexOf(".");
      if (dot !== -1) {
        const owner = call.callee.slice(0, dot);
        const method = call.callee.slice(dot + 1);
        if (helperNames.has(owner) && ["cols", "from", "where"].includes(method) && call.args.length === 1) {
          const value = resolve(call.args[0]!);
          if (value === null) return null;
          const marker = method === "cols" ? "c" : method === "from" ? "f" : "w";
          return `«${marker}:${value}»`;
        }
        if (helperNames.has(owner) && (method === "and" || method === "or")) {
          const parts: string[] = [];
          for (const arg of call.args) {
            if (arg === "" || isFalsyExpression(arg)) continue;
            const value = resolve(arg);
            if (value === null) return null;
            if (value.trim() !== "") parts.push(`(${value})`);
          }
          const empty = method === "and" ? "true" : "false";
          return `«w:${parts.length === 0 ? empty : parts.join(` ${method} `)}»`;
        }
      }
    }

    return null;
  };

  return resolve;
}

function directCalls(text: string, names: ReadonlySet<string>): Array<{ arg: Span }> {
  const calls: Array<{ arg: Span }> = [];
  let i = 0;
  while (i < text.length) {
    const skipped = skipNonCode(text, i);
    if (skipped !== null) {
      i = skipped;
      continue;
    }
    const id = readIdentifier(text, i);
    if (id === null) {
      i++;
      continue;
    }
    const name = text.slice(id.start, id.end);
    i = id.end;
    if (!names.has(name)) continue;
    if (id.start > 0 && (isIdent(text[id.start - 1]) || text[id.start - 1] === ".")) continue;
    const open = skipTrivia(text, id.end);
    if (text[open] !== "(") continue;
    const close = balancedEnd(text, open, "(", ")");
    if (close <= open + 1) continue;
    const inner = text.slice(open + 1, close - 1);
    const first = splitTopLevel(inner, ",")[0];
    if (first === undefined) continue;
    const leading = first.length - first.trimStart().length;
    const start = open + 1 + leading;
    calls.push({ arg: { start, end: start + first.trim().length } });
    i = close;
  }
  return calls;
}

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let i = 0; i < offset; i++) {
    if (text[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}

/**
 * Extracts statically-computable XQL calls without depending on TypeScript's
 * in-process compiler API. TypeScript 7's native compiler intentionally does
 * not expose the old JavaScript compiler API surface, so XQL keeps this reader
 * narrow: it understands string/template composition and XQL's own fragment
 * helpers, while PostgreSQL syntax is still parsed only by PostgreSQL.
 */
export function extractQueriesFromSource(
  text: string,
  fileName = "source.ts",
  calleeNames: readonly string[] = ["xql"],
): ExtractResult {
  const names = new Set(calleeNames);
  const declarations = collectDeclarations(text);
  const resolve = makeResolver(declarations, names);
  const queries: ExtractedQuery[] = [];
  const diagnostics: CompilerDiagnostic[] = [];

  for (const call of directCalls(text, names)) {
    const expression = text.slice(call.arg.start, call.arg.end);
    const value = resolve(expression);
    const position = lineAndColumn(text, call.arg.start);
    if (value === null) {
      diagnostics.push({
        code: "XQL_DYNAMIC_SOURCE",
        message: "XQL compiler cannot precompile this query because a template interpolation is runtime-dynamic. Keep it on the legacy type-level path or make the fragment static.",
        file: fileName,
        line: position.line,
        column: position.column,
      });
    } else {
      queries.push({
        source: value,
        file: fileName,
        line: position.line,
        column: position.column,
      });
    }
  }

  return { queries, diagnostics };
}
