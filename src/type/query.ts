import type { Column, ColType, SchemaDef } from "../schema.ts";
import type { FromEntry } from "./from.ts";
import { type ParseFrom } from "./from.ts";
import type {
  AliasList,
  EntriesWithCol,
  EntryByAlias,
  HasCol,
  IsAlias,
  ParseSelect,
  XqlError,
} from "./select.ts";
import type {
  Join,
  ReplaceAll,
  SplitTopLevel,
  Trim,
  Words,
} from "./string.ts";
import type {
  DropKw,
  ParenGroup,
  ParseWrite,
  StatementKind,
  WriteInfo,
  WTokens,
} from "./write.ts";

export type SqlValue =
  | string
  | number
  | bigint
  | boolean
  | Date
  | null
  | Uint8Array;

export const MARKERS = {
  cols: "«c:",
  from: "«f:",
  where: "«w:",
  end: "»",
} as const;

type StripMarkers<S extends string> = ReplaceAll<
  ReplaceAll<ReplaceAll<ReplaceAll<S, "«c:", "">, "«f:", "">, "«w:", "">,
  "»",
  ""
>;

interface KwSplit {
  before: readonly string[];
  after: readonly string[];
  found: boolean;
  kw: string;
}

type FindKw<
  T extends readonly string[],
  Kw extends string,
  Acc extends string[] = [],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? Lowercase<H> extends Kw
    ? { before: Acc; after: R; found: true; kw: H }
    : FindKw<R, Kw, [...Acc, H]>
  : { before: Acc; after: []; found: false; kw: "" };

type TailKw =
  | "where"
  | "group"
  | "order"
  | "limit"
  | "offset"
  | "having"
  | "window"
  | "union"
  | "intersect"
  | "except"
  | "for";

// ---------------------------------------------------------------------------
// Named parameters
// ---------------------------------------------------------------------------

type LowerAlpha =
  | "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h" | "i" | "j" | "k" | "l" | "m"
  | "n" | "o" | "p" | "q" | "r" | "s" | "t" | "u" | "v" | "w" | "x" | "y" | "z";
type Digit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
type IdentChar = LowerAlpha | Uppercase<LowerAlpha> | Digit | "_";

type TakeIdent<
  S extends string,
  Acc extends string = "",
> = S extends `${infer C}${infer R}`
  ? C extends IdentChar
    ? TakeIdent<R, `${Acc}${C}`>
    : Acc
  : Acc;

type DropIdent<S extends string> = S extends `${infer C}${infer R}`
  ? C extends IdentChar
    ? DropIdent<R>
    : S
  : S;

/** Casts (`::text`) and string literals hide colons that are not params. */
type MaskCasts<S extends string> = ReplaceAll<S, "::", "@@">;

type MaskStrings<S extends string> = S extends `${infer A}'${string}'${infer C}`
  ? `${A}''${MaskStrings<C>}`
  : S;

type Mask<S extends string> = MaskCasts<MaskStrings<S>>;

type ScanParams<
  S extends string,
  Acc extends string[] = [],
> = S extends `${string}:${infer Rest}`
  ? TakeIdent<Rest> extends infer N extends string
    ? N extends ""
      ? ScanParams<Rest, Acc>
      : ScanParams<DropIdent<Rest>, [...Acc, N]>
    : Acc
  : Acc;

export type ParamNames<Q extends string> = ScanParams<Mask<Q>>;

type OperatorWord =
  | "=" | "<" | ">" | "<=" | ">=" | "!=" | "<>" | "like" | "ilike" | "in"
  | "not" | "and" | "or" | "(" | "is" | "any" | "all" | "+" | "-" | "*" | "/";

/** The last non-operator token before a param — i.e. what it is compared to. */
type LastRef<W extends readonly string[]> = W extends readonly [
  ...infer I extends string[],
  infer L extends string,
]
  ? Lowercase<StripTrailingOps<L>> extends OperatorWord | ""
    ? LastRef<I>
    : StripTrailingOps<L>
  : "";

