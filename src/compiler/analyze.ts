import type { CompiledColumn, CompiledParam } from "../runtime/compiled.ts";
import {
  XqlCompilerError,
  type AnalyzedStatement,
  type CatalogColumn,
  type CatalogTable,
  type CompilerCatalog,
} from "./types.ts";

type Obj = Record<string, unknown>;

interface ScopeEntry {
  readonly alias: string;
  readonly label: string;
  readonly columns: Readonly<Record<string, CatalogColumn>>;
  readonly nullable: boolean;
}

interface ResolveContext {
  readonly catalog: CompilerCatalog;
  readonly params: Map<number, Omit<CompiledParam, "name">>;
  readonly ctes: Map<string, CatalogTable>;
}

interface ResolvedExpr {
  readonly sqlType: string;
  readonly nullable: boolean;
  readonly enumValues?: readonly string[];
}

const asObj = (value: unknown): Obj | null =>
  typeof value === "object" && value !== null ? value as Obj : null;

function unwrap(value: unknown, kind: string): Obj | null {
  const object = asObj(value);
  return object === null ? null : asObj(object[kind]);
}

function kindOf(value: unknown): { kind: string; value: Obj } | null {
  const object = asObj(value);
  if (object === null) return null;
  for (const [kind, inner] of Object.entries(object)) {
    const child = asObj(inner);
    if (child !== null) return { kind, value: child };
  }
  return null;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  const wrapper = unwrap(value, "String") ?? asObj(value);
  if (wrapper === null) return null;
  const candidate = wrapper.sval ?? wrapper.str ?? wrapper.string;
  return typeof candidate === "string" ? candidate : null;
}

function strings(values: unknown): string[] {
  return Array.isArray(values)
    ? values.map(stringValue).filter((x): x is string => x !== null)
    : [];
}

function fail(
  code: ConstructorParameters<typeof XqlCompilerError>[0]["code"],
  message: string,
): never {
  throw new XqlCompilerError({ code, message });
}

function canonicalSqlType(sqlType: string): string {
  const raw = sqlType.toLowerCase();
  const aliases: Record<string, string> = {
    smallint: "int2",
    integer: "int4",
    int: "int4",
    bigint: "int8",
    real: "float4",
    float: "float8",
    "double precision": "float8",
    decimal: "numeric",
    boolean: "bool",
    char: "bpchar",
  };
  return aliases[raw] ?? raw;
}

function tableFor(
  ctx: ResolveContext,
  relation: Obj,
): CatalogTable {
  const relname = relation.relname;
  if (typeof relname !== "string")
    return fail("XQL_UNSUPPORTED_SQL", "range relation is missing relname");
  const cte = ctx.ctes.get(relname);
  if (cte !== undefined && relation.schemaname === undefined) return cte;

  const schema = typeof relation.schemaname === "string" ? relation.schemaname : undefined;
  if (schema !== undefined) {
    const table = ctx.catalog.tables[`${schema}.${relname}`];
    if (table !== undefined) return table;
    return fail("XQL_UNKNOWN_TABLE", `unknown table "${schema}.${relname}"`);
  }
  for (const candidate of ctx.catalog.searchPath) {
    const table = ctx.catalog.tables[`${candidate}.${relname}`];
    if (table !== undefined) return table;
  }
  return fail("XQL_UNKNOWN_TABLE", `unknown table "${relname}" on search_path (${ctx.catalog.searchPath.join(", ")})`);
}

function aliasName(relation: Obj, fallback: string): string {
  const raw = relation.alias;
  const alias = unwrap(raw, "Alias") ?? asObj(raw);
  return typeof alias?.aliasname === "string" ? alias.aliasname : fallback;
}

