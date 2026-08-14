import { z } from "zod";
import { castZod, type Codec, type SchemaDef } from "../schema.ts";

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
  const toks = words(clause.replace(/,/g, " , "));
  let i = 0;

  const readRef = (): { table: string; alias: string } => {
    const table = toks[i++];
    if (table === undefined) throw new XqlError("empty FROM clause");
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

  const castAt = expr.lastIndexOf("::");
  if (castAt !== -1) {
    const ty = expr.slice(castAt + 2).trim().toLowerCase();
    const zt = castZod[ty];
    if (zt === undefined) throw new XqlError(`unknown cast type "${ty}"`);
    return zt;
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
      `unknown column "${expr}" — not on any table in scope (${aliasList(entries)})`,
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

  if (fn === "count") return castZod.int8!;
  if (fn === "sum" || fn === "avg" || fn === "min" || fn === "max") {
    try {
      return resolveExpr(schema, entries, args).nullable();
    } catch {
      throw new XqlError(inferHint(expr, "numeric"));
    }
  }
  if (fn === "coalesce") {
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

interface Clauses {
  cols: string;
  from: string;
  tail: string;
}

function splitClauses(query: string): Clauses {
  const toks = words(query);
  const at = (kw: (t: string) => boolean, start: number) => {
    for (let i = start; i < toks.length; i++) if (kw(toks[i]!.toLowerCase())) return i;
    return -1;
  };
  const sel = at((t) => t === "select", 0);
  if (sel === -1) throw new XqlError("query must contain a SELECT clause");
  const frm = at((t) => t === "from", sel + 1);
  if (frm === -1) throw new XqlError("query must contain a FROM clause");
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

/** Mirrors the type-level TailTokens: parens are separate, operators vanish. */
function tailTokens(s: string): string[] {
  return words(
    s
      .replace(/'[^']*'/g, "''")
      .replace(/::/g, " ")
      .replace(/\(/g, " ( ")
      .replace(/\)/g, " ) ")
      .replace(/[=<>!,+\-/%*|]/g, " "),
  );
}

/**
 * Rejects `alias.column` references whose alias is not in scope or whose column
 * does not exist. Numeric literals, schema-qualified names and function calls
 * are skipped — see IsColumnRef in type/query.ts for the matching rules.
 */
function checkRefs(schema: SchemaDef, entries: Entry[], tail: string): void {
  const toks = tailTokens(tail);
  for (let i = 0; i < toks.length; i++) {
    const tok = toks[i]!;
    if (toks[i + 1] === "(") continue;
    const dot = tok.indexOf(".");
    if (dot <= 0) continue;
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

function isLimitValue(v: string): boolean {
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
        const item = raw.trim();
        const rest = words(item).slice(1);
        if (rest.length === 0) continue;
        if (rest.some((t) => OP_WORDS.has(t))) continue;
        if (!validDirection(rest))
          throw new XqlError(
            `invalid ORDER BY direction in "${item}" — use asc or desc, optionally followed by nulls first/last`,
          );
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

export function prepare(schema: SchemaDef, query: string): Prepared {
  if (words(stripMarkers(query))[0]?.toLowerCase() === "with")
    throw new XqlError(
      "WITH (common table expressions) is not supported — clause splitting would latch onto the CTE body and type the wrong columns",
    );
  checkTailKeywords(stripMarkers(query));
  const kind = statementKind(query);
  if (kind !== "select") return prepareWrite(schema, query, kind);

  const clauses = splitClauses(query);
  checkRoles(clauses);
  const entries = parseFrom(stripMarkers(clauses.from));
  const columns = parseSelect(schema, entries, stripMarkers(clauses.cols));
  const tail = stripMarkers(clauses.tail);
  checkRefs(schema, entries, tail);
  checkOrderColumns(schema, entries, columns, stripMarkers(query));

  const shape: Record<string, Codec<unknown>> = {};
  for (const c of columns) shape[c.name] = c.zod;

  return {
    text: stripMarkers(query).replace(/\s+/g, " ").trim(),
    columns,
    rowSchema: z.object(shape),
  };
}
