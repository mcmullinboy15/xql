import { PGlite } from "@electric-sql/pglite";
import { z } from "zod";
import {
  castZod,
  column,
  type Codec,
  type SchemaDef,
} from "../schema.ts";
import type {
  CatalogSnapshot,
  CompilerDatabase,
  PgTypeInfo,
} from "./types.ts";

const quoteIdent = (value: string) => `"${value.replaceAll('"', '""')}"`;

function quoteRelation(value: string): string {
  return value.split(".").map(quoteIdent).join(".");
}

export function schemaToDdl(schema: SchemaDef): string {
  const schemas = new Set<string>();
  const statements: string[] = [];

  for (const tableName of Object.keys(schema)) {
    const parts = tableName.split(".");
    if (parts.length > 1) schemas.add(parts.slice(0, -1).join("."));
  }
  for (const name of schemas) statements.push(`create schema if not exists ${quoteRelation(name)};`);

  for (const [tableName, table] of Object.entries(schema)) {
    const columns = Object.entries(table).map(([name, def]) =>
      `  ${quoteIdent(name)} ${def.sqlType}${def.isNullable ? "" : " not null"}`,
    );
    statements.push(`create table ${quoteRelation(tableName)} (\n${columns.join(",\n")}\n);`);
  }
  return statements.join("\n\n");
}

export async function createPgliteCompilerDatabase(options: {
  readonly ddl?: string;
  readonly schema?: SchemaDef;
} = {}): Promise<CompilerDatabase & { close(): Promise<void> }> {
  const db = await PGlite.create();
  const ddl = [options.schema ? schemaToDdl(options.schema) : "", options.ddl ?? ""]
    .filter((part) => part.trim() !== "")
    .join("\n");
  if (ddl) await db.exec(ddl);
  return {
    describeQuery: async (query) => {
      const result = await db.describeQuery(query);
      return {
        queryParams: result.queryParams.map((param) => ({ dataTypeID: param.dataTypeID })),
        resultFields: result.resultFields.map((field) => ({ name: field.name, dataTypeID: field.dataTypeID })),
      };
    },
    query: async <T extends Record<string, unknown> = Record<string, unknown>>(query: string, params?: unknown[]) => {
      const result = await db.query<T>(query, params);
      return { rows: result.rows };
    },
    exec: (query) => db.exec(query),
    close: () => db.close(),
  };
}

const TYPE_CATALOG_SQL = `
select
  t.oid::int as oid,
  n.nspname as schema_name,
  t.typname as type_name,
  t.typtype as type_kind,
  t.typelem::int as element_oid,
  t.typbasetype::int as base_oid,
  coalesce(
    (select json_agg(e.enumlabel order by e.enumsortorder)
       from pg_enum e where e.enumtypid = t.oid),
    '[]'::json
  ) as enum_values
from pg_type t
join pg_namespace n on n.oid = t.typnamespace
order by t.oid
`;

const COLUMN_CATALOG_SQL = `
select
  n.nspname as schema_name,
  c.relname as table_name,
  a.attname as column_name,
  a.attnum::int as ordinal,
  a.atttypid::int as type_oid,
  (not a.attnotnull) as nullable
from pg_attribute a
join pg_class c on c.oid = a.attrelid
join pg_namespace n on n.oid = c.relnamespace
where a.attnum > 0
  and not a.attisdropped
  and c.relkind in ('r', 'p', 'v', 'm', 'f')
  and n.nspname not in ('pg_catalog', 'information_schema')
order by n.nspname, c.relname, a.attnum
`;