function columnFromRef(
  node: Obj,
  scope: readonly ScopeEntry[],
): { entry: ScopeEntry; column: CatalogColumn } {
  const fields = Array.isArray(node.fields) ? node.fields : [];
  const names = fields.map(stringValue).filter((x): x is string => x !== null);
  if (names.length === 0)
    return fail("XQL_UNSUPPORTED_SQL", "empty ColumnRef");
  const columnName = names[names.length - 1]!;

  if (names.length === 1) {
    const matches = scope
      .map((entry) => ({ entry, column: entry.columns[columnName] }))
      .filter((x): x is { entry: ScopeEntry; column: CatalogColumn } => x.column !== undefined);
    if (matches.length === 0)
      return fail("XQL_UNKNOWN_COLUMN", `unknown column "${columnName}"`);
    if (matches.length > 1)
      return fail("XQL_AMBIGUOUS_COLUMN", `ambiguous column "${columnName}" — qualify it`);
    return matches[0]!;
  }

  const qualifier = names[names.length - 2]!;
  const entry = scope.find((candidate) => candidate.alias === qualifier || candidate.label === qualifier);
  if (entry === undefined)
    return fail("XQL_UNKNOWN_TABLE", `unknown table/alias "${qualifier}" — in scope: ${scope.map((x) => x.alias).join(", ")}`);
  const column = entry.columns[columnName];
  if (column === undefined)
    return fail("XQL_UNKNOWN_COLUMN", `unknown column "${columnName}" on "${qualifier}"`);
  return { entry, column };
}

function typeName(node: Obj): string {
  const names = strings(node.names);
  if (names.length === 0)
    return fail("XQL_UNSUPPORTED_SQL", "type cast is missing a PostgreSQL type name");
  return canonicalSqlType(names[names.length - 1]!);
}

function aggregateResult(fn: string, input: ResolvedExpr): ResolvedExpr {
  const ty = canonicalSqlType(input.sqlType);
  if (fn === "min" || fn === "max") return { ...input, nullable: true };
  if (fn === "sum") {
    if (["int2", "int4"].includes(ty)) return { sqlType: "int8", nullable: true };
    if (["int8", "numeric"].includes(ty)) return { sqlType: "numeric", nullable: true };
    if (ty === "float4") return { sqlType: "float4", nullable: true };
    if (ty === "float8") return { sqlType: "float8", nullable: true };
  }
  if (fn === "avg") {
    if (["int2", "int4", "int8", "numeric"].includes(ty))
      return { sqlType: "numeric", nullable: true };
    if (["float4", "float8"].includes(ty))
      return { sqlType: "float8", nullable: true };
  }
  return fail("XQL_UNSUPPORTED_SQL", `cannot derive PostgreSQL ${fn.toUpperCase()} result for type "${input.sqlType}"; use an explicit cast`);
}

function paramNumber(value: unknown): number | null {
  const param = unwrap(value, "ParamRef");
  return typeof param?.number === "number" ? param.number : null;
}

function setParam(
  ctx: ResolveContext,
  number: number,
  sqlType: string,
  nullable: boolean,
): void {
  const next = { sqlType: canonicalSqlType(sqlType), nullable };
  const previous = ctx.params.get(number);
  if (previous !== undefined && canonicalSqlType(previous.sqlType) !== next.sqlType)
    fail("XQL_PARAM_TYPE_CONFLICT", `parameter $${number} is inferred as both ${previous.sqlType} and ${next.sqlType}`);
  if (previous === undefined || (previous.nullable && !nullable)) ctx.params.set(number, next);
}