type OpChar = "=" | "<" | ">" | "!" | "~" | "(" | "," | "+" | "-" | "*" | "/";
type StripTrailingOps<S extends string> = S extends `${infer R}${OpChar}`
  ? StripTrailingOps<R>
  : S;

type ContextRef<Q extends string, N extends string> =
  Mask<Q> extends `${infer Before}:${N}${string}`
    ? LastRef<Words<Before>>
    : "";

type ParamType<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Q extends string,
  N extends string,
> = ContextRef<Q, N> extends infer Ref extends string
  ? Lowercase<Ref> extends "limit" | "offset"
    ? number | bigint
    : Ref extends ""
    ? SqlValue
    : ParseSelect<S, E, Ref> extends infer R
      ? [R] extends [XqlError<string>]
        ? SqlValue
        : R extends Record<string, infer V>
          ? NonNullable<V>
          : SqlValue
      : SqlValue
  : SqlValue;

type Distinct<
  T extends readonly string[],
  Acc extends string[] = [],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? Distinct<R, H extends Acc[number] ? Acc : [...Acc, H]>
  : Acc;

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export interface ParsedQuery {
  row: unknown;
  params: Record<string, SqlValue>;
}

type CheckRoles<
  ColsRaw extends string,
  FromRaw extends string,
  WhereRaw extends string,
> = ColsRaw extends `${string}«f:${string}`
  ? XqlError<"a from() fragment is in the SELECT position">
  : ColsRaw extends `${string}«w:${string}`
    ? XqlError<"a where() fragment is in the SELECT position">
    : FromRaw extends `${string}«c:${string}`
      ? XqlError<"a cols() fragment is in the FROM position">
      : FromRaw extends `${string}«w:${string}`
        ? XqlError<"a where() fragment is in the FROM position">
        : WhereRaw extends `${string}«c:${string}`
          ? XqlError<"a cols() fragment is in the WHERE position">
          : WhereRaw extends `${string}«f:${string}`
            ? XqlError<"a from() fragment is in the WHERE position">
            : null;

/** Operators become spaces so `p.id=:x` tokenizes as `p.id` and `x`. */
type ReplaceEach<
  S extends string,
  Cs extends readonly string[],
> = Cs extends readonly [infer H extends string, ...infer R extends string[]]
  ? ReplaceEach<ReplaceAll<S, H, " ">, R>
  : S;

type OpChars = ["=", "<", ">", "!", ",", "+", "-", "/", "%", "*", "|"];

type SpaceEach<
  S extends string,
  Cs extends readonly string[],
> = Cs extends readonly [infer H extends string, ...infer R extends string[]]
  ? SpaceEach<ReplaceAll<S, H, ` ${H} `>, R>
  : S;

/** Operators become their own tokens; `::casts` stay attached to their value. */
type TailTokens<S extends string> = Words<
  SpaceEach<
    ReplaceAll<ReplaceAll<MaskStrings<S>, "(", " ( ">, ")", " ) ">,
    OpChars
  >
>;

type StripCast<S extends string> = S extends `${infer A}::${string}` ? A : S;

type OperatorTok = "=" | "<" | ">" | "!" | "+" | "-" | "*" | "/" | "%" | "|";
type OpKeyword =
  | "is" | "in" | "like" | "ilike" | "between" | "not" | "similar";

type IsOperatorish<T extends string> = T extends OperatorTok
  ? true
  : Lowercase<T> extends OpKeyword
    ? true
    : false;

type NextTok<R extends readonly string[]> = R extends readonly [
  infer H extends string,
  ...string[],
]
  ? H
  : "";

/**
 * Words that can sit next to an operator without being a column. Being generous
 * here only weakens detection; missing one would reject valid SQL.
 */
