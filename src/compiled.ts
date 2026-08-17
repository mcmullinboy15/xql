import { z } from "zod";
import { castZod, type Codec } from "./schema.ts";
import type { Prepared } from "./runtime/parse.ts";

export interface CompiledPgType {
  /** PostgreSQL type name as reported by the compiler catalog. */
  readonly sqlType: string;
  /** Underlying built-in type for domains, or the element type for arrays. */
  readonly baseType?: string;
  readonly enumValues?: readonly string[];
}

export interface CompiledQueryColumn extends CompiledPgType {
  readonly name: string;
  /** Conservative `true` is always sound when exact nullability is unavailable. */
  readonly nullable: boolean;
}

export interface CompiledQueryParam extends CompiledPgType {
  readonly name: string;
  /** 1-based PostgreSQL parameter position. */
  readonly position: number;
  readonly nullable: boolean;
}

export interface CompiledQueryDescriptor {
  /** Exact value passed to xql(), including XQL fragment markers. */
  readonly source: string;
  /** Stable SHA-256 of the source query for diagnostics/cache keys. */
  readonly fingerprint: string;
  /** Exact SQL after removing only XQL fragment markers. */
  readonly sql: string;
  /** SQL sent to PostgreSQL's Describe path (`:name` -> `$n`). */
  readonly boundSql: string;
  readonly postgresVersion: string;
  readonly nullability: "conservative" | "legacy";
  readonly params: readonly CompiledQueryParam[];
  readonly columns: readonly CompiledQueryColumn[];
}

export interface CompiledQueryManifest {
  readonly version: 1;
  readonly postgresVersion: string;
  readonly queries: Readonly<Record<string, CompiledQueryDescriptor>>;
}

export interface CompiledRuntimeOptions {
  readonly compiled?: CompiledQueryManifest;
  /** Codecs for domains/extensions that XQL does not know natively. */
  readonly codecs?: Readonly<Record<string, Codec<unknown>>>;
  /** Refuse any query not present in the compiler manifest. */
  readonly requireCompiled?: boolean;
  /** Refuse compiled result types for which no runtime codec exists. */
  readonly strictCodecs?: boolean;
}

function codecForType(
  type: CompiledPgType,
  codecs: Readonly<Record<string, Codec<unknown>>>,
  strict: boolean,
): Codec<unknown> {
  const override = codecs[type.sqlType] ?? (type.baseType ? codecs[type.baseType] : undefined);
  if (override) return override;

  if (!type.sqlType.endsWith("[]") && type.baseType?.endsWith("[]")) {
    return codecForType({ sqlType: type.baseType }, codecs, strict);
  }

  if (type.sqlType.endsWith("[]")) {
    const elementType = type.sqlType.slice(0, -2);
    const elementBase = type.baseType?.endsWith("[]") ? type.baseType.slice(0, -2) : undefined;
    return z.array(
      codecForType(
        { sqlType: elementType, baseType: elementBase, enumValues: type.enumValues },
        codecs,
        strict,
      ),
    );
  }

  if (type.enumValues && type.enumValues.length > 0)
    return z.enum(type.enumValues as unknown as [string, ...string[]]);

  const named = castZod[type.sqlType] ?? (type.baseType ? castZod[type.baseType] : undefined);
  if (named) return named;

  if (strict) {
    throw new Error(
      `xql compiler has no runtime codec for PostgreSQL type "${type.sqlType}"; ` +
        `register it with createXql(..., { codecs: { "${type.sqlType}": schema } })`,
    );
  }
  return z.unknown();
}

/** Build the runtime validator directly from compiler output — no SQL parsing. */
export function prepareCompiled(
  query: CompiledQueryDescriptor,
  options: Pick<CompiledRuntimeOptions, "codecs" | "strictCodecs"> = {},
): Prepared {
  const codecs = options.codecs ?? {};
  const strict = options.strictCodecs ?? true;
  const shape: Record<string, Codec<unknown>> = {};
  const columns = query.columns.map((column) => {
    let codec = codecForType(column, codecs, strict);
    if (column.nullable) codec = codec.nullable();
    shape[column.name] = codec;
    return { name: column.name, zod: codec };
  });

  return {
    text: query.sql,
    columns,
    rowSchema: z.object(shape),
  };
}

/** Bind a compiled query without rescanning SQL at runtime. */
export function bindCompiledParams(
  query: CompiledQueryDescriptor,
  params: Readonly<Record<string, unknown>>,
): { text: string; values: unknown[] } {
  const ordered = [...query.params].sort((a, b) => a.position - b.position);
  const values = ordered.map((param) => {
    if (!Object.prototype.hasOwnProperty.call(params, param.name))
      throw new Error(`missing value for parameter :${param.name}`);
    return params[param.name];
  });
  return { text: query.boundSql, values };
}