function resolveExpr(
  value: unknown,
  scope: readonly ScopeEntry[],
  ctx: ResolveContext,
): ResolvedExpr {
  const node = kindOf(value);
  if (node === null)
    return fail("XQL_UNSUPPORTED_SQL", "cannot resolve empty expression");

  switch (node.kind) {
    case "ColumnRef": {
      const { entry, column } = columnFromRef(node.value, scope);
      return {
        sqlType: canonicalSqlType(column.sqlType),
        nullable: column.nullable || entry.nullable,
        ...(column.enumValues ? { enumValues: column.enumValues } : {}),
      };
    }
    case "TypeCast": {
      const type = unwrap(node.value.typeName, "TypeName") ?? asObj(node.value.typeName);
      if (type === null) return fail("XQL_UNSUPPORTED_SQL", "invalid TypeCast");
      const sqlType = typeName(type);
      let nullable = false;
      try { nullable = resolveExpr(node.value.arg, scope, ctx).nullable; } catch { nullable = true; }
      return { sqlType, nullable };
    }
    case "A_Const": {
      if (node.value.isnull === true) return { sqlType: "unknown", nullable: true };
      const val = asObj(node.value.val) ?? node.value;
      if (val.ival !== undefined || unwrap(node.value.val, "Integer") !== null)
        return { sqlType: "int4", nullable: false };
      if (val.fval !== undefined || unwrap(node.value.val, "Float") !== null)
        return { sqlType: "numeric", nullable: false };
      if (val.boolval !== undefined || unwrap(node.value.val, "Boolean") !== null)
        return { sqlType: "bool", nullable: false };
      return { sqlType: "text", nullable: false };
    }
    case "FuncCall": {
      const fnNames = strings(node.value.funcname);
      const fn = fnNames[fnNames.length - 1]?.toLowerCase();
      if (fn === undefined) return fail("XQL_UNSUPPORTED_SQL", "function call has no name");
      if (fn === "count") return { sqlType: "int8", nullable: false };
      const args = Array.isArray(node.value.args) ? node.value.args : [];
      if (["sum", "avg", "min", "max"].includes(fn)) {
        if (args.length !== 1)
          return fail("XQL_UNSUPPORTED_SQL", `${fn}() arity is not supported`);
        return aggregateResult(fn, resolveExpr(args[0], scope, ctx));
      }
      if (fn === "coalesce") {
        if (args.length === 0) return fail("XQL_UNSUPPORTED_SQL", "coalesce() has no arguments");
        const resolved = args.map((arg) => resolveExpr(arg, scope, ctx));
        const first = resolved[0]!;
        return { ...first, nullable: resolved.every((arg) => arg.nullable) };
      }
      return fail("XQL_UNSUPPORTED_SQL", `cannot derive return type of PostgreSQL function "${fn}"; add an explicit cast`);
    }
    case "CoalesceExpr": {
      const args = Array.isArray(node.value.args) ? node.value.args : [];
      if (args.length === 0) return fail("XQL_UNSUPPORTED_SQL", "coalesce expression has no arguments");
      const resolved = args.map((arg) => resolveExpr(arg, scope, ctx));
      return { ...resolved[0]!, nullable: resolved.every((arg) => arg.nullable) };
    }
    case "NullTest":
    case "BooleanTest":
    case "BoolExpr":
      return { sqlType: "bool", nullable: false };
    case "A_Expr": {
      const op = strings(node.value.name).join(" ").toLowerCase();
      if (["=", "<", ">", "<=", ">=", "!=", "<>", "like", "ilike", "~~", "~~*"].includes(op))
        return { sqlType: "bool", nullable: false };
      const left = node.value.lexpr ? resolveExpr(node.value.lexpr, scope, ctx) : null;
      const right = node.value.rexpr ? resolveExpr(node.value.rexpr, scope, ctx) : null;
      if (left && right) {
        const rank = ["int2", "int4", "int8", "numeric", "float4", "float8"];
        const li = rank.indexOf(canonicalSqlType(left.sqlType));
        const ri = rank.indexOf(canonicalSqlType(right.sqlType));
        if (li !== -1 && ri !== -1)
          return { sqlType: rank[Math.max(li, ri)]!, nullable: left.nullable || right.nullable };
      }
      return fail("XQL_UNSUPPORTED_SQL", `cannot derive type of operator expression "${op}"; add an explicit cast`);
    }
    case "SQLValueFunction": {
      const op = String(node.value.op ?? "").toUpperCase();
      if (op.includes("DATE")) return { sqlType: "date", nullable: false };
      if (op.includes("TIMESTAMP")) return { sqlType: "timestamptz", nullable: false };
      return fail("XQL_UNSUPPORTED_SQL", `unsupported SQL value function ${op}`);
    }
    case "CollateClause":
      return resolveExpr(node.value.arg, scope, ctx);
    case "CaseExpr": {
      const results: ResolvedExpr[] = [];
      for (const raw of Array.isArray(node.value.args) ? node.value.args : []) {
        const when = unwrap(raw, "CaseWhen");
        if (when?.result !== undefined) results.push(resolveExpr(when.result, scope, ctx));
      }
      if (node.value.defresult !== undefined) results.push(resolveExpr(node.value.defresult, scope, ctx));
      if (results.length === 0) return fail("XQL_UNSUPPORTED_SQL", "CASE has no result expressions");
      return { ...results[0]!, nullable: results.some((r) => r.nullable) };
    }
    case "ParamRef":
      return fail("XQL_UNRESOLVED_PARAM", `parameter $${node.value.number} needs a type context or explicit cast`);
    default:
      return fail("XQL_UNSUPPORTED_SQL", `unsupported PostgreSQL AST expression ${node.kind}; add an explicit cast or compiler support`);
  }
}

