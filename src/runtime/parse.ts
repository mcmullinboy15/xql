import { z } from "zod";
import {
  castZod,
  fnZod,
  type Codec,
  type Column,
  type SchemaDef,
} from "../schema.ts";

export class XqlError extends Error {
  override name = "XqlError";
}

export interface Entry {
  table: string;
  alias: string;
  nullable: boolean;
}

export interface OutColumn {
  name: string;
  zod: Codec<unknown>;
}

const JOIN_START = new Set([
  "join",
  "left",
  "right",
  "inner",
  "full",
  "cross",
  "natural",
  ",",
]);
const STOP_KW = new Set([...JOIN_START, "on", "using"]);
const JOIN_FILLER = new Set(["outer", "join", "inner", "natural", "cross"]);
const TAIL_KW = new Set([
  "where",
  "group",
  "order",
  "limit",
  "offset",
  "having",
  "window",
  "union",
  "intersect",
  "except",
  "for",
]);
const OPERATOR_WORDS = new Set([
  "=", "<", ">", "<=", ">=", "!=", "<>", "like", "ilike", "in", "not", "and",
  "or", "(", "is", "any", "all", "+", "-", "*", "/",
]);

const MARKER_RE = /«[cfw]:|»/g;

export function stripMarkers(s: string): string {
  return s.replace(MARKER_RE, "");
}

function words(s: string): string[] {
  return s
    .replace(/[\n\t\r]/g, " ")
    .split(" ")
    .filter((w) => w !== "");
}

/** Splits on commas outside parens and string literals. */
export function splitTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (inStr) {
      cur += ch;
      if (ch === "'") inStr = false;
      continue;
    }
    if (ch === "'") {
      inStr = true;
      cur += ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== "" || out.length > 0) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// FROM
// ---------------------------------------------------------------------------