export async function snapshotCatalog(db: CompilerDatabase): Promise<CatalogSnapshot> {
  const versionResult = await db.query<{ server_version_num: string }>("show server_version_num");
  const postgresVersion = String(versionResult.rows[0]?.server_version_num ?? "unknown");
  const typeResult = await db.query<{
    oid: number;
    schema_name: string;
    type_name: string;
    type_kind: string;
    element_oid: number;
    base_oid: number;
    enum_values: unknown;
  }>(TYPE_CATALOG_SQL);
  const columnResult = await db.query<{
    schema_name: string;
    table_name: string;
    column_name: string;
    ordinal: number;
    type_oid: number;
    nullable: boolean;
  }>(COLUMN_CATALOG_SQL);

  return {
    postgresVersion,
    types: typeResult.rows.map((row) => ({
      oid: Number(row.oid),
      schema: row.schema_name,
      name: row.type_name,
      kind: row.type_kind,
      elementOid: Number(row.element_oid),
      baseOid: Number(row.base_oid),
      enumValues: Array.isArray(row.enum_values)
        ? row.enum_values.map(String)
        : typeof row.enum_values === "string"
          ? (JSON.parse(row.enum_values) as unknown[]).map(String)
          : [],
    })),
    columns: columnResult.rows.map((row) => ({
      schema: row.schema_name,
      table: row.table_name,
      name: row.column_name,
      ordinal: Number(row.ordinal),
      typeOid: Number(row.type_oid),
      nullable: Boolean(row.nullable),
    })),
  };
}

const BUILTIN_NAMES: Record<string, string> = {
  bool: "bool",
  int2: "int2",
  int4: "int4",
  int8: "int8",
  float4: "float4",
  float8: "float8",
  numeric: "numeric",
  text: "text",
  varchar: "varchar",
  bpchar: "char",
  timestamptz: "timestamptz",
  timestamp: "timestamp",
  date: "date",
  uuid: "uuid",
  json: "json",
  jsonb: "jsonb",
  bytea: "bytea",
};

export interface ResolvedPgType {
  readonly sqlType: string;
  readonly baseType?: string;
  readonly enumValues?: readonly string[];
}

export function resolvePgType(
  oid: number,
  types: ReadonlyMap<number, PgTypeInfo>,
  seen: ReadonlySet<number> = new Set(),
): ResolvedPgType {
  if (seen.has(oid)) return { sqlType: `oid:${oid}` };
  const info = types.get(oid);
  if (!info) return { sqlType: `oid:${oid}` };
  const nextSeen = new Set(seen).add(oid);

  if (info.elementOid) {
    const element = resolvePgType(info.elementOid, types, nextSeen);
    return {
      sqlType: `${element.sqlType}[]`,
      baseType: element.baseType ? `${element.baseType}[]` : undefined,
      enumValues: element.enumValues,
    };
  }

  if (info.kind === "d" && info.baseOid) {
    const base = resolvePgType(info.baseOid, types, nextSeen);
    return {
      sqlType: `${info.schema}.${info.name}`,
      baseType: base.baseType ?? base.sqlType,
      enumValues: base.enumValues,
    };
  }

  if (info.kind === "e") {
    return {
      sqlType: `${info.schema}.${info.name}`,
      enumValues: info.enumValues,
    };
  }

  return { sqlType: BUILTIN_NAMES[info.name] ?? `${info.schema}.${info.name}` };
}

function codecForResolvedType(type: ResolvedPgType): Codec<unknown> {
  if (!type.sqlType.endsWith("[]") && type.baseType?.endsWith("[]")) {
    return codecForResolvedType({ sqlType: type.baseType });
  }
  if (type.sqlType.endsWith("[]")) {
    const elementBase = type.baseType?.endsWith("[]") ? type.baseType.slice(0, -2) : undefined;
    return z.array(codecForResolvedType({
      sqlType: type.sqlType.slice(0, -2),
      baseType: elementBase,
      enumValues: type.enumValues,
    }));
  }
  if (type.enumValues && type.enumValues.length > 0)
    return z.enum(type.enumValues as unknown as [string, ...string[]]);
  return castZod[type.sqlType] ?? (type.baseType ? castZod[type.baseType] : undefined) ?? z.unknown();
}

/** Build a SchemaDef from the real catalog solely to reuse XQL's nullability analysis. */
export function catalogToSchema(catalog: CatalogSnapshot): SchemaDef {
  const typeMap = new Map(catalog.types.map((type) => [type.oid, type]));
  const tables: Record<string, Record<string, ReturnType<typeof column>>> = {};
  for (const item of catalog.columns) {
    const key = item.schema === "public" ? item.table : `${item.schema}.${item.table}`;
    const table = (tables[key] ??= {});
    const type = resolvePgType(item.typeOid, typeMap);
    const base = column(type.sqlType, codecForResolvedType(type));
    table[item.name] = item.nullable ? base.nullable() : base;
    if (item.schema === "public") tables[`public.${item.table}`] = table;
  }
  return tables;
}
