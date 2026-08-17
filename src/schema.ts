import { z } from "zod";

/** Output type is pinned; input is whatever the driver produced. */
export type Codec<T> = z.ZodType<T, unknown>;

/**
 * A column carries both its JavaScript output type and its SQL type name.
 * Keeping SqlType literal is important: `int4` and `float8` are both `number`
 * in TypeScript, but PostgreSQL gives them different aggregate result types.
 */
export interface Column<T, SqlType extends string = string> {
  readonly zod: Codec<T>;
  readonly sqlType: SqlType;
  readonly isNullable: boolean;
  nullable(): Column<T | null, SqlType>;
}

function makeColumn<T, const SqlType extends string>(
  sqlType: SqlType,
  zod: Codec<T>,
  isNullable = false,
): Column<T, SqlType> {
  return {
    zod,
    sqlType,
    isNullable,
    nullable: () => makeColumn<T | null, SqlType>(sqlType, zod.nullable(), true),
  };
}

/**
 * Drivers disagree on the JS representation of the same SQL type: node-postgres
 * decodes int8 as a string, PGlite as a number, Prisma as a bigint. Codecs
 * accept every representation and normalise to one declared TypeScript type.
 */
const asBigint = z.preprocess((v) => {
  if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return BigInt(v);
  return v;
}, z.bigint());

const asNumber = z.preprocess(
  (v) => (typeof v === "string" && v.trim() !== "" ? Number(v) : v),
  z.number(),
);

const asNumericString = z.preprocess(
  (v) => (typeof v === "number" || typeof v === "bigint" ? String(v) : v),
  z.string(),
);

const asDate = z.preprocess(
  (v) => (typeof v === "string" || typeof v === "number" ? new Date(v) : v),
  z.date(),
);

const asBoolean = z.preprocess(
  (v) => (v === "t" ? true : v === "f" ? false : v),
  z.boolean(),
);

/** Pin the output to plain Uint8Array while still normalising Node Buffers. */
const asBytes: Codec<Uint8Array> = z.preprocess(
  (v) => (typeof Buffer !== "undefined" && Buffer.isBuffer(v) ? new Uint8Array(v) : v),
  z.instanceof(Uint8Array),
);

export const t = {
  int8: () => makeColumn("int8", asBigint),
  int4: () => makeColumn("int4", asNumber),
  int2: () => makeColumn("int2", asNumber),
  float8: () => makeColumn("float8", asNumber),
  float4: () => makeColumn("float4", asNumber),
  text: () => makeColumn("text", z.string()),
  varchar: () => makeColumn("varchar", z.string()),
  bool: () => makeColumn("bool", asBoolean),
  numeric: () => makeColumn("numeric", asNumericString),
  timestamptz: () => makeColumn("timestamptz", asDate),
  timestamp: () => makeColumn("timestamp", asDate),
  date: () => makeColumn("date", asDate),
  uuid: () => makeColumn("uuid", z.string()),
  bytea: () => makeColumn("bytea", asBytes),
  bytes: () => makeColumn("bytes", asBytes),
  json: <T = unknown>(schema: Codec<T> = z.unknown() as Codec<T>) =>
    makeColumn("json", schema),
  jsonb: <T = unknown>(schema: Codec<T> = z.unknown() as Codec<T>) =>
    makeColumn("jsonb", schema),
  enum: <const V extends readonly [string, ...string[]]>(values: V) =>
    makeColumn<V[number], "text">("text", z.enum(values)),
  custom: <T, const SqlType extends string>(sqlType: SqlType, codec: Codec<T>) =>
    makeColumn(sqlType, codec),
};

export type TableDef = Record<string, Column<unknown, string>>;
export type SchemaDef = Record<string, TableDef>;

export type ColType<C> = C extends Column<infer T, string> ? T : never;
export type ColSqlType<C> = C extends Column<unknown, infer SqlType> ? SqlType : never;

export function defineSchema<const S extends SchemaDef>(schema: S): S {
  return schema;
}

/** SQL type names usable in a `::cast`, mapped to their TypeScript type. */
export interface CastTypes {
  int8: bigint;
  bigint: bigint;
  int4: number;
  int: number;
  integer: number;
  smallint: number;
  int2: number;
  serial: number;
  serial4: number;
  serial8: bigint;
  bigserial: bigint;
  oid: number;
  float8: number;
  float: number;
  float4: number;
  real: number;
  "double precision": number;
  text: string;
  string: string;
  varchar: string;
  char: string;
  bpchar: string;
  name: string;
  bool: boolean;
  boolean: boolean;
  numeric: string;
  decimal: string;
  timestamptz: Date;
  timestamp: Date;
  date: Date;
  time: string;
  timetz: string;
  interval: string;
  uuid: string;
  inet: string;
  bit: string;
  varbit: string;
  bytes: Uint8Array;
  bytea: Uint8Array;
  json: unknown;
  jsonb: unknown;
}