type Keyword =
  | "null" | "true" | "false" | "unknown" | "and" | "or" | "not" | "is" | "in"
  | "any" | "all" | "some" | "between" | "symmetric" | "asymmetric"
  | "distinct" | "from" | "interval" | "case" | "when" | "then" | "else"
  | "end" | "escape" | "similar" | "to" | "nulls" | "first" | "last" | "asc"
  | "desc" | "by" | "like" | "ilike" | "exists" | "array" | "default" | "cast"
  | "as" | "collate" | "at" | "time" | "zone" | "filter" | "over" | "partition"
  | "within" | "group" | "order" | "having" | "where" | "limit" | "offset"
  | "row" | "rows" | "only" | "next" | "fetch" | "for" | "update" | "share"
  | "of" | "nowait" | "locked" | "skip" | "union" | "intersect" | "except"
  | "on" | "using" | "natural" | "left" | "right" | "full" | "inner" | "outer"
  | "join" | "cross" | "lateral" | "with" | "values" | "returning" | "set"
  | "into" | "insert" | "delete" | "select" | "current_date" | "current_time"
  | "current_timestamp" | "localtime" | "localtimestamp" | "current_user"
  | "session_user" | "user" | "current_schema" | "recursive" | "materialized"
  | "ordinality" | "tablesample";

type NonIdentChar =
  | OperatorTok
  | "("
  | ")"
  | "."
  | ","
  | ":"
  | "'"
  | '"'
  | "["
  | "]";

type IsPlainIdent<S extends string> = S extends ""
  ? false
  : S extends `${Digit}${string}`
    ? false
    : S extends `${string}${NonIdentChar}${string}`
      ? false
      : true;

/**
 * Whether `A.C` is a real column reference worth resolving. Excludes numeric
 * literals (`1.5`), schema-qualified names (`public.product.id`), and function
 * calls (`public.my_func(x)`, detected by a following open paren).
 */
type IsColumnRef<
  A extends string,
  C extends string,
  Rest extends readonly string[],
> = A extends ""
  ? false
  : C extends ""
    ? false
    : C extends `${string}.${string}`
      ? false
      : A extends `${number}`
        ? false
        : Rest extends readonly ["(", ...string[]]
          ? false
          : true;

type ResolveBareRef<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Col extends string,
> = EntriesWithCol<S, E, Col> extends infer M extends readonly FromEntry[]
  ? M extends readonly [FromEntry]
    ? null
    : M extends readonly []
      ? XqlError<`unknown column "${Col}" — not on any table in scope (${AliasList<E>})`>
      : XqlError<`ambiguous column "${Col}" — qualify it, it exists on more than one table in scope (${AliasList<E>})`>
  : null;

/**
 * Validates references outside the SELECT list. Qualified `alias.column` refs
 * are always checked; a bare identifier is checked only when it sits next to an
 * operator, which is where a column name actually appears — that keeps keywords,
 * function names and cast types from being mistaken for columns.
 *
 * Postgres allows output names in GROUP BY / ORDER BY but not WHERE / HAVING,
 * so the walk tracks which clause it is in.
 */
type CheckTailRefs<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Out extends string,
  Toks extends readonly string[],
  Prev extends string = "",
  AllowOut extends boolean = false,
> = Toks extends readonly [infer H extends string, ...infer R extends string[]]
  ? Lowercase<H> extends "where" | "having"
    ? CheckTailRefs<S, E, Out, R, H, false>
    : Lowercase<H> extends "group" | "order"
      ? CheckTailRefs<S, E, Out, R, H, true>
      : R extends readonly ["(", ...string[]]
        ? CheckTailRefs<S, E, Out, R, H, AllowOut>
        : StripCast<H> extends infer T extends string
          ? T extends `${infer A}.${infer C}`
            ? IsColumnRef<A, C, R> extends true
              ? IsAlias<E, A> extends true
                ? HasCol<S, EntryByAlias<E, A>["table"], C> extends true
                  ? CheckTailRefs<S, E, Out, R, H, AllowOut>
                  : XqlError<`unknown column "${C}" on table "${EntryByAlias<E, A>["table"]}"`>
                : XqlError<`unknown table alias "${A}" — in scope: ${AliasList<E>}`>
              : CheckTailRefs<S, E, Out, R, H, AllowOut>
            : IsPlainIdent<T> extends true
              ? Lowercase<T> extends Keyword
                ? CheckTailRefs<S, E, Out, R, H, AllowOut>
                : AllowOut extends true
                  ? T extends Out
                    ? CheckTailRefs<S, E, Out, R, H, AllowOut>
                    : CheckBare<S, E, Out, T, R, Prev, H, AllowOut>
                  : CheckBare<S, E, Out, T, R, Prev, H, AllowOut>
              : CheckTailRefs<S, E, Out, R, H, AllowOut>
          : never
  : null;

