import type { z } from "zod";
import type { SchemaDef } from "./schema.ts";
import {
  bindNamedParams,
  stripSqlCommentsForAnalysis,
  stripXqlMarkers,
} from "./runtime/bind.ts";
import { correctAggregateCodecs } from "./runtime/aggregate.ts";
import {
  codecForCompiledColumn,
  rowSchemaFromArtifact,
  type CompiledManifest,
} from "./runtime/compiled.ts";
import { validateJoinReferences } from "./runtime/join-validation.ts";
import { prepare, XqlError, type Prepared } from "./runtime/parse.ts";
import type {
  DynamicFragmentSentinel,
  FragmentParts,
  HasWidePart,
  PredicateText,
  RowOfQuery,
} from "./type/query.ts";
import type { GeneratedQueryInfo, GeneratedQueryRegistry } from "./type/generated.ts";
import type { ValidateJoinRefs } from "./type/join.ts";
import type { StrictParamsOfQuery, ValidateStrictParams } from "./type/strict.ts";
import type { XqlError as XqlTypeError } from "./type/select.ts";

export interface QueryResult {
  rows: unknown[];
  rowCount?: number;
}

export interface QueryExecutionOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  name?: string;
}

export interface Adapter {
  query(
    text: string,
    values: unknown[],
    options?: QueryExecutionOptions,
  ): Promise<unknown[] | QueryResult>;
  stream?(
    text: string,
    values: unknown[],
    options?: QueryExecutionOptions,
  ): AsyncIterable<unknown>;
  transaction?<T>(run: (adapter: Adapter) => Promise<T>): Promise<T>;
}

export interface Query<Row> extends PromiseLike<Row[]> {
  rows(options?: QueryExecutionOptions): Promise<Row[]>;
  one(options?: QueryExecutionOptions): Promise<Row>;
  first(options?: QueryExecutionOptions): Promise<Row | null>;
  rowCount(options?: QueryExecutionOptions): Promise<number>;
  stream(options?: QueryExecutionOptions): AsyncIterable<Row>;
  toSql(): { text: string; values: unknown[] };
  readonly rowSchema: z.ZodType<Row>;
}

export interface QueryEvent {
  readonly phase: "start" | "success" | "error";
  readonly sql: string;
  readonly values: readonly unknown[];
  readonly compiled: boolean;
  readonly durationMs?: number;
  readonly error?: unknown;
  readonly name?: string;
}

export interface XqlOptions {
  readonly manifest?: CompiledManifest;
  readonly compiledOnly?: boolean;
  readonly validation?: "strict" | "trusted";
  readonly onQuery?: (event: QueryEvent) => void;
}

type GeneratedKey = keyof GeneratedQueryRegistry & string;

type GeneratedParams<Q extends GeneratedKey> =
  GeneratedQueryRegistry[Q] extends GeneratedQueryInfo<unknown, infer P> ? P : never;

type GeneratedParamsArg<Q extends GeneratedKey> =
  [keyof GeneratedParams<Q>] extends [never]
    ? []
    : [params: GeneratedParams<Q>];

type GeneratedResult<Q extends GeneratedKey> =
  GeneratedQueryRegistry[Q] extends GeneratedQueryInfo<infer R, unknown>
    ? Query<R>
    : never;

type LegacyParamsArg<S extends SchemaDef, Q extends string> =
  StrictParamsOfQuery<S, Q> extends infer P
    ? [keyof P] extends [never]
      ? []
      : [params: P]
    : [];

type LegacyResult<S extends SchemaDef, Q extends string> =
  ValidateJoinRefs<S, Q> extends infer J
    ? J extends XqlTypeError<string>
      ? J
      : ValidateStrictParams<S, Q> extends infer PErr
        ? PErr extends XqlTypeError<string>
          ? PErr
          : RowOfQuery<S, Q> extends infer R
            ? [R] extends [XqlTypeError<string>]
              ? R
              : Query<R>
            : never
        : never
    : never;

export interface Xql<S extends SchemaDef> {
  /** Fast path for compiler-generated exact literals. */
  <const Q extends GeneratedKey>(query: Q, ...args: GeneratedParamsArg<Q>): GeneratedResult<Q>;
  /** Zero-build fallback. Generated literals are excluded so they cannot bypass compiler types. */
  <const Q extends string>(
    query: Q extends GeneratedKey ? never : Q,
    ...args: LegacyParamsArg<S, Q>
  ): LegacyResult<S, Q>;
  cols<const T extends string>(text: T): `«c:${T}»`;
  from<const T extends string>(text: T): `«f:${T}»`;
  where<const T extends string>(text: T): `«w:${T}»`;
  and<const T extends FragmentParts>(
    ...parts: T
  ): HasWidePart<T> extends true
    ? DynamicFragmentSentinel
    : `«w:${PredicateText<T, "and", "true">}»`;
  or<const T extends FragmentParts>(
    ...parts: T
  ): HasWidePart<T> extends true
    ? DynamicFragmentSentinel
    : `«w:${PredicateText<T, "or", "false">}»`;
  transaction<T>(run: (tx: Xql<S>) => Promise<T>): Promise<T>;
  readonly schema: S;
}