/** Functions whose result type is fixed independently of their arguments. */
export interface FnTypes {
  exists: boolean;
  "not exists": boolean;
  bool_and: boolean;
  bool_or: boolean;
  every: boolean;
  encode: string;
  to_char: string;
  to_hex: string;
  lower: string;
  upper: string;
  initcap: string;
  trim: string;
  btrim: string;
  ltrim: string;
  rtrim: string;
  md5: string;
  concat: string;
  concat_ws: string;
  replace: string;
  substr: string;
  substring: string;
  format: string;
  quote_ident: string;
  quote_literal: string;
  decode: Uint8Array;
  length: number;
  char_length: number;
  character_length: number;
  bit_length: number;
  octet_length: number;
  position: number;
  strpos: number;
  array_length: number;
  cardinality: number;
  row_number: bigint;
  rank: bigint;
  dense_rank: bigint;
  now: Date;
  clock_timestamp: Date;
  statement_timestamp: Date;
  transaction_timestamp: Date;
}

export const fnZod: Record<string, Codec<unknown>> = {
  exists: z.boolean(),
  "not exists": z.boolean(),
  bool_and: z.boolean(),
  bool_or: z.boolean(),
  every: z.boolean(),
  encode: z.string(),
  to_char: z.string(),
  to_hex: z.string(),
  lower: z.string(),
  upper: z.string(),
  initcap: z.string(),
  trim: z.string(),
  btrim: z.string(),
  ltrim: z.string(),
  rtrim: z.string(),
  md5: z.string(),
  concat: z.string(),
  concat_ws: z.string(),
  replace: z.string(),
  substr: z.string(),
  substring: z.string(),
  format: z.string(),
  quote_ident: z.string(),
  quote_literal: z.string(),
  decode: asBytes,
  length: asNumber,
  char_length: asNumber,
  character_length: asNumber,
  bit_length: asNumber,
  octet_length: asNumber,
  position: asNumber,
  strpos: asNumber,
  array_length: asNumber,
  cardinality: asNumber,
  row_number: asBigint,
  rank: asBigint,
  dense_rank: asBigint,
  now: asDate,
  clock_timestamp: asDate,
  statement_timestamp: asDate,
  transaction_timestamp: asDate,
};

export const castZod: Record<string, Codec<unknown>> = {
  int8: asBigint,
  bigint: asBigint,
  int4: asNumber,
  int: asNumber,
  integer: asNumber,
  smallint: asNumber,
  int2: asNumber,
  serial: asNumber,
  serial4: asNumber,
  serial8: asBigint,
  bigserial: asBigint,
  oid: asNumber,
  float8: asNumber,
  float: asNumber,
  float4: asNumber,
  real: asNumber,
  "double precision": asNumber,
  text: z.string(),
  string: z.string(),
  varchar: z.string(),
  char: z.string(),
  bpchar: z.string(),
  name: z.string(),
  bool: asBoolean,
  boolean: asBoolean,
  numeric: asNumericString,
  decimal: asNumericString,
  timestamptz: asDate,
  timestamp: asDate,
  date: asDate,
  time: z.string(),
  timetz: z.string(),
  interval: z.string(),
  uuid: z.string(),
  inet: z.string(),
  bit: z.string(),
  varbit: z.string(),
  bytes: asBytes,
  bytea: asBytes,
  json: z.unknown(),
  jsonb: z.unknown(),
};

const TYPE_ALIASES: Readonly<Record<string, string>> = {
  bigint: "int8",
  integer: "int4",
  int: "int4",
  smallint: "int2",
  serial: "int4",
  serial4: "int4",
  serial8: "int8",
  bigserial: "int8",
  real: "float4",
  float: "float8",
  "double precision": "float8",
  decimal: "numeric",
  boolean: "bool",
  char: "bpchar",
  string: "text",
  bytes: "bytea",
};

/** Builds a driver-normalising runtime codec from a PostgreSQL/Cockroach type name. */
export function codecForSqlType(sqlType: string, nullable = false): Codec<unknown> {
  const raw = sqlType.toLowerCase();
  const canonical = TYPE_ALIASES[raw] ?? raw;
  const codec = castZod[canonical];
  if (codec === undefined)
    throw new Error(`XQL has no runtime codec for PostgreSQL type "${sqlType}"`);
  return nullable ? codec.nullable() : codec;
}