type CheckBare<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Out extends string,
  T extends string,
  R extends readonly string[],
  Prev extends string,
  H extends string,
  AllowOut extends boolean,
> = IsOperatorish<Prev> extends true
  ? ResolveBareRef<S, E, T> extends infer Err
    ? Err extends XqlError<string>
      ? Err
      : CheckTailRefs<S, E, Out, R, H, AllowOut>
    : never
  : IsOperatorish<NextTok<R>> extends true
    ? ResolveBareRef<S, E, T> extends infer Err
      ? Err extends XqlError<string>
        ? Err
        : CheckTailRefs<S, E, Out, R, H, AllowOut>
      : never
    : CheckTailRefs<S, E, Out, R, H, AllowOut>;

type Build<
  S extends SchemaDef,
  Q extends string,
  ColsRaw extends string,
  FromRaw extends string,
  WhereRaw extends string,
> = CheckRoles<ColsRaw, FromRaw, WhereRaw> extends infer RoleErr
  ? RoleErr extends XqlError<string>
    ? RoleErr
    : ParseFrom<StripMarkers<FromRaw>> extends infer E extends
          readonly FromEntry[]
      ? ParseSelect<S, E, StripMarkers<ColsRaw>> extends infer Row
        ? [Row] extends [XqlError<string>]
          ? Row
          : CheckTailRefs<
                S,
                E,
                Extract<keyof Row, string>,
                TailTokens<StripMarkers<WhereRaw>>
              > extends infer RefErr
            ? RefErr extends XqlError<string>
              ? RefErr
              : CheckOrderColumns<
                    S,
                    E,
                    Extract<keyof Row, string>,
                    OrderByItems<Words<MaskStrings<StripMarkers<Q>>>>
                  > extends infer OErr
                ? OErr extends XqlError<string>
                  ? OErr
                  : {
                      row: Row;
                      params: {
                        [N in Distinct<
                          ParamNames<StripMarkers<Q>>
                        >[number]]: ParamType<S, E, StripMarkers<Q>, N>;
                      };
                    }
                : never
            : never
        : never
      : never
  : never;

type CheckTargets<
  S extends SchemaDef,
  Tbl extends string,
  Ts extends readonly string[],
> = Ts extends readonly [infer H extends string, ...infer R extends string[]]
  ? HasCol<S, Tbl, H> extends true
    ? CheckTargets<S, Tbl, R>
    : XqlError<`unknown column "${H}" on table "${Tbl}"`>
  : null;

type ColTypeOf<
  S extends SchemaDef,
  Tbl extends string,
  C extends string,
> = Tbl extends infer T extends keyof S
  ? C extends keyof S[T]
    ? ColType<S[T][C]>
    : never
  : never;

/**
 * `insert into t (a, b) values (:x, :y)` and `update t set a = :x` both map a
 * param to the column it is assigned to — including its nullability, since
 * assigning NULL to a nullable column is legitimate.
 */
type AssignParamMap<
  S extends SchemaDef,
  Tbl extends string,
  Pairs extends readonly (readonly [string, string])[],
  Acc = {},
> = Pairs extends readonly [
  readonly [infer C extends string, infer V extends string],
  ...infer R extends readonly (readonly [string, string])[],
]
  ? V extends `:${infer N}`
    ? AssignParamMap<S, Tbl, R, Acc & { [K in N]: ColTypeOf<S, Tbl, C> }>
    : AssignParamMap<S, Tbl, R, Acc>
  : Acc;

