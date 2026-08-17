export interface RewrittenSql {
  readonly text: string;
  readonly names: readonly string[];
}

const isIdentStart = (c: string | undefined) =>
  c !== undefined && /[A-Za-z_]/.test(c);
const isIdent = (c: string | undefined) =>
  c !== undefined && /[A-Za-z0-9_]/.test(c);

function dollarDelimiterAt(sql: string, i: number): string | null {
  if (sql[i] !== "$") return null;
  const rest = sql.slice(i);
  const match = /^(\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/.exec(rest);
  return match?.[0] ?? null;
}

function copySingleQuoted(sql: string, start: number): { text: string; next: number } {
  let out = "'";
  let i = start + 1;
  while (i < sql.length) {
    const c = sql[i]!;
    out += c;
    i++;
    if (c !== "'") continue;
    if (sql[i] === "'") {
      out += "'";
      i++;
      continue;
    }
    break;
  }
  return { text: out, next: i };
}

function copyDoubleQuoted(sql: string, start: number): { text: string; next: number } {
  let out = '"';
  let i = start + 1;
  while (i < sql.length) {
    const c = sql[i]!;
    out += c;
    i++;
    if (c !== '"') continue;
    if (sql[i] === '"') {
      out += '"';
      i++;
      continue;
    }
    break;
  }
  return { text: out, next: i };
}

function blockCommentEnd(sql: string, start: number): number {
  let depth = 1;
  let i = start + 2;
  while (i < sql.length && depth > 0) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      depth++;
      i += 2;
    } else if (sql[i] === "*" && sql[i + 1] === "/") {
      depth--;
      i += 2;
    } else {
      i++;
    }
  }
  return i;
}

function blankExceptNewlines(text: string): string {
  return text.replace(/[^\n\r]/g, " ");
}

/**
 * Returns a same-length analysis view of SQL with comments replaced by spaces.
 * The legacy parser may tokenize this view, while execution still uses the
 * untouched source. String literals, quoted identifiers, dollar strings, XQL
 * markers, and all line breaks remain exactly where they were.
 */
export function stripSqlCommentsForAnalysis(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;

    if (ch === "'") {
      const copied = copySingleQuoted(sql, i);
      out += copied.text;
      i = copied.next;
      continue;
    }
    if (ch === '"') {
      const copied = copyDoubleQuoted(sql, i);
      out += copied.text;
      i = copied.next;
      continue;
    }
    const dollar = dollarDelimiterAt(sql, i);
    if (dollar !== null) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      const next = end + dollar.length;
      out += sql.slice(i, next);
      i = next;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      const next = end === -1 ? sql.length : end + 1;
      out += blankExceptNewlines(sql.slice(i, next));
      i = next;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = blockCommentEnd(sql, i);
      out += blankExceptNewlines(sql.slice(i, end));
      i = end;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Removes only XQL's structural fragment wrappers. Marker-looking bytes inside
 * SQL strings, quoted identifiers, dollar strings, and comments are user data
 * and are preserved byte-for-byte.
 */
export function stripXqlMarkers(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;

    if (ch === "'") {
      const copied = copySingleQuoted(sql, i);
      out += copied.text;
      i = copied.next;
      continue;
    }
    if (ch === '"') {
      const copied = copyDoubleQuoted(sql, i);
      out += copied.text;
      i = copied.next;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      if (end === -1) return out + sql.slice(i);
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = blockCommentEnd(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    const dollar = dollarDelimiterAt(sql, i);
    if (dollar !== null) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end === -1) return out + sql.slice(i);
      const next = end + dollar.length;
      out += sql.slice(i, next);
      i = next;
      continue;
    }

    if (sql.startsWith("«c:", i) || sql.startsWith("«f:", i) || sql.startsWith("«w:", i)) {
      i += 3;
      continue;
    }
    if (ch === "»") {
      i++;
      continue;
    }

    out += ch;
    i++;
  }
  return out;
}

/**
 * Rewrites XQL named parameters to PostgreSQL positional parameters without
 * changing any other byte of SQL. Colons inside strings, quoted identifiers,
 * dollar-quoted strings, line comments, block comments, and `::casts` are left
 * untouched. Repeated names reuse the same `$n` position.
 */
export function rewriteNamedParams(sql: string): RewrittenSql {
  const names: string[] = [];
  let out = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i]!;

    if (ch === "'") {
      const copied = copySingleQuoted(sql, i);
      out += copied.text;
      i = copied.next;
      continue;
    }
    if (ch === '"') {
      const copied = copyDoubleQuoted(sql, i);
      out += copied.text;
      i = copied.next;
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const end = sql.indexOf("\n", i + 2);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const end = blockCommentEnd(sql, i);
      out += sql.slice(i, end);
      i = end;
      continue;
    }
    const dollar = dollarDelimiterAt(sql, i);
    if (dollar !== null) {
      const end = sql.indexOf(dollar, i + dollar.length);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      const next = end + dollar.length;
      out += sql.slice(i, next);
      i = next;
      continue;
    }

    if (ch === ":" && sql[i + 1] === ":") {
      out += "::";
      i += 2;
      continue;
    }

    if (ch === ":" && isIdentStart(sql[i + 1])) {
      let j = i + 2;
      while (isIdent(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      let index = names.indexOf(name);
      if (index === -1) {
        names.push(name);
        index = names.length - 1;
      }
      out += `$${index + 1}`;
      i = j;
      continue;
    }

    out += ch;
    i++;
  }

  return { text: out, names };
}

export function bindNamedParams(
  sql: string,
  params: Readonly<Record<string, unknown>>,
): { text: string; values: unknown[] } {
  const rewritten = rewriteNamedParams(sql);
  for (const name of rewritten.names) {
    if (!(name in params)) throw new Error(`missing value for parameter :${name}`);
  }
  return {
    text: rewritten.text,
    values: rewritten.names.map((name) => params[name]),
  };
}