function inferParams(value: unknown, scope: readonly ScopeEntry[], ctx: ResolveContext): void {
  const node = kindOf(value);
  if (node === null) return;

  if (node.kind === "TypeCast") {
    const number = paramNumber(node.value.arg);
    const type = unwrap(node.value.typeName, "TypeName") ?? asObj(node.value.typeName);
    if (number !== null && type !== null) setParam(ctx, number, typeName(type), false);
  }

  if (node.kind === "A_Expr") {
    const leftNumber = paramNumber(node.value.lexpr);
    const rightNumber = paramNumber(node.value.rexpr);
    if (leftNumber !== null && node.value.rexpr !== undefined) {
      const other = resolveExpr(node.value.rexpr, scope, ctx);
      setParam(ctx, leftNumber, other.sqlType, false);
    }
    if (rightNumber !== null && node.value.lexpr !== undefined) {
      const other = resolveExpr(node.value.lexpr, scope, ctx);
      setParam(ctx, rightNumber, other.sqlType, false);
    }
  }

  for (const child of Object.values(node.value)) {
    if (Array.isArray(child)) for (const item of child) inferParams(item, scope, ctx);
    else if (asObj(child) !== null) inferParams(child, scope, ctx);
  }
}

function sourceFromRange(value: unknown, ctx: ResolveContext): ScopeEntry[] {
  const node = kindOf(value);
  if (node === null) return [];
  if (node.kind === "RangeVar") {
    const table = tableFor(ctx, node.value);
    return [{
      alias: aliasName(node.value, table.name),
      label: table.name,
      columns: table.columns,
      nullable: false,
    }];
  }
  if (node.kind === "RangeSubselect") {
    const alias = aliasName(node.value, "subquery");
    if (node.value.subquery === undefined)
      return fail("XQL_UNSUPPORTED_SQL", "FROM subquery has no query");
    const result = analyzeStatementNode(node.value.subquery, ctx);
    const columns: Record<string, CatalogColumn> = {};
    for (const column of result.columns) columns[column.name] = column;
    return [{ alias, label: alias, columns, nullable: false }];
  }
  if (node.kind === "JoinExpr") {
    let left = sourceFromRange(node.value.larg, ctx);
    let right = sourceFromRange(node.value.rarg, ctx);
    const joinType = String(node.value.jointype ?? "JOIN_INNER");
    if (joinType === "JOIN_LEFT") right = right.map((x) => ({ ...x, nullable: true }));
    if (joinType === "JOIN_RIGHT") left = left.map((x) => ({ ...x, nullable: true }));
    if (joinType === "JOIN_FULL") {
      left = left.map((x) => ({ ...x, nullable: true }));
      right = right.map((x) => ({ ...x, nullable: true }));
    }
    const scope = [...left, ...right];
    if (node.value.quals !== undefined) {
      inferParams(node.value.quals, scope, ctx);
      // Resolve every ColumnRef as a semantic-validation pass.
      validateColumnRefs(node.value.quals, scope, ctx);
    }
    if (Array.isArray(node.value.usingClause)) {
      for (const raw of node.value.usingClause) {
        const name = stringValue(raw);
        if (name === null) continue;
        const onLeft = left.some((entry) => entry.columns[name] !== undefined);
        const onRight = right.some((entry) => entry.columns[name] !== undefined);
        if (!onLeft || !onRight)
          fail("XQL_UNKNOWN_COLUMN", `JOIN USING column "${name}" must exist on both sides`);
      }
    }
    return scope;
  }
  return fail("XQL_UNSUPPORTED_SQL", `unsupported FROM node ${node.kind}`);
}