type BuildWrite<S extends SchemaDef, Q extends string> =
  ParseWrite<Q> extends infer W extends WriteInfo
    ? W["table"] extends keyof S
      ? [
            { table: W["table"]; alias: W["alias"]; nullable: false },
          ] extends infer E extends readonly FromEntry[]
        ? CheckTargets<S, W["table"], W["targets"]> extends infer TErr
          ? TErr extends XqlError<string>
            ? TErr
            : CheckTailRefs<
                  S,
                  E,
                  never,
                  TailTokens<StripMarkers<`${W["tail"]} ${W["returning"]}`>>
                > extends infer RErr
              ? RErr extends XqlError<string>
                ? RErr
                : (
                      W["returning"] extends ""
                        ? {}
                        : ParseSelect<S, E, StripMarkers<W["returning"]>>
                    ) extends infer Row
                  ? [Row] extends [XqlError<string>]
                    ? Row
                    : {
                        row: Row;
                        params: {
                          [N in Distinct<
                            ParamNames<StripMarkers<Q>>
                          >[number]]: N extends keyof AssignParamMap<
                            S,
                            W["table"],
                            W["pairs"]
                          >
                            ? AssignParamMap<S, W["table"], W["pairs"]>[N]
                            : ParamType<S, E, StripMarkers<Q>, N>;
                        };
                      }
                  : never
              : never
          : never
        : never
      : XqlError<`unknown table "${W["table"]}"`>
    : never;

// ---------------------------------------------------------------------------
// LIMIT / OFFSET / ORDER BY
// ---------------------------------------------------------------------------

type IsDigits<S extends string> = S extends `${infer C}${infer R}`
  ? C extends Digit
    ? R extends ""
      ? true
      : IsDigits<R>
    : false
  : false;

type IsLimitValue<V extends string> = IsDigits<V> extends true
  ? true
  : Lowercase<V> extends "all"
    ? true
    : V extends `:${string}`
      ? true
      : false;

type ValidNulls<W extends readonly string[]> = W extends readonly []
  ? true
  : W extends readonly [infer A extends string, infer B extends string]
    ? Lowercase<A> extends "nulls"
      ? Lowercase<B> extends "first" | "last"
        ? true
        : false
      : false
    : false;

type ValidDirection<W extends readonly string[]> = W extends readonly []
  ? true
  : W extends readonly [infer A extends string, ...infer R extends string[]]
    ? Lowercase<A> extends "asc" | "desc"
      ? ValidNulls<R>
      : ValidNulls<W>
    : false;

/** An operator token means the item is an expression, so leave it alone. */
type HasOpWord<W extends readonly string[]> = W extends readonly [
  infer H extends string,
  ...infer R extends string[],
]
  ? H extends "+" | "-" | "*" | "/" | "||" | "%"
    ? true
    : HasOpWord<R>
  : false;

type CheckOrderItem<Item extends string> =
  Words<Item> extends readonly [string, ...infer Rest extends string[]]
    ? Rest extends readonly []
      ? null
      : HasOpWord<Rest> extends true
        ? null
        : ValidDirection<Rest> extends true
          ? null
          : XqlError<`invalid ORDER BY direction in "${Item}" — use asc or desc, optionally followed by nulls first/last`>
    : null;

type CheckOrderItems<Items extends readonly string[]> =
  Items extends readonly [infer H extends string, ...infer R extends string[]]
    ? CheckOrderItem<Trim<H>> extends infer E
      ? E extends XqlError<string>
        ? E
        : CheckOrderItems<R>
      : never
    : null;

type OrderStop =
  | "limit" | "offset" | "for" | "fetch" | "union" | "intersect" | "except"
  | "window";

type TakeUntil<
  T extends readonly string[],
  Kw extends string,
  Acc extends string[] = [],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? Lowercase<H> extends Kw
    ? Acc
    : TakeUntil<R, Kw, [...Acc, H]>
  : Acc;

