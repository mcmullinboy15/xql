import { z } from "zod";
import { codecForSqlType, type Column, type Codec, type SchemaDef } from "../schema.ts";
import { stripXqlMarkers } from "./bind.ts";
import { parseFrom, splitTopLevel, XqlError, type Entry, type Prepared } from "./parse.ts";

interface Clauses {
  readonly cols: string;
  readonly from: string;
}

const isWord = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_$]/.test(c);

/** Finds a top-level SQL keyword while ignoring strings/comments/dollar quotes. */
function findKeyword(sql: string, keyword: string, start = 0): number {
  const lower = sql.toLowerCase();
  let depth = 0;
  let i = start;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      i++;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') { i += 2; continue; }
        if (sql[i] === '"') { i++; break; }
        i++;
      }
      continue;
    }
    if (ch === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i + 2);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      let d = 1;
      i += 2;
      while (i < sql.length && d > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") { d++; i += 2; }
        else if (sql[i] === "*" && sql[i + 1] === "/") { d--; i += 2; }
        else i++;
      }
      continue;
    }
    if (ch === "$") {
      const m = /^(\$\$|\$[A-Za-z_][A-Za-z0-9_]*\$)/.exec(sql.slice(i));
      if (m) {
        const delim = m[0];
        const end = sql.indexOf(delim, i + delim.length);
        i = end === -1 ? sql.length : end + delim.length;
        continue;
      }
    }
    if (ch === "(") { depth++; i++; continue; }
    if (ch === ")") { depth = Math.max(0, depth - 1); i++; continue; }
    if (depth === 0 && lower.startsWith(keyword, i)) {
      const before = i === 0 ? undefined : lower[i - 1];
      const after = lower[i + keyword.length];
      if (!isWord(before) && !isWord(after)) return i;
    }
    i++;
  }
  return -1;
}

function splitClauses(sql: string): Clauses | null {
  const select = findKeyword(sql, "select");
  if (select === -1) return null;
  const from = findKeyword(sql, "from", select + 6);
  if (from === -1) return null;
  const stops = ["where", "group", "order", "limit", "offset", "having", "window", "union", "intersect", "except", "for"];
  let end = sql.length;
  for (const stop of stops) {
    const at = findKeyword(sql, stop, from + 4);
    if (at !== -1 && at < end) end = at;
  }
  return { cols: sql.slice(select + 6, from), from: sql.slice(from + 4, end) };
}

function resolveColumn(
  schema: SchemaDef,
  entries: readonly Entry[],
  ref: string,
): Column<unknown, string> | null {
  const dot = ref.indexOf(".");
  if (dot !== -1) {
    const alias = ref.slice(0, dot);
    const name = ref.slice(dot + 1);
    const entry = entries.find((e) => e.alias === alias);
    return entry ? schema[entry.table]?.[name] ?? null : null;
  }
  const matches = entries
    .map((entry) => schema[entry.table]?.[ref])
    .filter((column): column is Column<unknown, string> => column !== undefined);
  return matches.length === 1 ? matches[0]! : null;
}

function aggregateSqlType(fn: "sum" | "avg", input: string): string | null {
  const ty = input.toLowerCase();
  if (fn === "sum") {
    if (["int2", "smallint", "int4", "int", "integer"].includes(ty)) return "int8";
    if (["int8", "bigint", "numeric", "decimal"].includes(ty)) return "numeric";
    if (["float4", "real"].includes(ty)) return "float4";
    if (["float8", "float", "double precision"].includes(ty)) return "float8";
    return null;
  }
  if (["int2", "smallint", "int4", "int", "integer", "int8", "bigint", "numeric", "decimal"].includes(ty)) return "numeric";
  if (["float4", "real", "float8", "float", "double precision"].includes(ty)) return "float8";
  return null;
}

function aliasOf(item: string): string | null {
  const as = /\s+as\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(item);
  if (as) return as[1]!;
  const implicit = /\)\s*(?:::[A-Za-z_][A-Za-z0-9_ ]*)?\s+([A-Za-z_][A-Za-z0-9_]*)\s*$/i.exec(item);
  return implicit?.[1] ?? null;
}

/**
 * The legacy runtime parser historically returned the argument codec for SUM
 * and AVG and lost nullability when an aggregate was explicitly cast. Correct
 * those simple aggregate forms here until a compiled manifest is canonical.
 */
export function correctAggregateCodecs(
  schema: SchemaDef,
  query: string,
  prepared: Prepared,
): Prepared {
  const sql = stripXqlMarkers(query);
  const clauses = splitClauses(sql);
  if (clauses === null) return prepared;

  // CTE bodies are prepared recursively inside the legacy parser. It cannot
  // safely patch the pseudo-table after that recursive parse, so fail closed.
  if (/^\s*with\b/i.test(sql)) {
    if (/\b(?:sum|avg)\s*\(/i.test(sql) || /\b(?:min|max)\s*\([^)]*\)\s*::/i.test(sql))
      throw new XqlError("uncompiled CTE aggregate semantics require the XQL compiler (or remove the aggregate/cast); refusing to construct a potentially wrong runtime validator");
  }

  const entries = parseFrom(clauses.from);
  const replacements = new Map<string, Codec<unknown>>();
  for (const raw of splitTopLevel(clauses.cols)) {
    const item = raw.trim();
    const match = /^(sum|avg|min|max)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\)\s*(?:::([A-Za-z_][A-Za-z0-9_ ]*))?/i.exec(item);
    if (!match) continue;
    const fn = match[1]!.toLowerCase() as "sum" | "avg" | "min" | "max";
    const ref = match[2]!;
    const castType = match[3]?.trim();
    const name = aliasOf(item);
    if (name === null) continue;
    const column = resolveColumn(schema, entries, ref);
    if (column === null) continue;

    if (castType !== undefined) {
      replacements.set(name, codecForSqlType(castType, true));
      continue;
    }
    if (fn === "min" || fn === "max") continue; // legacy resolver already makes these nullable

    const resultType = aggregateSqlType(fn, column.sqlType);
    if (resultType === null)
      throw new XqlError(`cannot infer PostgreSQL ${fn.toUpperCase()} result for SQL type "${column.sqlType}" — add an explicit cast`);
    replacements.set(name, codecForSqlType(resultType, true));
  }

  if (replacements.size === 0) return prepared;
  const shape: Record<string, Codec<unknown>> = {};
  for (const column of prepared.columns)
    shape[column.name] = replacements.get(column.name) ?? column.zod;
  return { ...prepared, rowSchema: z.object(shape) };
}