function validateColumnRefs(value: unknown, scope: readonly ScopeEntry[], ctx: ResolveContext): void {
  const node = kindOf(value);
  if (node === null) return;
  if (node.kind === "ColumnRef") {
    columnFromRef(node.value, scope);
    return;
  }
  for (const child of Object.values(node.value)) {
    if (Array.isArray(child)) for (const item of child) validateColumnRefs(item, scope, ctx);
    else if (asObj(child) !== null) validateColumnRefs(child, scope, ctx);
  }
}

function scopeFromList(values: unknown, ctx: ResolveContext): ScopeEntry[] {
  const out: ScopeEntry[] = [];
  if (Array.isArray(values)) for (const value of values) out.push(...sourceFromRange(value, ctx));
  return out;
}

function isStar(value: unknown): { qualifier: string | null } | null {
  const column = unwrap(value, "ColumnRef");
  if (column === null || !Array.isArray(column.fields)) return null;
  const fields = column.fields;
  const last = fields[fields.length - 1];
  if (unwrap(last, "A_Star") === null && kindOf(last)?.kind !== "A_Star") return null;
  const qualifiers = fields.slice(0, -1).map(stringValue).filter((x): x is string => x !== null);
  return { qualifier: qualifiers.length === 0 ? null : qualifiers[qualifiers.length - 1]! };
}

function defaultOutputName(value: unknown): string | null {
  const node = kindOf(value);
  if (node === null) return null;
  if (node.kind === "ColumnRef") {
    const names = (Array.isArray(node.value.fields) ? node.value.fields : [])
      .map(stringValue).filter((x): x is string => x !== null);
    return names[names.length - 1] ?? null;
  }
  if (node.kind === "FuncCall") {
    const names = strings(node.value.funcname);
    return names[names.length - 1] ?? null;
  }
  if (node.kind === "TypeCast") return defaultOutputName(node.value.arg);
  return null;
}

function targets(
  values: unknown,
  scope: readonly ScopeEntry[],
  ctx: ResolveContext,
): CompiledColumn[] {
  const out: CompiledColumn[] = [];
  const names = new Set<string>();
  const push = (column: CompiledColumn) => {
    if (names.has(column.name))
      fail("XQL_DUPLICATE_OUTPUT", `query returns duplicate column name "${column.name}"; alias one of the expressions explicitly`);
    names.add(column.name);
    out.push(column);
  };

  if (!Array.isArray(values)) return out;
  for (const rawTarget of values) {
    const target = unwrap(rawTarget, "ResTarget") ?? asObj(rawTarget);
    if (target === null || target.val === undefined) continue;
    const star = isStar(target.val);
    if (star !== null) {
      const entries = star.qualifier === null
        ? scope
        : scope.filter((entry) => entry.alias === star.qualifier || entry.label === star.qualifier);
      if (entries.length === 0)
        fail("XQL_UNKNOWN_TABLE", `unknown table/alias "${star.qualifier}" for * expansion`);
      for (const entry of entries)
        for (const column of Object.values(entry.columns))
          push({
            name: column.name,
            sqlType: canonicalSqlType(column.sqlType),
            nullable: column.nullable || entry.nullable,
            ...(column.enumValues ? { enumValues: column.enumValues } : {}),
          });
      continue;
    }

    inferParams(target.val, scope, ctx);
    validateColumnRefs(target.val, scope, ctx);
    const resolved = resolveExpr(target.val, scope, ctx);
    const name = typeof target.name === "string" ? target.name : defaultOutputName(target.val);
    if (name === null)
      fail("XQL_UNSUPPORTED_SQL", "computed SELECT/RETURNING expression needs an explicit alias for stable object output");
    push({
      name,
      sqlType: canonicalSqlType(resolved.sqlType),
      nullable: resolved.nullable,
      ...(resolved.enumValues ? { enumValues: resolved.enumValues } : {}),
    });
  }
  return out;
}

