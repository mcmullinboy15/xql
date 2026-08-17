import type { Codec, Column, SchemaDef } from "../schema.ts";
import { stripXqlMarkers } from "./bind.ts";
import { parseFrom, prepare, XqlError } from "./parse.ts";

function maskNonCode(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      out += " ";
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { out += "  "; i += 2; continue; }
        out += " ";
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      out += " ";
      i++;
      while (i < sql.length) {
        out += " ";
        if (sql[i] === '"' && sql[i + 1] === '"') { out += " "; i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      out += "  ";
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { depth++; out += "  "; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { depth--; out += "  "; i += 2; }
        else { out += sql[i] === "\n" ? "\n" : " "; i++; }
      }
      continue;
    }
    if (ch === "$") {
      const m = /^(\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/.exec(sql.slice(i));
      if (m) {
        const delim = m[0];
        const end = sql.indexOf(delim, i + delim.length);
        const next = end === -1 ? sql.length : end + delim.length;
        out += sql.slice(i, next).replace(/[^\n\r]/g, " ");
        i = next;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

function fromClause(sql: string): string | null {
  const masked = maskNonCode(sql);
  const words = [...masked.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)];
  let fromStart = -1;
  for (const match of words) {
    const at = match.index!;
    let depth = 0;
    for (let i = 0; i < at; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")") depth--;
    }
    if (depth !== 0) continue;
    const w = match[0].toLowerCase();
    if (fromStart === -1) {
      if (w === "from") fromStart = at + match[0].length;
      continue;
    }
    if (["where", "group", "order", "limit", "offset", "having", "window", "union", "intersect", "except", "for", "returning"].includes(w))
      return sql.slice(fromStart, at);
  }
  return fromStart === -1 ? null : sql.slice(fromStart);
}

function skipWs(text: string, start: number): number {
  let i = start;
  while (/\s/.test(text[i] ?? "")) i++;
  return i;
}

function readWord(text: string, start: number): { value: string; next: number } | null {
  const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(start));
  return match === null ? null : { value: match[0], next: start + match[0].length };
}

function closeParen(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function asCteColumn(zod: Codec<unknown>): Column<unknown, "cte"> {
  return {
    zod,
    sqlType: "cte",
    isNullable: false,
    nullable: () => asCteColumn(zod.nullable()),
  };
}

/**
 * Builds the same lightweight CTE pseudo-schema used by the legacy runtime
 * parser, solely so JOIN predicates can be checked against CTE outputs too.
 * PostgreSQL grammar is still not reimplemented here: each CTE body is resolved
 * by the existing legacy `prepare()` function, and compiled mode remains the
 * authoritative path for full PostgreSQL coverage.
 */
function cteMain(
  schema: SchemaDef,
  sql: string,
): { schema: SchemaDef; main: string } | null {
  const masked = maskNonCode(sql);
  let i = skipWs(masked, 0);
  const withWord = readWord(masked, i);
  if (withWord === null || withWord.value.toLowerCase() !== "with") return null;
  i = skipWs(masked, withWord.next);

  const maybeRecursive = readWord(masked, i);
  if (maybeRecursive?.value.toLowerCase() === "recursive") return null;

  let extended = schema;
  for (;;) {
    const nameToken = readWord(masked, i);
    if (nameToken === null) return null;
    const name = nameToken.value;
    i = skipWs(masked, nameToken.next);

    // CTE column alias lists are already rejected by prepareWith(). Let that
    // path own the diagnostic rather than partially interpreting them here.
    if (masked[i] === "(") return null;

    const asToken = readWord(masked, i);
    if (asToken === null || asToken.value.toLowerCase() !== "as") return null;
    i = skipWs(masked, asToken.next);

    const modifier = readWord(masked, i);
    if (modifier?.value.toLowerCase() === "materialized") {
      i = skipWs(masked, modifier.next);
    } else if (modifier?.value.toLowerCase() === "not") {
      const materialized = readWord(masked, skipWs(masked, modifier.next));
      if (materialized?.value.toLowerCase() !== "materialized") return null;
      i = skipWs(masked, materialized.next);
    }

    if (masked[i] !== "(") return null;
    const close = closeParen(masked, i);
    if (close === -1) return null;
    const body = sql.slice(i + 1, close);

    validateJoinReferences(extended, body);
    const prepared = prepare(extended, body);
    const table: Record<string, Column<unknown, string>> = {};
    for (const column of prepared.columns) table[column.name] = asCteColumn(column.zod);
    extended = { ...extended, [name]: table };

    i = skipWs(masked, close + 1);
    if (masked[i] === ",") {
      i = skipWs(masked, i + 1);
      continue;
    }
    return { schema: extended, main: sql.slice(i) };
  }
}

function validateSimpleJoinReferences(schema: SchemaDef, sql: string): void {
  const clause = fromClause(sql);
  if (clause === null || !/\bjoin\b/i.test(maskNonCode(clause))) return;
  const entries = parseFrom(clause);
  const masked = maskNonCode(clause);

  for (const match of masked.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\b/g)) {
    const alias = match[1]!;
    const column = match[2]!;
    const after = masked.slice(match.index! + match[0].length);
    if (/^\s*\(/.test(after)) continue; // schema-qualified function call
    const entry = entries.find((e) => e.alias === alias);
    if (entry === undefined)
      throw new XqlError(`unknown table alias "${alias}" in JOIN expression — in scope: ${entries.map((e) => e.alias).join(", ")}`);
    if (schema[entry.table]?.[column] === undefined)
      throw new XqlError(`unknown column "${column}" on table "${entry.table}" in JOIN expression`);
  }

  for (const using of masked.matchAll(/\busing\s*\(([^)]*)\)/gi)) {
    for (const raw of using[1]!.split(",")) {
      const column = raw.trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) continue;
      const count = entries.filter((e) => schema[e.table]?.[column] !== undefined).length;
      if (count < 2)
        throw new XqlError(`JOIN USING column "${column}" must exist on both sides of the join`);
    }
  }
}

/** Runtime backstop for the legacy parser's historical JOIN-ON blind spot. */
export function validateJoinReferences(schema: SchemaDef, query: string): void {
  const sql = stripXqlMarkers(query);
  const withQuery = cteMain(schema, sql);
  if (withQuery !== null) {
    validateJoinReferences(withQuery.schema, withQuery.main);
    return;
  }
  validateSimpleJoinReferences(schema, sql);
}
