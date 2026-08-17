export interface RewrittenParams {
  readonly sql: string;
  readonly names: readonly string[];
}

const identStart = /[A-Za-z_]/;
const ident = /[A-Za-z0-9_]/;

function dollarTagAt(input: string, index: number): string | undefined {
  return input.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
}

function escapedStringAt(input: string, quoteIndex: number): boolean {
  if (input[quoteIndex] !== "'") return false;
  const prefix = input[quoteIndex - 1];
  if (prefix !== "e" && prefix !== "E") return false;
  const before = input[quoteIndex - 2];
  return before === undefined || !/[A-Za-z0-9_$]/.test(before);
}

/**
 * Remove XQL's structural markers while preserving quoted SQL bytes. Marker
 * delimiters inside a string, identifier, dollar quote, or comment are data.
 */
export function stripXqlMarkers(input: string): string {
  let out = "";
  let i = 0;
  let markerDepth = 0;
  let blockCommentDepth = 0;

  while (i < input.length) {
    if (blockCommentDepth > 0) {
      if (input.startsWith("/*", i)) {
        blockCommentDepth++;
        out += "/*";
        i += 2;
        continue;
      }
      if (input.startsWith("*/", i)) {
        blockCommentDepth--;
        out += "*/";
        i += 2;
        continue;
      }
      out += input[i]!;
      i++;
      continue;
    }

    if (input.startsWith("/*", i)) {
      blockCommentDepth = 1;
      out += "/*";
      i += 2;
      continue;
    }
    if (input.startsWith("--", i)) {
      const end = input.indexOf("\n", i + 2);
      if (end === -1) return out + input.slice(i);
      out += input.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    const ch = input[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const backslashEscapes = escapedStringAt(input, i);
      out += quote;
      i++;
      while (i < input.length) {
        const q = input[i]!;
        out += q;
        i++;
        if (backslashEscapes && q === "\\" && i < input.length) {
          out += input[i]!;
          i++;
          continue;
        }
        if (q !== quote) continue;
        if (input[i] === quote) {
          out += quote;
          i++;
          continue;
        }
        break;
      }
      continue;
    }

    if (ch === "$") {
      const tag = dollarTagAt(input, i);
      if (tag) {
        const end = input.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error(`unterminated PostgreSQL dollar quote ${tag}`);
        out += input.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
    }

    const marker = input.slice(i, i + 3);
    if (marker === "«c:" || marker === "«f:" || marker === "«w:") {
      markerDepth++;
      i += 3;
      continue;
    }
    if (ch === "»" && markerDepth > 0) {
      markerDepth--;
      i++;
      continue;
    }

    out += ch;
    i++;
  }

  if (blockCommentDepth !== 0) throw new Error("unterminated PostgreSQL block comment");
  if (markerDepth !== 0) throw new Error("unterminated XQL fragment marker");
  return out;
}

/**
 * Rewrites XQL's `:name` parameters to PostgreSQL `$n` parameters without
 * touching casts, quoted strings/identifiers, dollar-quoted bodies, or comments.
 */
export function rewriteNamedParams(input: string): RewrittenParams {
  const names: string[] = [];
  const positions = new Map<string, number>();
  let out = "";
  let i = 0;
  let blockCommentDepth = 0;

  const positionFor = (name: string) => {
    const existing = positions.get(name);
    if (existing !== undefined) return existing;
    const next = names.length + 1;
    names.push(name);
    positions.set(name, next);
    return next;
  };

  while (i < input.length) {
    if (blockCommentDepth > 0) {
      if (input.startsWith("/*", i)) {
        blockCommentDepth++;
        out += "/*";
        i += 2;
        continue;
      }
      if (input.startsWith("*/", i)) {
        blockCommentDepth--;
        out += "*/";
        i += 2;
        continue;
      }
      out += input[i]!;
      i++;
      continue;
    }

    if (input.startsWith("/*", i)) {
      blockCommentDepth = 1;
      out += "/*";
      i += 2;
      continue;
    }
    if (input.startsWith("--", i)) {
      const end = input.indexOf("\n", i + 2);
      if (end === -1) {
        out += input.slice(i);
        break;
      }
      out += input.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    const ch = input[i]!;
    if (ch === "'" || ch === '"') {
      const quote = ch;
      const backslashEscapes = escapedStringAt(input, i);
      out += quote;
      i++;
      while (i < input.length) {
        const q = input[i]!;
        out += q;
        i++;
        if (backslashEscapes && q === "\\" && i < input.length) {
          out += input[i]!;
          i++;
          continue;
        }
        if (q !== quote) continue;
        if (input[i] === quote) {
          out += quote;
          i++;
          continue;
        }
        break;
      }
      continue;
    }

    if (ch === "$") {
      const rest = input.slice(i);
      const tag = dollarTagAt(input, i);
      if (tag) {
        const end = input.indexOf(tag, i + tag.length);
        if (end === -1) throw new Error(`unterminated PostgreSQL dollar quote ${tag}`);
        out += input.slice(i, end + tag.length);
        i = end + tag.length;
        continue;
      }
      if (/^\$\d+/.test(rest)) {
        throw new Error("xql() uses named parameters; positional PostgreSQL parameters like $1 are not accepted");
      }
    }

    if (ch === ":") {
      if (input[i + 1] === ":") {
        out += "::";
        i += 2;
        continue;
      }
      const first = input[i + 1];
      if (first && identStart.test(first)) {
        let j = i + 2;
        while (j < input.length && ident.test(input[j]!)) j++;
        const name = input.slice(i + 1, j);
        out += `$${positionFor(name)}`;
        i = j;
        continue;
      }
    }

    out += ch;
    i++;
  }

  if (blockCommentDepth !== 0) throw new Error("unterminated PostgreSQL block comment");
  return { sql: out, names };
}

export function bindNamedParams(
  sql: string,
  params: Readonly<Record<string, unknown>>,
): { text: string; values: unknown[] } {
  const rewritten = rewriteNamedParams(sql);
  const values = rewritten.names.map((name) => {
    if (!Object.prototype.hasOwnProperty.call(params, name))
      throw new Error(`missing value for parameter :${name}`);
    return params[name];
  });
  return { text: rewritten.sql, values };
}
