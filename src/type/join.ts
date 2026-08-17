import type { SchemaDef } from "../schema.ts";
import type { ParseFrom, FromEntry } from "./from.ts";
import type { AliasList, EntryByAlias, HasCol, IsAlias, XqlError } from "./select.ts";
import type { Join, ReplaceAll, Trim, Words } from "./string.ts";

type StripMarkers<S extends string> = ReplaceAll<
  ReplaceAll<ReplaceAll<ReplaceAll<S, "«c:", "">, "«f:", "">, "«w:", "">,
  "»",
  ""
>;

type TailKw =
  | "where" | "group" | "order" | "limit" | "offset" | "having" | "window"
  | "union" | "intersect" | "except" | "for" | "returning";

type HasJoinToken<T extends readonly string[]> =
  T extends readonly [infer H extends string, ...infer R extends string[]]
    ? Lowercase<H> extends "join"
      ? true
      : HasJoinToken<R>
    : false;

type FindFrom<
  T extends readonly string[],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? Lowercase<H> extends "from"
    ? R
    : FindFrom<R>
  : [];

type TakeFrom<
  T extends readonly string[],
  Acc extends string[] = [],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? Lowercase<H> extends TailKw
    ? Acc
    : TakeFrom<R, [...Acc, H]>
  : Acc;

type FromText<Q extends string> = Trim<Join<TakeFrom<FindFrom<Words<Q>>>, " ">>;

type SpaceOps<S extends string> = ReplaceAll<
  ReplaceAll<
    ReplaceAll<
      ReplaceAll<
        ReplaceAll<ReplaceAll<S, "(", " ( ">, ")", " ) ">,
        "=", " = "
      >,
      ",", " , "
    >,
    "+", " + "
  >,
  "-", " - "
>;

type StripLead<S extends string> = S extends `(${infer R}` ? StripLead<R> : S;
type StripTail<S extends string> = S extends `${infer R})` ? StripTail<R> : S;
type StripCast<S extends string> = S extends `${infer R}::${string}` ? R : S;
type Clean<S extends string> = StripCast<StripTail<StripLead<S>>>;

type Next<T extends readonly string[]> = T extends readonly [infer H extends string, ...string[]] ? H : "";

type CheckToken<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Tok extends string,
  Rest extends readonly string[],
> = Clean<Tok> extends `${infer A}.${infer C}`
  ? C extends `${string}.${string}`
    ? null
    : Next<Rest> extends "("
      ? null
      : IsAlias<E, A> extends true
        ? HasCol<S, EntryByAlias<E, A>["table"], C> extends true
          ? null
          : XqlError<`unknown column "${C}" on table "${EntryByAlias<E, A>["table"]}" in JOIN expression`>
        : XqlError<`unknown table alias "${A}" in JOIN expression — in scope: ${AliasList<E>}`>
  : null;

type CheckTokens<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  T extends readonly string[],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? CheckToken<S, E, H, R> extends infer Err
    ? Err extends XqlError<string>
      ? Err
      : CheckTokens<S, E, R>
    : never
  : null;

/**
 * Validates qualified references appearing inside an actual JOIN expression.
 * This intentionally does not run for every statement containing `from`
 * (DELETE ... FROM, RETURNING, etc.); those are owned by the write parser.
 */
export type ValidateJoinRefs<S extends SchemaDef, Q extends string> =
  StripMarkers<Q> extends infer CleanQuery extends string
    ? HasJoinToken<Words<CleanQuery>> extends true
      ? FromText<CleanQuery> extends infer F extends string
        ? F extends ""
          ? null
          : ParseFrom<F> extends infer E extends readonly FromEntry[]
            ? CheckTokens<S, E, Words<SpaceOps<F>>>
            : null
        : null
      : null
    : null;
