import { z } from "zod";

/** Output type is pinned; input is whatever the driver produced. */
export type Codec<T> = z.ZodType<T, unknown>;

export interface Column<T> {
  readonly zod: Codec<T>;
  readonly sqlType: string;
  readonly isNullable: boolean;
  nullable(): Column<T | null>;
}

function makeColumn<T>(
  sqlType: string,
  zod: Codec<T>,
  isNullable = false,
): Column<T> {
  return {
    zod,
    sqlType,
    isNullable,
    nullable: () =>
      makeColumn<T | null>(sqlType, zod.nullable(), true),
  };
}

/**
 * Drivers disagree on the JS representation of the same SQL type: node-postgres
 * decodes int8 as a string, PGlite as a number, Prisma as a bigint. Codecs
 * accept every representation and normalise to one declared TypeScript type, so
 * the row type does not depend on which driver is underneath.
 *
 * A number that cannot round-trip (beyond Number.MAX_SAFE_INTEGER) is rejected
 * rather than silently truncated — the precision was already lost upstream.
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

/**
 * Postgres returns bytea as a Buffer, which is a Uint8Array. The annotation
 * pins the output to plain `Uint8Array`; `z.instanceof` would infer
 * `Uint8Array<ArrayBuffer>`, which is a different type from the one a
 * `::bytes` cast produces.
 */
const asBytes: Codec<Uint8Array> = z.instanceof(Uint8Array);

export const t = {
  int8: () => makeColumn("int8", asBigint),
  int4: () => makeColumn("int4", asNumber),
  float8: () => makeColumn("float8", asNumber),
  text: () => makeColumn("text", z.string()),
  bool: () => makeColumn("bool", asBoolean),
  numeric: () =>
    makeColumn("numeric", asNumericString),
  timestamptz: () =>
    makeColumn("timestamptz", asDate),
  date: () => makeColumn("date", asDate),
  uuid: () => makeColumn("uuid", z.string()),
  bytes: () => makeColumn("bytes", asBytes),
  jsonb: <T>(schema: Codec<T>) => makeColumn("jsonb", schema),
  enum: <const V extends readonly [string, ...string[]]>(values: V) =>
    makeColumn<V[number]>("text", z.enum(values)),
};

export type TableDef = Record<string, Column<unknown>>;
export type SchemaDef = Record<string, TableDef>;

export type ColType<C> = C extends Column<infer T> ? T : never;

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
  float8: number;
  float: number;
  real: number;
  "double precision": number;
  text: string;
  varchar: string;
  char: string;
  bool: boolean;
  boolean: boolean;
  numeric: string;
  decimal: string;
  timestamptz: Date;
  timestamp: Date;
  date: Date;
  uuid: string;
  bytes: Uint8Array;
  bytea: Uint8Array;
  json: unknown;
  jsonb: unknown;
}

export const castZod: Record<string, Codec<unknown>> = {
  int8: asBigint,
  bigint: asBigint,
  int4: asNumber,
  int: asNumber,
  integer: asNumber,
  smallint: asNumber,
  float8: asNumber,
  float: asNumber,
  real: asNumber,
  "double precision": asNumber,
  text: z.string(),
  varchar: z.string(),
  char: z.string(),
  bool: asBoolean,
  boolean: asBoolean,
  numeric: asNumericString,
  decimal: asNumericString,
  timestamptz: asDate,
  timestamp: asDate,
  date: asDate,
  uuid: z.string(),
  bytes: asBytes,
  bytea: asBytes,
  json: z.unknown(),
  jsonb: z.unknown(),
};
