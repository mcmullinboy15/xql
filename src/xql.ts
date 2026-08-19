import type { z } from "zod";
import type { SchemaDef } from "./schema.ts";
import {
  bindNamedParams,
  rewriteNamedParams,
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
  DuplicateOwnedParamNames,
  ExactFragmentParams,
  FragmentParamType,
  FragmentParts,
  HasWidePart,
  OwnedParamNames,
  OwnedParamTag,
  PredicateText,
  StripParamMarkers,
  XqlParamFragment,
} from "./type/fragment.ts";
import type {
  DynamicFragmentSentinel,
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

type CanonicalQuery<Q extends string> = StripParamMarkers<Q>;

type GeneratedInfo<Q extends string> =
  CanonicalQuery<Q> extends infer C extends string
    ? C extends keyof GeneratedQueryRegistry
      ? GeneratedQueryRegistry[C]
      : never
    : never;

type AllParamsFor<S extends SchemaDef, Q extends string> =
  CanonicalQuery<Q> extends keyof GeneratedQueryRegistry
    ? GeneratedInfo<Q> extends GeneratedQueryInfo<unknown, infer P>
      ? P
      : never
    : StrictParamsOfQuery<S, CanonicalQuery<Q>>;

type ParamsFor<S extends SchemaDef, Q extends string> = Omit<
  AllParamsFor<S, Q>,
  OwnedParamNames<Q>
>;

type ParamsArg<S extends SchemaDef, Q extends string> =
  ParamsFor<S, Q> extends infer P
    ? [keyof P] extends [never]
      ? []
      : [params: P]
    : [];

type InferredParams<S extends SchemaDef, Q extends string> =
  StrictParamsOfQuery<S, CanonicalQuery<Q>>;

type MismatchedOwnedParamNames<
  S extends SchemaDef,
  Q extends string,
  Name extends string = OwnedParamNames<Q>,
> = Name extends string
  ? Name extends keyof InferredParams<S, Q>
    ? FragmentParamType<OwnedParamTag<Q, Name>> extends InferredParams<S, Q>[Name]
      ? never
      : Name
    : Name
  : never;

type ValidateOwnedFragmentParams<
  S extends SchemaDef,
  Q extends string,
> = DuplicateOwnedParamNames<Q> extends infer Duplicate
  ? [Duplicate] extends [never]
    ? MismatchedOwnedParamNames<S, Q> extends infer Mismatch
      ? [Mismatch] extends [never]
        ? null
        : XqlTypeError<`xql.fragment parameter :${Extract<Mismatch, string>} does not match the SQL parameter type`>
      : never
    : XqlTypeError<`duplicate fragment-owned parameter :${Extract<Duplicate, string>}`>
  : never;

type Result<S extends SchemaDef, Q extends string> =
  ValidateOwnedFragmentParams<S, Q> extends infer FErr
    ? FErr extends XqlTypeError<string>
      ? FErr
      : CanonicalQuery<Q> extends keyof GeneratedQueryRegistry
        ? GeneratedInfo<Q> extends GeneratedQueryInfo<infer R, unknown>
          ? Query<R>
          : never
        : ValidateJoinRefs<S, CanonicalQuery<Q>> extends infer J
          ? J extends XqlTypeError<string>
            ? J
            : ValidateStrictParams<S, CanonicalQuery<Q>> extends infer PErr
              ? PErr extends XqlTypeError<string>
                ? PErr
                : RowOfQuery<S, CanonicalQuery<Q>> extends infer R
                  ? [R] extends [XqlTypeError<string>]
                    ? R
                    : Query<R>
                  : never
              : never
          : never
    : never;

export interface Xql<S extends SchemaDef> {
  <const Q extends string>(query: Q, ...args: ParamsArg<S, Q>): Result<S, Q>;
  cols<const T extends string>(text: T): `«c:${T}»`;
  from<const T extends string>(text: T): `«f:${T}»`;
  where<const T extends string>(text: T): `«w:${T}»`;
  fragment<
    const SQL extends string,
    const Params extends Readonly<Record<string, unknown>>,
  >(
    sql: SQL,
    params: ExactFragmentParams<SQL, Params>,
  ): XqlParamFragment<SQL, Params>;
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

type RuntimeParamFragment = XqlParamFragment<
  string,
  Readonly<Record<string, unknown>>
>;

function isRuntimeParamFragment(value: unknown): value is RuntimeParamFragment {
  return value !== null
    && typeof value === "object"
    && (value as { __xqlParamFragment?: unknown }).__xqlParamFragment === true
    && typeof (value as { sql?: unknown }).sql === "string";
}

export function createXql<const S extends SchemaDef>(
  schema: S,
  adapter: Adapter,
  options: XqlOptions = {},
): Xql<S> {
  const preparedCache = new Map<string, { prepared: Prepared; compiled: boolean }>();
  const pendingFragmentParams = new Map<
    string,
    Readonly<Record<string, unknown>>
  >();
  let nextFragmentToken = 0;

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

  const consumeFragmentParams = (
    query: string,
    outerParams: Readonly<Record<string, unknown>>,
  ): { query: string; params: Record<string, unknown> } => {
    const merged: Record<string, unknown> = { ...outerParams };
    const consumed = new Set<string>();

    try {
      const canonical = query.replace(/«v:([0-9a-z]+)»/g, (_marker, token: string) => {
        const params = pendingFragmentParams.get(token);
        if (params === undefined)
          throw new XqlError(
            "parameter-owning xql.and()/xql.or() results are single-use; construct the predicate inline or call xql.and()/xql.or() again before reusing it",
          );
        consumed.add(token);
        for (const [name, value] of Object.entries(params)) {
          if (name in merged)
            throw new XqlError(`duplicate value for parameter :${name}`);
          merged[name] = value;
        }
        return "";
      });
      return { query: canonical, params: merged };
    } finally {
      for (const token of consumed) pendingFragmentParams.delete(token);
    }
  };

  function call(query: string, params: Record<string, unknown> = {}) {
    const resolved = consumeFragmentParams(query, params);
    const { prepared, compiled } = getPrepared(resolved.query);
    let bound: { text: string; values: unknown[] };
    try {
      bound = bindNamedParams(prepared.text, resolved.params);
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
      first: async (execOptions?: QueryExecutionOptions) =>
        (await run(execOptions))[0] ?? null,
      rowCount: async (execOptions?: QueryExecutionOptions) =>
        (await exec(execOptions)).rowCount,
      stream,
      toSql: () => bound,
      rowSchema: prepared.rowSchema,
      then: (onOk: unknown, onErr: unknown) =>
        run().then(
          onOk as (v: unknown[]) => unknown,
          onErr as (e: unknown) => unknown,
        ),
    };
  }

  const marked = (kind: string) => (text: string) => `«${kind}:${text}»`;

  const fragment = (
    sql: string,
    params: Readonly<Record<string, unknown>>,
  ): RuntimeParamFragment => {
    const names = [...new Set(rewriteNamedParams(sql).names)];
    const keys = Object.keys(params);
    const missing = names.filter((name) => !(name in params));
    const extra = keys.filter((name) => !names.includes(name));
    if (missing.length > 0)
      throw new XqlError(`missing value for fragment parameter :${missing[0]}`);
    if (extra.length > 0)
      throw new XqlError(`fragment parameter :${extra[0]} is not present in the fragment SQL`);
    return { sql, params, __xqlParamFragment: true };
  };

  const predicate =
    (sep: string, empty: string) =>
    (...parts: unknown[]) => {
      const kept: string[] = [];
      for (const part of parts) {
        if (typeof part === "string") {
          if (part.trim() !== "") kept.push(`(${part})`);
          continue;
        }
        if (!isRuntimeParamFragment(part)) continue;
        const token = (++nextFragmentToken).toString(36);
        pendingFragmentParams.set(token, part.params);
        kept.push(`(${part.sql})«v:${token}»`);
      }
      if (kept.length === 0) return `«w:${empty}»`;
      return `«w:${kept.join(` ${sep} `)}»`;
    };

  const transaction = async <T>(run: (tx: Xql<S>) => Promise<T>): Promise<T> => {
    if (adapter.transaction === undefined)
      throw new XqlError("this adapter does not implement transactions");
    return adapter.transaction((txAdapter) =>
      run(createXql(schema, txAdapter, options)),
    );
  };

  return Object.assign(call, {
    cols: marked("c"),
    from: marked("f"),
    where: marked("w"),
    fragment,
    and: predicate("and", "true"),
    or: predicate("or", "false"),
    transaction,
    schema,
  }) as unknown as Xql<S>;
}