type CheckTailKw<T extends readonly string[]> = T extends readonly [
  infer H extends string,
  ...infer R extends string[],
]
  ? Lowercase<H> extends "limit" | "offset"
    ? R extends readonly [infer V extends string, ...infer R2 extends string[]]
      ? IsLimitValue<V> extends true
        ? CheckTailKw<R2>
        : XqlError<`${Uppercase<H>} must be a number, ALL, or a parameter`>
      : XqlError<`${Uppercase<H>} needs a value`>
    : Lowercase<H> extends "order"
      ? R extends readonly [infer B extends string, ...infer R2 extends string[]]
        ? Lowercase<B> extends "by"
          ? CheckOrderItems<
              SplitTopLevel<Join<TakeUntil<R2, OrderStop>, " ">>
            > extends infer E
            ? E extends XqlError<string>
              ? E
              : CheckTailKw<R2>
            : never
          : CheckTailKw<R>
        : null
      : CheckTailKw<R>
  : null;

type DirWord = "asc" | "desc" | "nulls" | "first" | "last";

type DropTrailingDir<W extends readonly string[]> = W extends readonly [
  ...infer I extends string[],
  infer L extends string,
]
  ? Lowercase<L> extends DirWord
    ? DropTrailingDir<I>
    : W
  : W;

type OrderByItems<T extends readonly string[]> = T extends readonly [
  infer H extends string,
  ...infer R extends string[],
]
  ? Lowercase<H> extends "order"
    ? R extends readonly [infer B extends string, ...infer R2 extends string[]]
      ? Lowercase<B> extends "by"
        ? SplitTopLevel<Join<TakeUntil<R2, OrderStop>, " ">>
        : OrderByItems<R>
      : []
    : OrderByItems<R>
  : [];

/**
 * A bare ORDER BY name may be an ordinal, one of the query's own output names,
 * or an unambiguous column from the FROM scope — matching what Postgres accepts.
 * Qualified refs are already covered by CheckTailRefs.
 */
type CheckOrderCol<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  RowKeys extends string,
  Name extends string,
> = Name extends `${number}`
  ? null
  : Name extends RowKeys
    ? null
    : Name extends `"${string}`
      ? null
      : Name extends `${string}.${string}`
        ? null
        : Name extends `${string}(${string}`
          ? null
          : EntriesWithCol<S, E, Name> extends infer M extends readonly FromEntry[]
            ? M extends readonly [FromEntry]
              ? null
              : M extends readonly []
                ? XqlError<`unknown ORDER BY column "${Name}" — not a selected output name, and not a column on any table in scope (${AliasList<E>})`>
                : XqlError<`ambiguous ORDER BY column "${Name}" — qualify it, it exists on more than one table in scope (${AliasList<E>})`>
            : null;

type CheckOrderColumns<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  RowKeys extends string,
  Items extends readonly string[],
> = Items extends readonly [infer H extends string, ...infer R extends string[]]
  ? DropTrailingDir<Words<Trim<H>>> extends infer Ex extends readonly string[]
    ? Ex extends readonly [infer Only extends string]
      ? CheckOrderCol<S, E, RowKeys, Only> extends infer Err
        ? Err extends XqlError<string>
          ? Err
          : CheckOrderColumns<S, E, RowKeys, R>
        : never
      : CheckOrderColumns<S, E, RowKeys, R>
    : never
  : null;

type StartsWithWith<Q extends string> =
  Words<Q> extends readonly [infer H extends string, ...string[]]
    ? Lowercase<H> extends "with"
      ? true
      : false
    : false;

// ---------------------------------------------------------------------------
// WITH (common table expressions)
// ---------------------------------------------------------------------------

/** A resolved CTE row becomes a table definition, so joins treat it as a table. */
type AsTableDef<Row> = { [K in keyof Row]: Column<Row[K]> };

type DropMaterialized<T extends readonly string[]> = T extends readonly [
  infer H extends string,
  ...infer R extends string[],
]
  ? Lowercase<H> extends "materialized" | "not"
    ? DropMaterialized<R>
    : T
  : T;

interface CteScope {
  schema: SchemaDef;
  main: string;
  params: unknown;
}

type Flatten<T> = { [K in keyof T]: T[K] } & {};

type ParseCteList<
  S extends SchemaDef,
  T extends readonly string[],
  PAcc = {},