export function parseFrom(clause: string): Entry[] {
  if (clause.trim() === "") return [];
  const toks = words(clause.replace(/,/g, " , "));
  let i = 0;

  const readRef = (): { table: string; alias: string } => {
    const table = toks[i++];
    if (table === undefined) throw new XqlError("empty FROM clause");
    if (table.startsWith("(") || table.toLowerCase() === "lateral")
      throw new XqlError(
        "a subquery in FROM is not supported — lift it into a WITH clause, which xql does resolve",
      );
    if (table.includes("("))
      throw new XqlError(
        `a table function in FROM is not supported ("${table.slice(0, table.indexOf("("))}") — for a list parameter use \`= any (:ids::type[])\` instead`,
      );
    const next = toks[i];
    if (next !== undefined && next.toLowerCase() === "as") {
      i++;
      const alias = toks[i++];
      return { table, alias: alias ?? table };
    }
    if (next !== undefined && !STOP_KW.has(next.toLowerCase())) {
      i++;
      return { table, alias: next };
    }
    return { table, alias: table };
  };

  const dropFiller = () => {
    while (i < toks.length && JOIN_FILLER.has(toks[i]!.toLowerCase())) i++;
  };

  const first = readRef();
  const entries: Entry[] = [{ ...first, nullable: false }];

  while (i < toks.length) {
    const kw = toks[i]!.toLowerCase();
    let addNull = false;
    let priorNull = false;
    if (kw === ",") i++;
    else if (kw === "join" || kw === "inner" || kw === "cross" || kw === "natural") {
      i++;
      dropFiller();
    } else if (kw === "left") {
      addNull = true;
      i++;
      dropFiller();
    } else if (kw === "right") {
      priorNull = true;
      i++;
      dropFiller();
    } else if (kw === "full") {
      addNull = true;
      priorNull = true;
      i++;
      dropFiller();
    } else break;

    const ref = readRef();
    if (priorNull) for (const e of entries) e.nullable = true;
    entries.push({ ...ref, nullable: addNull });

    const after = toks[i]?.toLowerCase();
    if (after === "on" || after === "using") {
      i++;
      while (i < toks.length && !JOIN_START.has(toks[i]!.toLowerCase())) i++;
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

function aliasList(entries: Entry[]): string {
  return entries.map((e) => e.alias).join(", ");
}

function columnZod(
  schema: SchemaDef,
  entry: Entry,
  col: string,
): Codec<unknown> {
  const table = schema[entry.table];
  if (table === undefined)
    throw new XqlError(`unknown table "${entry.table}"`);
  const column = table[col];
  if (column === undefined)
    throw new XqlError(`unknown column "${col}" on table "${entry.table}"`);
  return entry.nullable
    ? column.zod.nullable()
    : column.zod;
}

function unwrapNullable(t: Codec<unknown>): Codec<unknown> {
  const def = (t as { _zod?: { def?: { type?: string; innerType?: unknown } } })
    ._zod?.def;
  if (def?.type === "nullable" && def.innerType)
    return def.innerType as Codec<unknown>;
  return t;
}

const inferHint = (expr: string, ty = "text") =>
  `cannot infer the type of "${expr}" — add an explicit cast, e.g. ${expr}::${ty}`;

export function resolveExpr(
  schema: SchemaDef,
  entries: Entry[],
  raw: string,
): Codec<unknown> {
  const expr = raw.trim();

  // A `::` only ends the expression when what follows is shaped like a type
  // name. Otherwise it belongs to a nested expression, as in
  // `(select count(*)::int8 from t)`, where the cast is the subquery's.
  const castAt = isTypeNameShaped(expr.slice(expr.lastIndexOf("::") + 2))
    ? expr.lastIndexOf("::")
    : -1;
  if (castAt !== -1) {
    const ty = expr.slice(castAt + 2).trim().toLowerCase();
    const isArray = ty.endsWith("[]");
    const zt = castZod[isArray ? ty.slice(0, -2).trim() : ty];
    if (zt === undefined) throw new XqlError(`unknown cast type "${ty}"`);
    return isArray ? z.array(zt) : zt;
  }

  if (expr.includes("(")) return resolveCall(schema, entries, expr);

  const dot = expr.indexOf(".");
  if (dot !== -1) {
    const alias = expr.slice(0, dot);
    const col = expr.slice(dot + 1);
    const entry = entries.find((e) => e.alias === alias);
    if (entry === undefined)
      throw new XqlError(
        `unknown table alias "${alias}" — in scope: ${aliasList(entries)}`,
      );
    return columnZod(schema, entry, col);
  }

  if (/\s/.test(expr)) throw new XqlError(inferHint(expr));

  const matches = entries.filter((e) => schema[e.table]?.[expr] !== undefined);
  if (matches.length === 1) return columnZod(schema, matches[0]!, expr);
  if (matches.length === 0)
    throw new XqlError(
      entries.length === 0
        ? `unknown column "${expr}" — the query has no FROM clause`
        : `unknown column "${expr}" — not on any table in scope (${aliasList(entries)})`,
    );
  throw new XqlError(
    `ambiguous column "${expr}" — qualify it, it exists on more than one table in scope (${aliasList(entries)})`,
  );
}

function resolveCall(
  schema: SchemaDef,
  entries: Entry[],
  expr: string,
): Codec<unknown> {
  const open = expr.indexOf("(");
  const close = expr.lastIndexOf(")");
  if (close < open) throw new XqlError(inferHint(expr));
  const fn = expr.slice(0, open).trim().toLowerCase();
  const args = expr.slice(open + 1, close);

  const known = fnZod[fn];
  if (known !== undefined) return known;
  if (fn === "count") return castZod.int8!;
  if (fn === "sum" || fn === "avg" || fn === "min" || fn === "max") {
    try {
      return resolveExpr(schema, entries, args).nullable();
    } catch {
      throw new XqlError(inferHint(expr, "numeric"));
    }
  }
  if (fn === "coalesce" || fn === "nullif" || fn === "greatest" || fn === "least") {
    const first = splitTopLevel(args)[0];
    if (first === undefined) throw new XqlError(inferHint(expr, "numeric"));
    try {
      return unwrapNullable(resolveExpr(schema, entries, first));
    } catch {
      throw new XqlError(inferHint(expr, "numeric"));
    }
  }
  throw new XqlError(inferHint(expr));
}

// ---------------------------------------------------------------------------
// SELECT list
// ---------------------------------------------------------------------------

function defaultName(expr: string): string | null {
  const castAt = expr.lastIndexOf("::");
  if (castAt !== -1) return defaultName(expr.slice(0, castAt));
  if (expr.includes("(")) return null;
  const dot = expr.lastIndexOf(".");
  return dot === -1 ? expr : expr.slice(dot + 1);
}

function splitAlias(item: string): { expr: string; name: string | null } {
  const w = words(item);
  if (w.length >= 3 && w[w.length - 2]!.toLowerCase() === "as")
    return { expr: w.slice(0, -2).join(" "), name: w[w.length - 1]! };
  if (w.length === 2 && w[0]!.toLowerCase() !== "as")
    return { expr: w[0]!, name: w[1]! };
  return { expr: w.join(" "), name: null };
}

function tableColumns(schema: SchemaDef, entry: Entry): OutColumn[] {
  const table = schema[entry.table];
  if (table === undefined)
    throw new XqlError(`unknown table "${entry.table}"`);
  return Object.keys(table).map((name) => ({
    name,
    zod: columnZod(schema, entry, name),
  }));
}

export function parseSelect(
  schema: SchemaDef,
  entries: Entry[],
  cols: string,
): OutColumn[] {
  const out: OutColumn[] = [];
  for (const rawItem of splitTopLevel(cols)) {
    const item = rawItem.trim();
    if (item === "") continue;

    if (item === "*") {
      if (entries.length === 0)
        throw new XqlError("select * requires a FROM clause");
      for (const e of entries) out.push(...tableColumns(schema, e));
      continue;
    }
    if (item.endsWith(".*")) {
      const alias = item.slice(0, -2);
      const entry = entries.find((e) => e.alias === alias);
      if (entry === undefined)
        throw new XqlError(
          `unknown table alias "${alias}" — in scope: ${aliasList(entries)}`,
        );
      out.push(...tableColumns(schema, entry));
      continue;
    }

    const { expr, name } = splitAlias(item);
    const zod = resolveExpr(schema, entries, expr);
    const outName = name ?? defaultName(expr);
    if (outName === null)
      throw new XqlError(
        `expression "${expr}" needs an alias, e.g. ${expr} as total`,
      );
    out.push({ name: outName, zod });
  }
  if (out.length === 0) throw new XqlError("empty SELECT list");
  return out;
}

// ---------------------------------------------------------------------------
// Clause splitting + params
// ---------------------------------------------------------------------------

/** Blanks string-literal contents while preserving length and whitespace. */
function maskLiterals(sql: string): string {
  return sql.replace(/'[^']*'/g, (lit) =>
    lit.replace(/[^\s']/g, "x"),
  );
}

interface Clauses {
  cols: string;
  from: string;
  tail: string;
}

function splitClauses(query: string): Clauses {
  const toks = words(query);
  // Keyword and paren matching runs over a copy with string literals blanked,
  // so a parenthesis or keyword inside a literal cannot move the clause
  // boundaries. Blanking preserves length and whitespace, so the two token
  // lists stay index-aligned and the returned clauses come from the original.
  const maskedToks = words(maskLiterals(query));

  /**
   * Only matches at paren depth zero. A subquery has its own FROM, and matching
   * it would slice the clauses at the wrong place — `select exists (select 1
   * from x) as y` would take `x` as the outer table.
   */
  const at = (kw: (t: string) => boolean, start: number) => {
    let depth = 0;
    for (let i = 0; i < maskedToks.length; i++) {
      const tok = maskedToks[i]!;
      if (i >= start && depth === 0 && kw(tok.toLowerCase())) return i;
      for (const ch of tok) {
        if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
    }
    return -1;
  };
  const sel = at((t) => t === "select", 0);
  if (sel === -1) throw new XqlError("query must contain a SELECT clause");
  const frm = at((t) => t === "from", sel + 1);
  // A FROM clause is optional: `select (select …) as a, exists (…) as b` is a
  // whole query whose columns are all self-typing.
  if (frm === -1) {
    const tailless = at((t) => TAIL_KW.has(t), sel + 1);
    const stop = tailless === -1 ? toks.length : tailless;
    return {
      cols: toks.slice(sel + 1, stop).join(" "),
      from: "",
      tail: toks.slice(stop).join(" "),
    };
  }
  const tail = at((t) => TAIL_KW.has(t), frm + 1);
  const end = tail === -1 ? toks.length : tail;
  return {
    cols: toks.slice(sel + 1, frm).join(" "),
    from: toks.slice(frm + 1, end).join(" "),
    tail: toks.slice(end).join(" "),
  };
}

const ROLE_NAMES: Record<string, string> = { c: "cols", f: "from", w: "where" };

function checkRoles(clauses: Clauses): void {
  const expected: Record<keyof Clauses, string> = {
    cols: "c",
    from: "f",
    tail: "w",
  };
  const position: Record<keyof Clauses, string> = {
    cols: "SELECT",
    from: "FROM",
    tail: "WHERE",
  };
  for (const key of ["cols", "from", "tail"] as const) {
    for (const m of clauses[key].matchAll(/«([cfw]):/g)) {
      const kind = m[1]!;
      if (kind !== expected[key])
        throw new XqlError(
          `a ${ROLE_NAMES[kind]}() fragment is in the ${position[key]} position`,
        );
    }
  }
}

export function bindParams(
  sql: string,
  params: Record<string, unknown>,
): { text: string; values: unknown[] } {
  const order: string[] = [];
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    if (ch === "'") {
      out += ch;
      i++;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === "'") {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === ":" && sql[i + 1] === ":") {
      out += "::";
      i += 2;
      continue;
    }
    if (ch === ":") {
      let j = i + 1;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j]!)) j++;
      const name = sql.slice(i + 1, j);
      if (name !== "") {
        if (!(name in params))
          throw new XqlError(`missing value for parameter :${name}`);
        let idx = order.indexOf(name);
        if (idx === -1) {
          order.push(name);
          idx = order.length - 1;
        }
        out += `$${idx + 1}`;
        i = j;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return { text: out, values: order.map((n) => params[n]) };
}

/** Operators become their own tokens; `::casts` stay attached to their value. */
function tailTokens(s: string): string[] {
  return words(
    s
      .replace(/'[^']*'/g, "''")
      .replace(/\(/g, " ( ")
      .replace(/\)/g, " ) ")
      .replace(/([=<>!,+\-/%*|])/g, " $1 "),
  );
}

const OPERATORS = new Set([
  "=", "<", ">", "!", "+", "-", "*", "/", "%", "|",
]);
const OP_KEYWORDS = new Set([
  "is", "in", "like", "ilike", "between", "not", "similar",
]);

/**
 * Words that can sit next to an operator without being a column. Being generous
 * here only weakens detection; missing one would reject valid SQL.
 */
const KEYWORDS = new Set([
  "null", "true", "false", "unknown", "and", "or", "not", "is", "in", "any",
  "all", "some", "between", "symmetric", "asymmetric", "distinct", "from",
  "interval", "case", "when", "then", "else", "end", "escape", "similar", "to",
  "nulls", "first", "last", "asc", "desc", "by", "like", "ilike", "exists",
  "array", "default", "cast", "as", "collate", "at", "time", "zone", "filter",
  "over", "partition", "within", "group", "order", "having", "where", "limit",
  "offset", "row", "rows", "only", "next", "fetch", "for", "update", "share",
  "of", "nowait", "locked", "skip", "union", "intersect", "except", "on",
  "using", "natural", "left", "right", "full", "inner", "outer", "join",
  "cross", "lateral", "with", "values", "returning", "set", "into", "insert",
  "delete", "select", "current_date", "current_time", "current_timestamp",
  "localtime", "localtimestamp", "current_user", "session_user", "user",
  "current_schema", "recursive", "materialized", "ordinality", "tablesample",
]);

const stripCast = (t: string) => t.split("::")[0]!;

/** `int8`, `text[]`, `double precision` — but not `int8 from product)`. */
function isTypeNameShaped(s: string): boolean {
  const t = s.trim();
  return t !== "" && /^[A-Za-z_][A-Za-z0-9_]*( precision)?(\[\])?$/.test(t);
}

/**
 * Rejects references that cannot resolve. Qualified `alias.column` refs are
 * always checked; a bare identifier is checked only when it sits next to an
 * operator, which is where a column name actually appears — that keeps keywords,
 * function names and cast types from being mistaken for columns.
 */
function checkRefs(
  schema: SchemaDef,
  entries: Entry[],
  tail: string,
  outNames: Set<string> = new Set(),
): void {
  const toks = tailTokens(tail);
  const isOp = (t: string | undefined) =>
    t !== undefined && (OPERATORS.has(t) || OP_KEYWORDS.has(t.toLowerCase()));

  // Postgres allows output names in GROUP BY / ORDER BY, but not WHERE / HAVING.
  let allowOutNames = false;

  for (let i = 0; i < toks.length; i++) {
    const lower = toks[i]!.toLowerCase();
    // A set operator starts a new query with its own scope.
    if (lower === "union" || lower === "intersect" || lower === "except") return;
    // A subquery brings its own FROM, so its refs cannot be resolved here.
    if (toks[i] === "(" && toks[i + 1]?.toLowerCase() === "select") {
      let depth = 1;
      i++;
      while (i < toks.length && depth > 0) {
        i++;
        if (toks[i] === "(") depth++;
        else if (toks[i] === ")") depth--;
      }
      continue;
    }
    if (lower === "where" || lower === "having") {
      allowOutNames = false;
      continue;
    }
    if (lower === "group" || lower === "order") {
      allowOutNames = true;
      continue;
    }
    if (toks[i + 1] === "(") continue;
    const tok = stripCast(toks[i]!);
    const dot = tok.indexOf(".");

    if (dot > 0) {
      const alias = tok.slice(0, dot);
      const col = tok.slice(dot + 1);
      if (col === "" || col.includes(".")) continue;
      if (/^[0-9]/.test(alias)) continue;
      const entry = entries.find((e) => e.alias === alias);
      if (entry === undefined)
        throw new XqlError(
          `unknown table alias "${alias}" — in scope: ${aliasList(entries)}`,
        );
      if (schema[entry.table]?.[col] === undefined)
        throw new XqlError(`unknown column "${col}" on table "${entry.table}"`);
      continue;
    }

    if (dot !== -1) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tok)) continue;
    if (KEYWORDS.has(tok.toLowerCase())) continue;
    if (allowOutNames && outNames.has(tok)) continue;
    if (!isOp(toks[i - 1]) && !isOp(toks[i + 1])) continue;

    const matches = entries.filter((e) => schema[e.table]?.[tok] !== undefined);
    if (matches.length === 1) continue;
    if (matches.length === 0)
      throw new XqlError(
        `unknown column "${tok}" — not on any table in scope (${aliasList(entries)})`,
      );
    throw new XqlError(
      `ambiguous column "${tok}" — qualify it, it exists on more than one table in scope (${aliasList(entries)})`,
    );
  }
}

export interface Prepared {
  text: string;
  columns: OutColumn[];
  rowSchema: Codec<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// INSERT / UPDATE / DELETE
// ---------------------------------------------------------------------------

export type StatementKind = "select" | "insert" | "update" | "delete";

export function statementKind(query: string): StatementKind {
  const first = words(stripMarkers(query))[0]?.toLowerCase();
  if (first === "insert" || first === "update" || first === "delete")
    return first;
  return "select";
}

function wtokens(s: string): string[] {
  return words(
    s.replace(/\(/g, " ( ").replace(/\)/g, " ) ").replace(/,/g, " , "),
  );
}

const NO_ALIAS_NEXT = new Set([
  "(", "values", "default", "select", "set", "where", "using", "returning",
  "overriding", "on",
]);

function readTarget(
  toks: string[],
  start: number,
): { table: string; alias: string; next: number } {
  let i = start;
  const table = toks[i++];
  if (table === undefined) throw new XqlError("missing target table");
  const next = toks[i];
  if (next !== undefined && next.toLowerCase() === "as") {
    i++;
    const alias = toks[i++];
    return { table, alias: alias ?? table, next: i };
  }
  if (next !== undefined && !NO_ALIAS_NEXT.has(next.toLowerCase()))
    return { table, alias: next, next: i + 1 };
  return { table, alias: table, next: i };
}

/** Consumes a parenthesised group starting at `toks[start] === "("`. */
function parenGroup(toks: string[], start: number): { items: string[]; next: number } {
  const items: string[] = [];
  let depth = 0;
  let i = start;
  for (; i < toks.length; i++) {
    const tok = toks[i]!;
    if (tok === "(") {
      depth++;
      if (depth === 1) continue;
    } else if (tok === ")") {
      depth--;
      if (depth === 0) return { items, next: i + 1 };
    }
    items.push(tok);
  }
  return { items, next: i };
}

function splitCommaTokens(toks: string[]): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let depth = 0;
  for (const tok of toks) {
    if (tok === "," && depth === 0) {
      out.push(cur);
      cur = [];
      continue;
    }
    if (tok === "(") depth++;
    else if (tok === ")") depth--;
    cur.push(tok);
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

function prepareWrite(
  schema: SchemaDef,
  query: string,
  kind: Exclude<StatementKind, "select">,
): Prepared {
  const stripped = stripMarkers(query);
  const toks = wtokens(stripped);
  const rIdx = toks.findIndex((t) => t.toLowerCase() === "returning");
  const head = rIdx === -1 ? toks : toks.slice(0, rIdx);
  const returning = rIdx === -1 ? "" : toks.slice(rIdx + 1).join(" ");

  const start = kind === "update" ? 1 : 2;
  const target = readTarget(head, start);
  if (schema[target.table] === undefined)
    throw new XqlError(`unknown table "${target.table}"`);
  const entries: Entry[] = [
    { table: target.table, alias: target.alias, nullable: false },
  ];

  let targets: string[] = [];
  let tail = "";
  if (kind === "insert") {
    if (head[target.next] === "(") {
      const group = parenGroup(head, target.next);
      targets = splitCommaTokens(group.items).map((g) => g.join(" "));
    }
  } else if (kind === "update") {
    const setIdx = head.findIndex(
      (t, k) => k >= target.next && t.toLowerCase() === "set",
    );
    if (setIdx === -1) throw new XqlError("UPDATE requires a SET clause");
    let end = head.findIndex(
      (t, k) =>
        k > setIdx && (t.toLowerCase() === "where" || t.toLowerCase() === "from"),
    );
    if (end === -1) end = head.length;
    targets = splitCommaTokens(head.slice(setIdx + 1, end)).map((g) => g[0] ?? "");
    tail = head.slice(setIdx + 1).join(" ");
  } else {
    tail = head.slice(target.next).join(" ");
  }

  const table = schema[target.table]!;
  for (const name of targets)
    if (table[name] === undefined)
      throw new XqlError(
        `unknown column "${name}" on table "${target.table}"`,
      );

  checkRefs(schema, entries, `${tail} ${returning}`);

  const columns =
    returning.trim() === "" ? [] : parseSelect(schema, entries, returning);
  const shape: Record<string, Codec<unknown>> = {};
  for (const c of columns) shape[c.name] = c.zod;

  return {
    text: stripped.replace(/\s+/g, " ").trim(),
    columns,
    rowSchema: z.object(shape),
  };
}

const ORDER_STOP = new Set([
  "limit", "offset", "for", "fetch", "union", "intersect", "except", "window",
]);
const OP_WORDS = new Set(["+", "-", "*", "/", "||", "%"]);

function isLimitValue(raw: string): boolean {
  // a LIMIT inside a subquery carries the rest of the expression on its value
  // token, e.g. `limit 1)::int4`
  const v = raw.replace(/[);].*$/, "");
  return /^[0-9]+$/.test(v) || v.toLowerCase() === "all" || /^:[A-Za-z_]/.test(v);
}

function validDirection(rest: string[]): boolean {
  const l = rest.map((t) => t.toLowerCase());
  let i = 0;
  if (l[i] === "asc" || l[i] === "desc") i++;
  if (l[i] === "nulls") {
    i++;
    if (l[i] !== "first" && l[i] !== "last") return false;
    i++;
  }
  return i === l.length;
}

/**
 * An ORDER BY item is `<expression> [asc|desc] [nulls first|last]`. Only the
 * direction suffix is checkable — an expression may be a function call, a CASE,
 * or arithmetic, none of which can be told from a malformed direction by shape
 * alone. So the suffix is peeled off and validated, and the remainder is only
 * questioned when it looks like a bare column followed by a stray word.
 */
function orderItemProblem(item: string): string | null {
  const bad = `invalid ORDER BY direction in "${item}" — use asc or desc, optionally followed by nulls first/last`;
  const head = words(item.replace(/;+$/, ""));
  if (head.length === 0) return null;

  const suffix: string[] = [];
  while (head.length > 0 && DIR_WORDS.has(head[head.length - 1]!.toLowerCase()))
    suffix.unshift(head.pop()!);

  if (head.length === 0) return bad;
  if (!validDirection(suffix)) return bad;
  if (head.length === 1) return null;
  // A direction word left inside the expression means a malformed suffix,
  // such as `nulls sideways`.
  if (head.slice(1).some((t) => DIR_WORDS.has(t.toLowerCase()))) return bad;
  // `id ascending` is a typo; anything with parens, quotes or operators is an
  // expression and is left alone.
  const simple = (t: string) => !/[()'",+\-*/]/.test(t);
  if (head.length === 2 && simple(head[0]!) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(head[1]!))
    return bad;
  return null;
}

/** LIMIT/OFFSET take a count; ORDER BY items take asc/desc [nulls first|last]. */
function checkTailKeywords(query: string): void {
  const toks = words(query.replace(/'[^']*'/g, "''"));
  for (let i = 0; i < toks.length; i++) {
    const kw = toks[i]!.toLowerCase();
    if (kw === "limit" || kw === "offset") {
      const value = toks[i + 1];
      if (value === undefined)
        throw new XqlError(`${kw.toUpperCase()} needs a value`);
      if (!isLimitValue(value))
        throw new XqlError(
          `${kw.toUpperCase()} must be a number, ALL, or a parameter`,
        );
      continue;
    }
    if (kw === "order" && toks[i + 1]?.toLowerCase() === "by") {
      let j = i + 2;
      const run: string[] = [];
      while (j < toks.length && !ORDER_STOP.has(toks[j]!.toLowerCase()))
        run.push(toks[j++]!);
      for (const raw of splitTopLevel(run.join(" "))) {
        const problem = orderItemProblem(raw.trim());
        if (problem !== null) throw new XqlError(problem);
      }
    }
  }
}

const DIR_WORDS = new Set(["asc", "desc", "nulls", "first", "last"]);

/** A bare ORDER BY name: an ordinal, an output name, or a scope column. */
function checkOrderColumns(
  schema: SchemaDef,
  entries: Entry[],
  columns: OutColumn[],
  query: string,
): void {
  const outNames = new Set(columns.map((c) => c.name));
  const toks = words(query.replace(/'[^']*'/g, "''"));
  for (let i = 0; i < toks.length; i++) {
    if (toks[i]!.toLowerCase() !== "order") continue;
    if (toks[i + 1]?.toLowerCase() !== "by") continue;
    let j = i + 2;
    const run: string[] = [];
    while (j < toks.length && !ORDER_STOP.has(toks[j]!.toLowerCase()))
      run.push(toks[j++]!);
    for (const raw of splitTopLevel(run.join(" "))) {
      const w = words(raw.trim());
      while (w.length > 0 && DIR_WORDS.has(w[w.length - 1]!.toLowerCase()))
        w.pop();
      if (w.length !== 1) continue;
      const name = w[0]!;
      if (/^[0-9]+$/.test(name)) continue;
      if (outNames.has(name)) continue;
      if (name.startsWith('"')) continue;
      if (name.includes(".") || name.includes("(")) continue;
      const matches = entries.filter(
        (e) => schema[e.table]?.[name] !== undefined,
      );
      if (matches.length === 1) continue;
      if (matches.length === 0)
        throw new XqlError(
          `unknown ORDER BY column "${name}" — not a selected output name, and not a column on any table in scope (${aliasList(entries)})`,
        );
      throw new XqlError(
        `ambiguous ORDER BY column "${name}" — qualify it, it exists on more than one table in scope (${aliasList(entries)})`,
      );
    }
  }
}

/** Wraps a resolved codec so a CTE's output column behaves like a table column. */
function asColumn(zod: Codec<unknown>): Column<unknown> {
  return {
    zod,
    sqlType: "cte",
    isNullable: false,
    nullable: () => asColumn(zod.nullable()),
  };
}

/**
 * Resolves each CTE body against the schema built so far, then registers its
 * output columns as a pseudo-table. The main query is then prepared against the
 * extended schema, so joins and star expansion treat a CTE like any table.
 */
function prepareWith(schema: SchemaDef, query: string): Prepared {
  const stripped = stripMarkers(query);
  const toks = wtokens(stripped);
  let i = 1;
  if (toks[i]?.toLowerCase() === "recursive")
    throw new XqlError(
      "WITH RECURSIVE is not supported — the CTE body cannot be resolved before the CTE exists",
    );

  let extended: SchemaDef = schema;
  for (;;) {
    const name = toks[i++];
    if (name === undefined) throw new XqlError("malformed WITH clause");
    if (toks[i] === "(")
      throw new XqlError(
        `column alias lists on a CTE ("${name}" (...)) are not supported — name the columns in the CTE's own SELECT instead`,
      );
    if (toks[i]?.toLowerCase() !== "as")
      throw new XqlError(`malformed WITH clause near "${name}"`);
    i++;
    while (
      toks[i] !== undefined &&
      (toks[i]!.toLowerCase() === "materialized" ||
        toks[i]!.toLowerCase() === "not")
    )
      i++;
    if (toks[i] !== "(")
      throw new XqlError(`CTE "${name}" is missing its parenthesised body`);

    const group = parenGroup(toks, i);
    const inner = prepare(extended, group.items.join(" "));
    const table: Record<string, Column<unknown>> = {};
    for (const c of inner.columns) table[c.name] = asColumn(c.zod);
    extended = { ...extended, [name]: table };

    i = group.next;
    if (toks[i] === ",") {
      i++;
      continue;
    }
    break;
  }

  const main = prepare(extended, toks.slice(i).join(" "));
  // The emitted SQL is the original query, WITH clause and all.
  return { ...main, text: stripped.replace(/\s+/g, " ").trim() };
}

/**
 * Splits a leading `distinct` / `distinct on (...)` off a select list. The ON
 * expressions are still column references, so they are returned for checking
 * rather than discarded.
 */
function splitDistinct(cols: string): { on: string; rest: string } {
  const plain = words(cols);
  const first = plain[0]?.toLowerCase();
  if (first !== "distinct" && first !== "all") return { on: "", rest: cols };
  const toks = wtokens(cols);
  let i = 1;
  let on = "";
  if (toks[i]?.toLowerCase() === "on") {
    i++;
    if (toks[i] === "(") {
      const group = parenGroup(toks, i);
      on = group.items.join(" ");
      i = group.next;
    }
  }
  return { on, rest: toks.slice(i).join(" ") };
}

export function prepare(schema: SchemaDef, query: string): Prepared {
  if (words(stripMarkers(query))[0]?.toLowerCase() === "with")
    return prepareWith(schema, query);
  checkTailKeywords(stripMarkers(query));
  const kind = statementKind(query);
  if (kind !== "select") return prepareWrite(schema, query, kind);

  const clauses = splitClauses(query);
  checkRoles(clauses);
  const entries = parseFrom(stripMarkers(clauses.from));
  const distinct = splitDistinct(stripMarkers(clauses.cols));
  const columns = parseSelect(schema, entries, distinct.rest);
  if (distinct.on !== "") checkRefs(schema, entries, distinct.on);
  const tail = stripMarkers(clauses.tail);
  checkRefs(schema, entries, tail, new Set(columns.map((c) => c.name)));
  checkOrderColumns(schema, entries, columns, stripMarkers(query));

  const shape: Record<string, Codec<unknown>> = {};
  for (const c of columns) shape[c.name] = c.zod;

  return {
    text: stripMarkers(query).replace(/\s+/g, " ").trim(),
    columns,
    rowSchema: z.object(shape),
  };
}