function processWith(owner: Obj, ctx: ResolveContext): void {
  const withClause = unwrap(owner.withClause, "WithClause") ?? asObj(owner.withClause);
  if (withClause === null) return;
  if (withClause.recursive === true)
    fail("XQL_UNSUPPORTED_SQL", "WITH RECURSIVE is not supported by the compiler yet");
  const ctes = Array.isArray(withClause.ctes) ? withClause.ctes : [];
  for (const raw of ctes) {
    const cte = unwrap(raw, "CommonTableExpr") ?? asObj(raw);
    if (cte === null || typeof cte.ctename !== "string" || cte.ctequery === undefined)
      fail("XQL_UNSUPPORTED_SQL", "malformed common table expression");
    const result = analyzeStatementNode(cte.ctequery, ctx);
    const columns: Record<string, CatalogColumn> = {};
    for (const column of result.columns) columns[column.name] = column;
    ctx.ctes.set(cte.ctename, { schema: "<cte>", name: cte.ctename, columns });
  }
}

function analyzeSelect(stmt: Obj, ctx: ResolveContext): AnalyzedStatement {
  processWith(stmt, ctx);
  const scope = scopeFromList(stmt.fromClause, ctx);
  if (stmt.whereClause !== undefined) {
    inferParams(stmt.whereClause, scope, ctx);
    validateColumnRefs(stmt.whereClause, scope, ctx);
  }
  if (stmt.havingClause !== undefined) {
    inferParams(stmt.havingClause, scope, ctx);
    validateColumnRefs(stmt.havingClause, scope, ctx);
  }
  for (const value of Array.isArray(stmt.groupClause) ? stmt.groupClause : [])
    validateColumnRefs(value, scope, ctx);
  for (const value of Array.isArray(stmt.sortClause) ? stmt.sortClause : [])
    validateColumnRefs(value, scope, ctx);
  if (stmt.limitCount !== undefined) {
    const n = paramNumber(stmt.limitCount);
    if (n !== null) setParam(ctx, n, "int8", false);
  }
  if (stmt.limitOffset !== undefined) {
    const n = paramNumber(stmt.limitOffset);
    if (n !== null) setParam(ctx, n, "int8", false);
  }
  return { kind: "select", columns: targets(stmt.targetList, scope, ctx), paramsByNumber: ctx.params };
}

function targetRelation(value: unknown, ctx: ResolveContext): { table: CatalogTable; entry: ScopeEntry } {
  const relation = unwrap(value, "RangeVar") ?? asObj(value);
  if (relation === null) return fail("XQL_UNSUPPORTED_SQL", "write statement has no target relation");
  const table = tableFor(ctx, relation);
  return {
    table,
    entry: { alias: aliasName(relation, table.name), label: table.name, columns: table.columns, nullable: false },
  };
}

function listItems(value: unknown): readonly unknown[] {
  const list = unwrap(value, "List") ?? asObj(value);
  return Array.isArray(list?.items) ? list.items : [];
}

function analyzeInsert(stmt: Obj, ctx: ResolveContext): AnalyzedStatement {
  processWith(stmt, ctx);
  const { table, entry } = targetRelation(stmt.relation, ctx);
  const requested = Array.isArray(stmt.cols)
    ? stmt.cols.map((raw) => unwrap(raw, "ResTarget") ?? asObj(raw))
      .map((target) => typeof target?.name === "string" ? target.name : null)
      .filter((x): x is string => x !== null)
    : Object.keys(table.columns);
  const select = unwrap(stmt.selectStmt, "SelectStmt") ?? asObj(stmt.selectStmt);
  if (select !== null && Array.isArray(select.valuesLists)) {
    for (const row of select.valuesLists) {
      const values = listItems(row);
      for (let i = 0; i < Math.min(values.length, requested.length); i++) {
        const column = table.columns[requested[i]!];
        if (column === undefined)
          fail("XQL_UNKNOWN_COLUMN", `unknown INSERT column "${requested[i]}" on ${table.name}`);
        const n = paramNumber(values[i]);
        if (n !== null) setParam(ctx, n, column.sqlType, column.nullable);
        inferParams(values[i], [entry], ctx);
      }
    }
  } else if (select !== null) {
    // INSERT ... SELECT still gets full semantic validation of the SELECT.
    analyzeSelect(select, ctx);
  }
  if (stmt.onConflictClause !== undefined) inferParams(stmt.onConflictClause, [entry], ctx);
  return { kind: "insert", columns: targets(stmt.returningList, [entry], ctx), paramsByNumber: ctx.params };
}

