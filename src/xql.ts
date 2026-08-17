import type { z } from "zod";
import type { SchemaDef } from "./schema.ts";
import { prepare, XqlError, type Prepared } from "./runtime/parse.ts";
import { bindNamedParams, stripXqlMarkers } from "./sql.ts";
import {
  bindCompiledParams,
  prepareCompiled,
  type CompiledQueryDescriptor,
  type CompiledRuntimeOptions,
} from "./compiled.ts";
import type {
  DynamicFragmentSentinel,
  FragmentParts,
  HasWidePart,
  ParamsOfQuery,
  PredicateText,
  RowOfQuery,
} from "./type/query.ts";
import type { XqlError as XqlTypeError } from "./type/select.ts";

export interface QueryResult {
  rows: unknown[];
  rowCount?: number;
}

/** Per-execution controls that an adapter can map to its native driver. */
export interface QueryExecutionOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  /** Human-readable operation name for traces / prepared statements. */
  readonly name?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Context supplied to adapters without contaminating the SQL API itself. */
export interface AdapterQueryContext extends QueryExecutionOptions {
  readonly source: string;
  readonly compiled: boolean;
  readonly fingerprint?: string;
}

export interface Adapter {
  query(
    text: string,
    values: unknown[],
    context?: AdapterQueryContext,
  ): Promise<unknown[] | QueryResult>;
  /** Optional cursor/stream integration. XQL validates each yielded row. */
  stream?(
    text: string,
    values: unknown[],
    context?: AdapterQueryContext,
  ): AsyncIterable<unknown>;
  /** Optional transaction hook. The callback receives a transaction-scoped adapter. */
  transaction?<T>(run: (adapter: Adapter) => Promise<T>): Promise<T>;
}

export interface Query<Row> extends PromiseLike<Row[]> {
  rows(options?: QueryExecutionOptions): Promise<Row[]>;
  one(options?: QueryExecutionOptions): Promise<Row>;
  first(options?: QueryExecutionOptions): Promise<Row | null>;
  /** Rows affected — the useful result for a write with no RETURNING. */
  rowCount(options?: QueryExecutionOptions): Promise<number>;
  /** Uses adapter streaming when available; otherwise streams the buffered rows. */
  stream(options?: QueryExecutionOptions): AsyncIterable<Row>;
  toSql(): { text: string; values: unknown[] };
  readonly rowSchema: z.ZodType<Row>;
}

/** Compiler-generated `.d.ts` files merge into this global registry. */
declare global {
  namespace XqlGenerated {
    interface Queries {}
  }
}

/** Public alias for the generated registry used by XQL's call signatures. */
export interface XqlCompiledQueries extends XqlGenerated.Queries {}

type CompiledKey = Extract<keyof XqlCompiledQueries, string>;
type CompiledInfo<Q extends string> = Q extends CompiledKey ? XqlCompiledQueries[Q] : never;

type ParamsFor<S extends SchemaDef, Q extends string> =
  [CompiledInfo<Q>] extends [never]
    ? ParamsOfQuery<S, Q>
    : CompiledInfo<Q> extends { params: infer P }
      ? P
      : ParamsOfQuery<S, Q>;

type RowFor<S extends SchemaDef, Q extends string> =
  [CompiledInfo<Q>] extends [never]
    ? RowOfQuery<S, Q>
    : CompiledInfo<Q> extends { row: infer R }
      ? R
      : RowOfQuery<S, Q>;

type ParamsArgFor<P> = [keyof P] extends [never] ? [] : [params: P];
type ParamsArg<S extends SchemaDef, Q extends string> = ParamsFor<S, Q> extends infer P
  ? ParamsArgFor<P>
  : [];

type Result<S extends SchemaDef, Q extends string> = RowFor<S, Q> extends infer R
  ? [R] extends [XqlTypeError<string>]
    ? R
    : Query<R>
  : never;

type CompiledParams<Q extends CompiledKey> = XqlCompiledQueries[Q] extends { params: infer P } ? P : {};
type CompiledRow<Q extends CompiledKey> = XqlCompiledQueries[Q] extends { row: infer R } ? R : never;

interface XqlHelpers<S extends SchemaDef, Self> {
  /** A SELECT list. Only valid between `select` and `from`. */
  cols<const T extends string>(text: T): `«c:${T}»`;
  /** A table expression with joins. Only valid after `from`. */
  from<const T extends string>(text: T): `«f:${T}»`;
  /** A boolean predicate. Only valid after `where`. */
  where<const T extends string>(text: T): `«w:${T}»`;
  /** Conditional predicates joined with AND. */
  and<const T extends FragmentParts>(
    ...parts: T
  ): HasWidePart<T> extends true
    ? DynamicFragmentSentinel
    : `«w:${PredicateText<T, "and", "true">}»`;
  /** Conditional predicates joined with OR. */
  or<const T extends FragmentParts>(
    ...parts: T
  ): HasWidePart<T> extends true
    ? DynamicFragmentSentinel
    : `«w:${PredicateText<T, "or", "false">}»`;
  /** Run work with a transaction-scoped XQL when the adapter supports it. */
  transaction<T>(run: (xql: Self) => Promise<T>): Promise<T>;
  readonly schema: S;
}

