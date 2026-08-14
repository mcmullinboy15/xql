import type { CastTypes, ColType, FnTypes, SchemaDef } from "../schema.ts";
import type { FromEntry } from "./from.ts";
import type {
  AfterLast,
  BeforeLast,
  Join,
  SplitTopLevel,
  Trim,
  Words,
} from "./string.ts";

export interface XqlError<M extends string> {
  readonly __xql_error__: M;
}

export type AnyXqlError = XqlError<string>;

type ApplyNull<T, N extends boolean> = N extends true ? T | null : T;

type Prettify<T> = { -readonly [K in keyof T]: T[K] } & {};

type MergeInto<Acc, O> = Omit<Acc, keyof O> & O;

/** Non-distributive — `T` may legitimately be a union like `string | null`. */
type IsErr<T> = [T] extends [AnyXqlError] ? true : false;

/** Every column of one FROM entry, with join-nullability applied. */
type TableRow<
  S extends SchemaDef,
  En extends FromEntry,
> = En["table"] extends infer Tbl extends keyof S
  ? { -readonly [K in keyof S[Tbl]]: ApplyNull<ColType<S[Tbl][K]>, En["nullable"]> }
  : XqlError<`unknown table "${En["table"]}"`>;

export type HasCol<
  S extends SchemaDef,
  Tbl extends string,
  Col extends string,
> = Tbl extends infer T extends keyof S
  ? Col extends keyof S[T]
    ? true
    : false
  : false;

type ColOf<
  S extends SchemaDef,
  En extends FromEntry,
  Col extends string,
> = En["table"] extends infer Tbl extends keyof S
  ? Col extends keyof S[Tbl]
    ? ApplyNull<ColType<S[Tbl][Col]>, En["nullable"]>
    : XqlError<`unknown column "${Col}" on table "${En["table"]}"`>
  : XqlError<`unknown table "${En["table"]}"`>;

export type EntryByAlias<
  E extends readonly FromEntry[],
  A extends string,
> = Extract<E[number], { alias: A }>;

export type AliasList<E extends readonly FromEntry[]> = Join<
  { [K in keyof E]: E[K]["alias"] } extends infer L extends string[] ? L : never,
  ", "
>;

/** All FROM entries that expose an unqualified column name. */
export type EntriesWithCol<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Col extends string,
  Acc extends FromEntry[] = [],
> = E extends readonly [
  infer H extends FromEntry,
  ...infer R extends FromEntry[],
]
  ? EntriesWithCol<
      S,
      R,
      Col,
      HasCol<S, H["table"], Col> extends true ? [...Acc, H] : Acc
    >
  : Acc;

type ResolveBare<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Col extends string,
> = EntriesWithCol<S, E, Col> extends infer M extends readonly FromEntry[]
  ? M extends readonly [infer Only extends FromEntry]
    ? ColOf<S, Only, Col>
    : M extends readonly []
      ? E extends readonly []
        ? XqlError<`unknown column "${Col}" — the query has no FROM clause`>
        : XqlError<`unknown column "${Col}" — not on any table in scope (${AliasList<E>})`>
      : XqlError<`ambiguous column "${Col}" — qualify it, it exists on more than one table in scope (${AliasList<E>})`>
  : never;

export type IsAlias<
  E extends readonly FromEntry[],
  A extends string,
> = EntryByAlias<E, A> extends never ? false : true;

type NonTypeNameChar = "(" | ")" | "," | "'" | '"' | "*" | "=" | ":";

/**
 * A `::` only ends the expression when what follows is shaped like a type name.
 * Otherwise it belongs to a nested expression, as in
 * `(select count(*)::int8 from t)`, where the cast is the subquery's.
 */
type IsTypeNameShaped<S extends string> = Trim<S> extends ""
  ? false
  : Trim<S> extends `${string}${NonTypeNameChar}${string}`
    ? false
    : Trim<S> extends `${string} ${string}`
      ? Lowercase<Trim<S>> extends "double precision"
        ? true
        : false
      : true;

type Cast<Ty extends string> = Trim<Ty> extends `${infer Base}[]`
  ? Lowercase<Trim<Base>> extends infer L extends keyof CastTypes
    ? CastTypes[L][]
    : XqlError<`unknown cast type "${Ty}"`>
  : Lowercase<Trim<Ty>> extends infer L extends keyof CastTypes
    ? CastTypes[L]
    : XqlError<`unknown cast type "${Ty}"`>;

/** Resolves a scalar expression to its TypeScript type. */
type ResolveExpr<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Expr extends string,
> = Expr extends `${string}::${string}`
  ? IsTypeNameShaped<AfterLast<Expr, "::">> extends true
    ? Cast<AfterLast<Expr, "::">>
    : ResolveNonCast<S, E, Expr>
  : ResolveNonCast<S, E, Expr>;

