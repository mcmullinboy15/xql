import type { z } from "zod";
import type { SchemaDef } from "./schema.ts";
import { bindParams, prepare, XqlError } from "./runtime/parse.ts";
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

export interface Adapter {
  query(text: string, values: unknown[]): Promise<unknown[] | QueryResult>;
}

export interface Query<Row> extends PromiseLike<Row[]> {
  rows(): Promise<Row[]>;
  one(): Promise<Row>;
  first(): Promise<Row | null>;
  /** Rows affected — the useful result for a write with no RETURNING. */
  rowCount(): Promise<number>;
  toSql(): { text: string; values: unknown[] };
  readonly rowSchema: z.ZodType<Row>;
}

type ParamsArg<S extends SchemaDef, Q extends string> =
  ParamsOfQuery<S, Q> extends infer P
    ? [keyof P] extends [never]
      ? []
      : [params: P]
    : [];

/**
 * On a parse failure the result is the `XqlError` itself rather than a
 * `Query`, so the mistake surfaces at the call site with its message.
 */
type Result<S extends SchemaDef, Q extends string> =
  RowOfQuery<S, Q> extends infer R
    ? [R] extends [XqlTypeError<string>]
      ? R
      : Query<R>
    : never;

export interface Xql<S extends SchemaDef> {
  <const Q extends string>(query: Q, ...args: ParamsArg<S, Q>): Result<S, Q>;
  /** A SELECT list. Only valid between `select` and `from`. */
  cols<const T extends string>(text: T): `«c:${T}»`;
  /** A table expression with joins. Only valid after `from`. */
  from<const T extends string>(text: T): `«f:${T}»`;
  /** A boolean predicate. Only valid after `where`. */
  where<const T extends string>(text: T): `«w:${T}»`;
  /**
   * Conditional predicates joined with AND. Falsy parts drop out, so
   * `cond && \`p.id = :id\`` includes the clause only when `cond` holds. With no
   * surviving parts the predicate is `true`.
   */
  and<const T extends FragmentParts>(
    ...parts: T
  ): HasWidePart<T> extends true
    ? DynamicFragmentSentinel
    : `«w:${PredicateText<T, "and", "true">}»`;
  /** As `and`, joined with OR. With no surviving parts the predicate is `false`. */
  or<const T extends FragmentParts>(
    ...parts: T
  ): HasWidePart<T> extends true
    ? DynamicFragmentSentinel
    : `«w:${PredicateText<T, "or", "false">}»`;
  readonly schema: S;
}

export function createXql<const S extends SchemaDef>(
  schema: S,
  adapter: Adapter,
): Xql<S> {
  function call(query: string, params: Record<string, unknown> = {}) {
    const prepared = prepare(schema, query);
    const bound = bindParams(prepared.text, params);

    const exec = async () => {
      const result = await adapter.query(bound.text, bound.values);
      return Array.isArray(result)
        ? { rows: result, rowCount: result.length }
        : { rows: result.rows, rowCount: result.rowCount ?? result.rows.length };
    };

    const run = async () => {
      const { rows } = await exec();
      return rows.map((r) => prepared.rowSchema.parse(r));
    };

    return {
      rows: run,
      one: async () => {
        const rows = await run();
        if (rows.length !== 1)
          throw new XqlError(`expected exactly 1 row, got ${rows.length}`);
        return rows[0];
      },
      first: async () => (await run())[0] ?? null,
      rowCount: async () => (await exec()).rowCount,
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

  // The public type is computed from a string literal, so it cannot be proven
  // from the implementation side. This is the one boundary assertion.
  return Object.assign(call, {
    cols: marked("c"),
    from: marked("f"),
    where: marked("w"),
    and: predicate("and", "true"),
    or: predicate("or", "false"),
    schema,
  }) as unknown as Xql<S>;
}