function analyzeUpdate(stmt: Obj, ctx: ResolveContext): AnalyzedStatement {
  processWith(stmt, ctx);
  const { table, entry } = targetRelation(stmt.relation, ctx);
  const scope = [entry, ...scopeFromList(stmt.fromClause, ctx)];
  for (const raw of Array.isArray(stmt.targetList) ? stmt.targetList : []) {
    const target = unwrap(raw, "ResTarget") ?? asObj(raw);
    if (target === null || typeof target.name !== "string" || target.val === undefined) continue;
    const column = table.columns[target.name];
    if (column === undefined)
      fail("XQL_UNKNOWN_COLUMN", `unknown UPDATE column "${target.name}" on ${table.name}`);
    const n = paramNumber(target.val);
    if (n !== null) setParam(ctx, n, column.sqlType, column.nullable);
    inferParams(target.val, scope, ctx);
  }
  if (stmt.whereClause !== undefined) {
    inferParams(stmt.whereClause, scope, ctx);
    validateColumnRefs(stmt.whereClause, scope, ctx);
  }
  return { kind: "update", columns: targets(stmt.returningList, scope, ctx), paramsByNumber: ctx.params };
}

function analyzeDelete(stmt: Obj, ctx: ResolveContext): AnalyzedStatement {
  processWith(stmt, ctx);
  const { entry } = targetRelation(stmt.relation, ctx);
  const scope = [entry, ...scopeFromList(stmt.usingClause, ctx)];
  if (stmt.whereClause !== undefined) {
    inferParams(stmt.whereClause, scope, ctx);
    validateColumnRefs(stmt.whereClause, scope, ctx);
  }
  return { kind: "delete", columns: targets(stmt.returningList, scope, ctx), paramsByNumber: ctx.params };
}

function statementPayload(value: unknown): { kind: string; value: Obj } {
  let object = asObj(value);
  if (object === null) return fail("XQL_UNSUPPORTED_SQL", "empty PostgreSQL statement");
  const raw = unwrap(object, "RawStmt");
  if (raw !== null) object = raw;
  if (object.stmt !== undefined) object = asObj(object.stmt) ?? object;
  const node = kindOf(object);
  if (node === null) return fail("XQL_UNSUPPORTED_SQL", "unknown PostgreSQL statement shape");
  return node;
}

function analyzeStatementNode(value: unknown, parent: ResolveContext): AnalyzedStatement {
  const node = statementPayload(value);
  const ctx: ResolveContext = {
    catalog: parent.catalog,
    params: parent.params,
    ctes: new Map(parent.ctes),
  };
  if (node.kind === "SelectStmt") return analyzeSelect(node.value, ctx);
  if (node.kind === "InsertStmt") return analyzeInsert(node.value, ctx);
  if (node.kind === "UpdateStmt") return analyzeUpdate(node.value, ctx);
  if (node.kind === "DeleteStmt") return analyzeDelete(node.value, ctx);
  return fail("XQL_UNSUPPORTED_SQL", `statement ${node.kind} is not a query XQL can execute`);
}

export function analyzePostgresStatement(
  rawStatement: unknown,
  catalog: CompilerCatalog,
): AnalyzedStatement {
  const ctx: ResolveContext = {
    catalog,
    params: new Map(),
    ctes: new Map(),
  };
  return analyzeStatementNode(rawStatement, ctx);
}