interface XqlCall<S extends SchemaDef> {
  <const Q extends string>(query: Q, ...args: ParamsArg<S, Q>): Result<S, Q>;
}

interface CompiledXqlCall {
  <const Q extends CompiledKey>(
    query: Q,
    ...args: ParamsArgFor<CompiledParams<Q>>
  ): Query<CompiledRow<Q>>;
}

export type Xql<S extends SchemaDef> = XqlCall<S> & XqlHelpers<S, Xql<S>>;
/** Strict compiler-only XQL: ungenerated query strings are TypeScript errors. */
export type CompiledXql<S extends SchemaDef> = CompiledXqlCall & XqlHelpers<S, CompiledXql<S>>;

export interface XqlOptions extends CompiledRuntimeOptions {
  /** `strict` validates every row; `trusted` skips row validation deliberately. */
  readonly validation?: "strict" | "trusted";
}

interface CachedPrepared {
  readonly prepared: Prepared;
  readonly compiled?: CompiledQueryDescriptor;
}

export function createXql<const S extends SchemaDef>(
  schema: S,
  adapter: Adapter,
  options: XqlOptions & { readonly requireCompiled: true },
): CompiledXql<S>;
export function createXql<const S extends SchemaDef>(
  schema: S,
  adapter: Adapter,
  options?: XqlOptions,
): Xql<S>;
export function createXql<const S extends SchemaDef>(
  schema: S,
  adapter: Adapter,
  options: XqlOptions = {},
): Xql<S> | CompiledXql<S> {
  // Static query literals are normally invoked from inside request handlers, so
  // runtime parsing/validator construction must happen at most once per XQL instance.
  const preparedCache = new Map<string, CachedPrepared>();

  const getPrepared = (query: string): CachedPrepared => {
    const cached = preparedCache.get(query);
    if (cached) return cached;

    const compiled = options.compiled?.queries[query];
    let value: CachedPrepared;
    if (compiled) {
      value = { prepared: prepareCompiled(compiled, options), compiled };
    } else {
      if (options.requireCompiled) {
        throw new XqlError(
          "query is not present in the XQL compiler manifest; rerun `xql compile` before executing it",
        );
      }
      const parsed = prepare(schema, query);
      // Legacy parsing may normalize text internally. That text is analysis-only:
      // the database always receives the user's SQL bytes with markers removed.
      value = { prepared: { ...parsed, text: stripXqlMarkers(query) } };
    }
    preparedCache.set(query, value);
    return value;
  };

  const make = (scopedAdapter: Adapter): Xql<S> | CompiledXql<S> => {
    function call(query: string, params: Record<string, unknown> = {}) {
      const cached = getPrepared(query);
      const { prepared, compiled } = cached;
      const bound = compiled
        ? bindCompiledParams(compiled, params)
        : bindNamedParams(prepared.text, params);

      const context = (execution: QueryExecutionOptions = {}): AdapterQueryContext => ({
        ...execution,
        source: query,
        compiled: compiled !== undefined,
        fingerprint: compiled?.fingerprint,
      });

      const validate = (row: unknown) =>
        options.validation === "trusted" ? row : prepared.rowSchema.parse(row);

      const exec = async (execution: QueryExecutionOptions = {}) => {
        const result = await scopedAdapter.query(bound.text, bound.values, context(execution));
        return Array.isArray(result)
          ? { rows: result, rowCount: result.length }
          : { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
      };

      const run = async (execution: QueryExecutionOptions = {}) => {
        const { rows } = await exec(execution);
        return rows.map(validate);
      };

      const stream = (execution: QueryExecutionOptions = {}): AsyncIterable<unknown> => {
        const iterate = async function* () {
          if (scopedAdapter.stream) {
            for await (const row of scopedAdapter.stream(bound.text, bound.values, context(execution)))
              yield validate(row);
            return;
          }
          for (const row of await run(execution)) yield row;
        };
        return iterate();
      };

      return {
        rows: run,
        one: async (execution?: QueryExecutionOptions) => {
          const rows = await run(execution);
          if (rows.length !== 1)
            throw new XqlError(`expected exactly 1 row, got ${rows.length}`);
          return rows[0];
        },
        first: async (execution?: QueryExecutionOptions) => (await run(execution))[0] ?? null,
        rowCount: async (execution?: QueryExecutionOptions) => (await exec(execution)).rowCount,
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
    const predicate =
      (sep: string, empty: string) =>
      (...parts: unknown[]) => {
        const kept = parts.filter(
          (p): p is string => typeof p === "string" && p.trim() !== "",
        );
        if (kept.length === 0) return `«w:${empty}»`;
        return `«w:${kept.map((p) => `(${p})`).join(` ${sep} `)}»`;
      };

    const transaction = async <T>(run: (xql: Xql<S> | CompiledXql<S>) => Promise<T>) => {
      if (!scopedAdapter.transaction)
        throw new XqlError("this XQL adapter does not support transactions");
      return scopedAdapter.transaction((txAdapter) => run(make(txAdapter)));
    };

    return Object.assign(call, {
      cols: marked("c"),
      from: marked("f"),
      where: marked("w"),
      and: predicate("and", "true"),
      or: predicate("or", "false"),
      transaction,
      schema,
    }) as unknown as Xql<S> | CompiledXql<S>;
  };

  return make(adapter);
}
