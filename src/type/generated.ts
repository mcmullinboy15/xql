import type { SchemaDef } from "../schema.ts";
import type { ParamsOfQuery, RowOfQuery } from "./query.ts";

/**
 * Compiler-generated declarations augment this interface, keyed by the exact
 * literal string passed to xql(). When a key exists, XQL never instantiates the
 * type-level SQL parser for that query.
 */
export interface GeneratedQueryRegistry {}

export interface GeneratedQueryInfo<Row = unknown, Params = {}> {
  readonly row: Row;
  readonly params: Params;
}

export type HasGeneratedQuery<Q extends string> =
  Q extends keyof GeneratedQueryRegistry ? true : false;

export type QueryInfo<S extends SchemaDef, Q extends string> =
  Q extends keyof GeneratedQueryRegistry
    ? GeneratedQueryRegistry[Q] extends GeneratedQueryInfo<infer Row, infer Params>
      ? { row: Row; params: Params; compiled: true }
      : never
    : { row: RowOfQuery<S, Q>; params: ParamsOfQuery<S, Q>; compiled: false };

export type GeneratedRow<Q extends string> =
  Q extends keyof GeneratedQueryRegistry
    ? GeneratedQueryRegistry[Q] extends GeneratedQueryInfo<infer Row, unknown>
      ? Row
      : never
    : never;

export type GeneratedParams<Q extends string> =
  Q extends keyof GeneratedQueryRegistry
    ? GeneratedQueryRegistry[Q] extends GeneratedQueryInfo<unknown, infer Params>
      ? Params
      : never
    : never;