type ResolveNonCast<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Expr extends string,
> = Expr extends `${string}(${string}`
  ? ResolveCall<S, E, Expr>
  : Expr extends `${infer A}.${infer C}`
      ? IsAlias<E, A> extends true
        ? ColOf<S, EntryByAlias<E, A>, C>
        : XqlError<`unknown table alias "${A}" — in scope: ${AliasList<E>}`>
      : Expr extends `${string} ${string}`
        ? XqlError<`cannot infer the type of "${Expr}" — add an explicit cast, e.g. ${Expr}::text`>
        : ResolveBare<S, E, Expr>;

/** A small whitelist of aggregates whose result type is derivable. */
type ResolveCall<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Expr extends string,
> = Expr extends `${infer Fn}(${infer Args})`
  ? Lowercase<Trim<Fn>> extends infer F extends keyof FnTypes
    ? FnTypes[F]
    : Lowercase<Trim<Fn>> extends "count"
    ? bigint
    : Lowercase<Trim<Fn>> extends "sum" | "avg" | "min" | "max"
      ? ResolveExpr<S, E, Trim<Args>> extends infer T
        ? IsErr<T> extends true
          ? XqlError<`cannot infer the type of "${Expr}" — add an explicit cast, e.g. ${Expr}::numeric`>
          : T | null
        : never
      : Lowercase<Trim<Fn>> extends "coalesce" | "nullif" | "greatest" | "least"
        ? ResolveExpr<
            S,
            E,
            Trim<SplitTopLevel<Args> extends readonly [
              infer F extends string,
              ...string[],
            ]
              ? F
              : Args>
          > extends infer T
          ? IsErr<T> extends true
            ? XqlError<`cannot infer the type of "${Expr}" — add an explicit cast, e.g. ${Expr}::numeric`>
            : NonNullable<T>
          : never
        : XqlError<`cannot infer the type of "${Expr}" — add an explicit cast, e.g. ${Expr}::text`>
  : XqlError<`cannot infer the type of "${Expr}" — add an explicit cast, e.g. ${Expr}::text`>;

type LastWord<W extends readonly string[]> = W extends readonly [
  ...string[],
  infer L extends string,
]
  ? L
  : never;

type DropLast<W extends readonly string[]> = W extends readonly [
  ...infer I extends string[],
  string,
]
  ? I
  : [];

/** Splits `expr as name` / `expr name` / `expr` into its parts. */
type SplitAlias<Item extends string> =
  Words<Item> extends infer W extends readonly string[]
    ? W extends readonly [...infer _I extends string[], infer A extends string, infer N extends string]
      ? Lowercase<A> extends "as"
        ? { expr: Join<DropLast<DropLast<W>>, " ">; name: N }
        : W extends readonly [infer Only extends string, string]
          ? { expr: Only; name: LastWord<W> }
          : { expr: Join<W, " ">; name: null }
      : { expr: Join<W, " ">; name: null }
    : never;

/** Default output name for an expression with no explicit alias. */
type DefaultName<Expr extends string> = Expr extends `${string}::${string}`
  ? DefaultName<BeforeLast<Expr, "::">>
  : Expr extends `${string}(${string}`
    ? null
    : Expr extends `${string}.${infer C}`
      ? C
      : Expr;

type ResolveItem<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Raw extends string,
> = Trim<Raw> extends infer Item extends string
  ? Item extends "*"
    ? StarAll<S, E>
    : Item extends `${infer A}.*`
      ? IsAlias<E, A> extends true
        ? TableRow<S, EntryByAlias<E, A>>
        : XqlError<`unknown table alias "${A}" — in scope: ${AliasList<E>}`>
      : SplitAlias<Item> extends infer P extends {
            expr: string;
            name: string | null;
          }
        ? ResolveExpr<S, E, P["expr"]> extends infer T
          ? IsErr<T> extends true
            ? T
            : (P["name"] extends string ? P["name"] : DefaultName<P["expr"]>) extends infer N
              ? N extends string
                ? { [K in N]: T }
                : XqlError<`expression "${P["expr"]}" needs an alias, e.g. ${P["expr"]} as total`>
              : never
          : never
        : never
  : never;

type StarAll<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Acc = {},
> = E extends readonly [
  infer H extends FromEntry,
  ...infer R extends FromEntry[],
]
  ? TableRow<S, H> extends infer O
    ? IsErr<O> extends true
      ? O
      : StarAll<S, R, MergeInto<Acc, O>>
    : never
  : Acc;

type ResolveAll<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Items extends readonly string[],
  Acc = {},
> = Items extends readonly [
  infer H extends string,
  ...infer R extends string[],
]
  ? ResolveItem<S, E, H> extends infer O
    ? IsErr<O> extends true
      ? O
      : ResolveAll<S, E, R, MergeInto<Acc, O>>
    : never
  : Acc;

/** `"p.id, v.sku as sku"` + FROM scope -> the row object type. */
export type ParseSelect<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Cols extends string,
> = ResolveAll<S, E, SplitTopLevel<Cols>> extends infer R
  ? IsErr<R> extends true
    ? R
    : Prettify<R>
  : never;
