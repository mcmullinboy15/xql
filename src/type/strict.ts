import type { CastTypes, SchemaDef } from "../schema.ts";
import type { ParamsOfQuery, SqlValue } from "./query.ts";
import type { XqlError } from "./select.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? (<T>() => T extends B ? 1 : 2) extends (<T>() => T extends A ? 1 : 2)
      ? true
      : false
    : false;

type Ws = " " | "\n" | "\t" | "\r";
type CastStop = Ws | "," | ")" | ";" | "=" | "<" | ">" | "+" | "-" | "*" | "/";

type TakeCast<S extends string, Acc extends string = ""> =
  S extends `${infer H}${infer R}`
    ? H extends CastStop
      ? Acc
      : TakeCast<R, `${Acc}${H}`>
    : Acc;

type ExplicitCastFor<Q extends string, N extends string> =
  Q extends `${string}:${N}::${infer Rest}`
    ? Lowercase<TakeCast<Rest>> extends infer Ty extends keyof CastTypes
      ? CastTypes[Ty]
      : never
    : never;

type ResolveFallback<Q extends string, N extends string, P> =
  Equal<P, SqlValue> extends true
    ? ExplicitCastFor<Q, N> extends infer C
      ? [C] extends [never]
        ? never
        : C
      : never
    : P;

export type StrictParamsOfQuery<S extends SchemaDef, Q extends string> =
  ParamsOfQuery<S, Q> extends infer P extends Record<string, unknown>
    ? { [K in keyof P]: ResolveFallback<Q, Extract<K, string>, P[K]> }
    : {};

export type UnresolvedParamNames<S extends SchemaDef, Q extends string> =
  StrictParamsOfQuery<S, Q> extends infer P extends Record<string, unknown>
    ? { [K in keyof P]: [P[K]] extends [never] ? K : never }[keyof P]
    : never;

export type ValidateStrictParams<S extends SchemaDef, Q extends string> =
  UnresolvedParamNames<S, Q> extends infer N
    ? [N] extends [never]
      ? null
      : XqlError<`cannot infer the type of parameter :${Extract<N, string>} — add an explicit SQL cast such as :${Extract<N, string>}::text`>
    : null;
