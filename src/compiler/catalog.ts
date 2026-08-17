import type {
  CatalogAdapter,
  CatalogColumn,
  CatalogTable,
  CompilerCatalog,
} from "./types.ts";

const COLUMNS_SQL = `
select
  c.table_schema,
  c.table_name,
  c.column_name,
  c.udt_schema,
  c.udt_name,
  c.is_nullable,
  c.ordinal_position
from information_schema.columns c
where c.table_schema = any($1::text[])
order by c.table_schema, c.table_name, c.ordinal_position
`;

const ENUMS_SQL = `
select
  ns.nspname as type_schema,
  t.typname as type_name,
  e.enumlabel as enum_value,
  e.enumsortorder
from pg_catalog.pg_type t
join pg_catalog.pg_namespace ns on ns.oid = t.typnamespace
join pg_catalog.pg_enum e on e.enumtypid = t.oid
where ns.nspname = any($1::text[])
order by ns.nspname, t.typname, e.enumsortorder
`;

interface ColumnRow {
  table_schema: string;
  table_name: string;
  column_name: string;
  udt_schema: string;
  udt_name: string;
  is_nullable: "YES" | "NO";
  ordinal_position: number;
}

interface EnumRow {
  type_schema: string;
  type_name: string;
  enum_value: string;
  enumsortorder: number;
}

async function rowsOf<Row>(
  adapter: CatalogAdapter,
  text: string,
  values: readonly unknown[],
): Promise<readonly Row[]> {
  const result = await adapter.query<Row>(text, values);
  return Array.isArray(result) ? result : result.rows;
}

/**
 * Pulls the database schema from PostgreSQL itself. `udt_name` is used rather
 * than the friendlier information_schema `data_type` so domains/enums and exact
 * PostgreSQL types remain identifiable.
 */
export async function pullCatalog(
  adapter: CatalogAdapter,
  searchPath: readonly string[] = ["public"],
): Promise<CompilerCatalog> {
  const [columns, enums] = await Promise.all([
    rowsOf<ColumnRow>(adapter, COLUMNS_SQL, [searchPath]),
    rowsOf<EnumRow>(adapter, ENUMS_SQL, [searchPath]),
  ]);

  const enumValues = new Map<string, string[]>();
  for (const row of enums) {
    const key = `${row.type_schema}.${row.type_name}`;
    const values = enumValues.get(key) ?? [];
    values.push(row.enum_value);
    enumValues.set(key, values);
  }

  const mutable = new Map<string, {
    schema: string;
    name: string;
    columns: Record<string, CatalogColumn>;
  }>();

  for (const row of columns) {
    const key = `${row.table_schema}.${row.table_name}`;
    const table = mutable.get(key) ?? {
      schema: row.table_schema,
      name: row.table_name,
      columns: {},
    };
    const enumKey = `${row.udt_schema}.${row.udt_name}`;
    table.columns[row.column_name] = {
      name: row.column_name,
      sqlType: row.udt_name,
      nullable: row.is_nullable === "YES",
      ...(enumValues.has(enumKey) ? { enumValues: enumValues.get(enumKey)! } : {}),
    };
    mutable.set(key, table);
  }

  const tables: Record<string, CatalogTable> = {};
  for (const [key, table] of mutable) tables[key] = table;
  return { version: 1, searchPath: [...searchPath], tables };
}

export interface CatalogDiff {
  readonly missingTables: readonly string[];
  readonly extraTables: readonly string[];
  readonly changedColumns: readonly string[];
  readonly equal: boolean;
}

/** Used by CI to prove a checked-in catalog has not drifted from PostgreSQL. */
export function diffCatalog(expected: CompilerCatalog, actual: CompilerCatalog): CatalogDiff {
  const expectedTables = new Set(Object.keys(expected.tables));
  const actualTables = new Set(Object.keys(actual.tables));
  const missingTables = [...expectedTables].filter((x) => !actualTables.has(x)).sort();
  const extraTables = [...actualTables].filter((x) => !expectedTables.has(x)).sort();
  const changedColumns: string[] = [];

  for (const tableName of expectedTables) {
    const a = expected.tables[tableName];
    const b = actual.tables[tableName];
    if (a === undefined || b === undefined) continue;
    const names = new Set([...Object.keys(a.columns), ...Object.keys(b.columns)]);
    for (const columnName of names) {
      const ac = a.columns[columnName];
      const bc = b.columns[columnName];
      if (JSON.stringify(ac) !== JSON.stringify(bc))
        changedColumns.push(`${tableName}.${columnName}`);
    }
  }

  changedColumns.sort();
  return {
    missingTables,
    extraTables,
    changedColumns,
    equal: missingTables.length === 0 && extraTables.length === 0 && changedColumns.length === 0,
  };
}

const TYPE_BUILDERS: Readonly<Record<string, string>> = {
  int8: "int8",
  int4: "int4",
  int2: "int2",
  float8: "float8",
  float4: "float4",
  text: "text",
  varchar: "varchar",
  bool: "bool",
  numeric: "numeric",
  timestamptz: "timestamptz",
  timestamp: "timestamp",
  date: "date",
  uuid: "uuid",
  bytea: "bytea",
  json: "json",
  jsonb: "jsonb",
};

function columnSource(column: CatalogColumn): string {
  let base: string;
  if (column.enumValues !== undefined && column.enumValues.length > 0) {
    base = `t.enum(${JSON.stringify(column.enumValues)} as [string, ...string[]])`;
  } else {
    const builder = TYPE_BUILDERS[column.sqlType];
    base = builder === undefined
      ? `t.custom(${JSON.stringify(column.sqlType)}, z.unknown())`
      : `t.${builder}()`;
  }
  return column.nullable ? `${base}.nullable()` : base;
}

/** Emits the optional legacy defineSchema() mirror from the authoritative catalog. */
export function emitSchemaModule(catalog: CompilerCatalog): string {
  const lines = [
    `import { z } from "zod";`,
    `import { defineSchema, t } from "xql";`,
    ``,
    `// Generated by xql schema pull. Do not edit by hand.`,
    `export const schema = defineSchema({`,
  ];
  for (const [qualified, table] of Object.entries(catalog.tables)) {
    const key = catalog.searchPath.includes(table.schema) ? table.name : qualified;
    lines.push(`  ${JSON.stringify(key)}: {`);
    for (const column of Object.values(table.columns))
      lines.push(`    ${JSON.stringify(column.name)}: ${columnSource(column)},`);
    lines.push(`  },`);
  }
  lines.push(`});`, ``);
  return lines.join("\n");
}

export { COLUMNS_SQL, ENUMS_SQL };