> = T extends readonly [infer Name extends string, ...infer R extends string[]]
  ? R extends readonly ["(", ...string[]]
    ? XqlError<`column alias lists on a CTE ("${Name}" (...)) are not supported — name the columns in the CTE's own SELECT instead`>
    : Lowercase<NextTok<R>> extends "as"
    ? ParenGroup<DropMaterialized<DropKw<R, "as">>> extends infer G extends {
          items: readonly string[];
          rest: readonly string[];
        }
      ? ParseSelectQuery<S, Join<G["items"], " ">> extends infer B
        ? [B] extends [XqlError<string>]
          ? B
          : B extends { row: infer Row; params: infer BParams }
            ? S & { [K in Name]: AsTableDef<Row> } extends infer S2 extends
                  SchemaDef
              ? G["rest"] extends readonly [",", ...infer R2 extends string[]]
                ? ParseCteList<S2, R2, PAcc & BParams>
                : {
                    schema: S2;
                    main: Join<G["rest"], " ">;
                    params: PAcc & BParams;
                  }
              : never
            : never
        : never
      : never
    : XqlError<`malformed WITH clause near "${Name}"`>
  : XqlError<"malformed WITH clause">;

type IsRecursive<T extends readonly string[]> = T extends readonly [
  infer H extends string,
  ...string[],
]
  ? Lowercase<H> extends "recursive"
    ? true
    : false
  : false;

type WithCtes<S extends SchemaDef, Q extends string> =
  WTokens<StripMarkers<Q>> extends infer T extends readonly string[]
    ? DropKw<T, "with"> extends infer AfterWith extends readonly string[]
      ? IsRecursive<AfterWith> extends true
        ? XqlError<"WITH RECURSIVE is not supported — the CTE body cannot be resolved before the CTE exists">
        : ParseCteList<S, AfterWith> extends infer C
          ? [C] extends [XqlError<string>]
            ? C
            : C extends CteScope
              ? ParseSelectQuery<C["schema"], C["main"]> extends infer M
                ? [M] extends [XqlError<string>]
                  ? M
                  : M extends { row: infer R; params: infer MParams }
                    ? { row: R; params: Flatten<C["params"] & MParams> }
                    : never
                : never
              : never
          : never
      : never
    : never;

/** Full query literal -> `{ row, params }`, or an `XqlError`. */
export type ParseQuery<S extends SchemaDef, Q extends string> =
  StartsWithWith<Q> extends true
    ? WithCtes<S, Q>
    : CheckTailKw<Words<MaskStrings<StripMarkers<Q>>>> extends infer TErr
      ? TErr extends XqlError<string>
        ? TErr
        : StatementKind<Q> extends "select"
          ? ParseSelectQuery<S, Q>
          : BuildWrite<S, Q>
      : never;

type ParseSelectQuery<
  S extends SchemaDef,
  Q extends string,
  PQ extends string = Q,
> =
  FindKw<Words<Q>, "select"> extends infer Sel extends KwSplit
    ? Sel["found"] extends false
      ? XqlError<"query must contain a SELECT clause">
      : FindKw<Sel["after"], "from"> extends infer Frm extends KwSplit
        ? Frm["found"] extends false
          ? XqlError<"query must contain a FROM clause">
          : FindKw<Frm["after"], TailKw> extends infer Tail extends KwSplit
            ? Build<
                S,
                PQ,
                Trim<Join<Frm["before"], " ">>,
                Trim<Join<Tail["before"], " ">>,
                Trim<Join<[Tail["kw"], ...Tail["after"]], " ">>
              >
            : never
        : never
    : never;

export type RowOfQuery<S extends SchemaDef, Q extends string> =
  ParseQuery<S, Q> extends infer P
    ? [P] extends [XqlError<string>]
      ? P
      : P extends { row: infer R }
        ? R
        : never
    : never;

export type ParamsOfQuery<S extends SchemaDef, Q extends string> =
  ParseQuery<S, Q> extends infer P
    ? P extends { params: infer Pr }
      ? Pr
      : {}
    : {};