export function createXql<const S extends SchemaDef>(
  schema: S,
  adapter: Adapter,
  options: XqlOptions = {},
): Xql<S> {
  const preparedCache = new Map<string, { prepared: Prepared; compiled: boolean }>();

  const getPrepared = (query: string): { prepared: Prepared; compiled: boolean } => {
    const cached = preparedCache.get(query);
    if (cached !== undefined) return cached;

    const artifact = options.manifest?.queries[query];
    if (artifact !== undefined) {
      const prepared: Prepared = {
        text: artifact.sql,
        columns: artifact.columns.map((column) => ({
          name: column.name,
          zod: codecForCompiledColumn(column),
        })),
        rowSchema: rowSchemaFromArtifact(artifact),
      };
      const result = { prepared, compiled: true };
      preparedCache.set(query, result);
      return result;
    }

    if (options.compiledOnly)
      throw new XqlError("query is not present in the XQL compiler manifest; run xql compile before executing it");

    // Legacy analysis receives a comment-free copy so comments cannot become
    // fake ORDER BY directions, identifiers, or parameter contexts. The copy is
    // never executed; the exact original SQL is restored below.
    const analysisQuery = stripSqlCommentsForAnalysis(query);
    validateJoinReferences(schema, analysisQuery);
    const legacy = correctAggregateCodecs(
      schema,
      analysisQuery,
      prepare(schema, analysisQuery),
    );
    const prepared: Prepared = {
      ...legacy,
      // Preserve every user byte. Only XQL's own wrappers are removed here;
      // named parameters are rewritten later by bindNamedParams().
      text: stripXqlMarkers(query),
    };
    const result = { prepared, compiled: false };
    preparedCache.set(query, result);
    return result;
  };

  function call(query: string, params: Record<string, unknown> = {}) {
    const { prepared, compiled } = getPrepared(query);
    let bound: { text: string; values: unknown[] };
    try {
      bound = bindNamedParams(prepared.text, params);
    } catch (error) {
      // Preserve XQL's public runtime error contract at the binder boundary.
      if (error instanceof Error) throw new XqlError(error.message);
      throw error;
    }

    const exec = async (execOptions?: QueryExecutionOptions) => {
      const started = Date.now();
      options.onQuery?.({
        phase: "start",
        sql: bound.text,
        values: bound.values,
        compiled,
        name: execOptions?.name,
      });
      try {
        const result = await adapter.query(bound.text, bound.values, execOptions);
        const normalized = Array.isArray(result)
          ? { rows: result, rowCount: result.length }
          : { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
        options.onQuery?.({
          phase: "success",
          sql: bound.text,
          values: bound.values,
          compiled,
          durationMs: Date.now() - started,
          name: execOptions?.name,
        });
        return normalized;
      } catch (error) {
        options.onQuery?.({
          phase: "error",
          sql: bound.text,
          values: bound.values,
          compiled,
          durationMs: Date.now() - started,
          error,
          name: execOptions?.name,
        });
        throw error;
      }
    };

    const validate = (row: unknown) =>
      options.validation === "trusted" ? row : prepared.rowSchema.parse(row);

    const run = async (execOptions?: QueryExecutionOptions) => {
      const { rows } = await exec(execOptions);
      return rows.map(validate);
    };

    const stream = (execOptions?: QueryExecutionOptions): AsyncIterable<unknown> => {
      if (adapter.stream === undefined)
        throw new XqlError("this adapter does not implement streaming");
      const iterable = adapter.stream(bound.text, bound.values, execOptions);
      return {
        async *[Symbol.asyncIterator]() {
          for await (const row of iterable) yield validate(row);
        },
      };
    };

    return {
      rows: run,
      one: async (execOptions?: QueryExecutionOptions) => {
        const rows = await run(execOptions);
        if (rows.length !== 1)
          throw new XqlError(`expected exactly 1 row, got ${rows.length}`);
        return rows[0];
      },
      first: async (execOptions?: QueryExecutionOptions) => {
        const rows = await run(execOptions);
        return rows[0] ?? null;
      },
      rowCount: async (execOptions?: QueryExecutionOptions) => {
        const result = await exec(execOptions);
        return result.rowCount;
      },
      stream,
      toSql: () => ({ text: bound.text, values: bound.values }),
      rowSchema: prepared.rowSchema,
      then: <TResult1 = unknown[], TResult2 = never>(
        onfulfilled?: ((value: unknown[]) => TResult1 | PromiseLike<TResult1>) | null,
        onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) => run().then(onfulfilled, onrejected),
    };
  }

  call.cols = <T extends string>(text: T) => `«c:${text}»` as const;
  call.from = <T extends string>(text: T) => `«f:${text}»` as const;
  call.where = <T extends string>(text: T) => `«w:${text}»` as const;
  call.and = (...parts: string[]) => `«w:${parts.filter(Boolean).join(" and ") || "true"}»`;
  call.or = (...parts: string[]) => `«w:${parts.filter(Boolean).join(" or ") || "false"}»`;
  call.transaction = async <T>(run: (tx: Xql<S>) => Promise<T>): Promise<T> => {
    if (adapter.transaction === undefined)
      throw new XqlError("this adapter does not implement transactions");
    return adapter.transaction((txAdapter) => run(createXql(schema, txAdapter, options)));
  };
  call.schema = schema;
  return call as Xql<S>;
}
