import type { CastTypes, Column, ColType, SchemaDef } from "../schema.ts";
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

type AddOpens<S extends string, D extends 1[]> = S extends `${string}(${infer R}`
  ? AddOpens<R, [...D, 1]>
  : D;

type SubCloses<S extends string, D extends 1[]> = S extends `${string})${infer R}`
  ? SubCloses<R, D extends [1, ...infer Rest extends 1[]] ? Rest : []>
  : D;

type AdjustDepth<D extends 1[], S extends string> = SubCloses<S, AddOpens<S, D>>;

/**
 * Finds a clause keyword at paren depth zero. A subquery has its own FROM, and
 * matching it would slice the clauses at the wrong place.
 */
type FindKw<
  T extends readonly string[],
  Kw extends string,
  Acc extends string[] = [],
  Depth extends 1[] = [],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? Depth extends []
    ? Lowercase<H> extends Kw
      ? { before: Acc; after: R; found: true; kw: H }
      : FindKw<R, Kw, [...Acc, H], AdjustDepth<Depth, H>>
    : FindKw<R, Kw, [...Acc, H], AdjustDepth<Depth, H>>
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

type MaskStrings<
  S extends string,
  Acc extends string = "",
> = S extends `${infer A}'${string}'${infer C}`
  ? MaskStrings<C, `${Acc}${A}''`>
  : `${Acc}${S}`;

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
  ? Lowercase<StripLeadingParens<StripTrailingOps<L>>> extends OperatorWord | ""
    ? LastRef<I>
    : StripLeadingParens<StripTrailingOps<L>>
  : "";

type OpChar = "=" | "<" | ">" | "!" | "~" | "(" | "," | "+" | "-" | "*" | "/";
type StripTrailingOps<S extends string> = S extends `${infer R}${OpChar}`
  ? StripTrailingOps<R>
  : S;

/** `(p.price` -> `p.price`, so a parenthesised predicate still resolves. */
type StripLeadingParens<S extends string> = S extends `(${infer R}`
  ? StripLeadingParens<R>
  : S;

type ContextRef<Q extends string, N extends string> =
  Mask<Q> extends `${infer Before}:${N}${string}`
    ? LastRef<Words<Before>>
    : "";

/**
 * `:ids::bytes[]` types the parameter as `Uint8Array[]`. An explicit cast on the
 * parameter is the only unambiguous signal of its shape — comparison context
 * gives the element type, which is wrong for `= any (...)`.
 */
type ParamCastSuffix<
  Q extends string,
  N extends string,
> = MaskStrings<Q> extends `${string}:${N}::${infer Rest}`
  ? TakeIdent<Rest> extends infer B extends string
    ? B extends ""
      ? never
      : Lowercase<B> extends infer L extends keyof CastTypes
        ? Rest extends `${B}[]${string}`
          ? CastTypes[L][]
          : CastTypes[L]
        : never
    : never
  : never;

type ParamType<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Q extends string,
  N extends string,
> = [ParamCastSuffix<Q, N>] extends [never]
  ? ParamTypeFromContext<S, E, Q, N>
  : ParamCastSuffix<Q, N>;

type ParamTypeFromContext<
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
> = WhereRaw extends `${string}__xql_dynamic__${string}`
  ? XqlError<"conditions must be literal strings — write them inline (cond && `...`) rather than pushing into an array, which erases the literal types">
  : ColsRaw extends `${string}«f:${string}`
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
type SkipBalanced<
  T extends readonly string[],
  Depth extends 1[] = [1],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? H extends "("
    ? SkipBalanced<R, [...Depth, 1]>
    : H extends ")"
      ? Depth extends [1, ...infer Rest extends 1[]]
        ? Rest extends []
          ? R
          : SkipBalanced<R, Rest>
        : R
      : SkipBalanced<R, Depth>
  : [];

type CheckTailRefs<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Out extends string,
  Toks extends readonly string[],
  Prev extends string = "",
  AllowOut extends boolean = false,
> = Toks extends readonly [infer H extends string, ...infer R extends string[]]
  ? Lowercase<H> extends "union" | "intersect" | "except"
    ? null
    : H extends "("
      ? Lowercase<NextTok<R>> extends "select"
        ? CheckTailRefs<S, E, Out, SkipBalanced<R>, H, AllowOut>
        : CheckTailRefs<S, E, Out, R, H, AllowOut>
      : Lowercase<H> extends "where" | "having"
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

/** The first failing check in a list, or null when all pass. */
type FirstError<T extends readonly unknown[]> = T extends readonly [
  infer H,
  ...infer R,
]
  ? H extends XqlError<string>
    ? H
    : FirstError<R>
  : null;

type Build<
  S extends SchemaDef,
  Q extends string,
  ColsRaw extends string,
  FromRaw extends string,
  WhereRaw extends string,
> = CheckRoles<ColsRaw, FromRaw, WhereRaw> extends infer RoleErr
  ? RoleErr extends XqlError<string>
    ? RoleErr
    : ParseFrom<StripMarkers<FromRaw>> extends infer E0
      ? [E0] extends [XqlError<string>]
        ? E0
        : E0 extends readonly FromEntry[]
      ? ParseSelect<S, E0, StripDistinct<StripMarkers<ColsRaw>>> extends infer Row
        ? [Row] extends [XqlError<string>]
          ? Row
          : FirstError<
                [
                  CheckTailRefs<
                    S,
                    E0,
                    never,
                    TailTokens<StripMarkers<DistinctOnGroup<ColsRaw>>>
                  >,
                  CheckTailRefs<
                    S,
                    E0,
                    Extract<keyof Row, string>,
                    TailTokens<StripMarkers<WhereRaw>>
                  >,
                  CheckOrderColumns<
                    S,
                    E0,
                    Extract<keyof Row, string>,
                    OrderByItems<Words<MaskStrings<StripMarkers<Q>>>>
                  >,
                ]
              > extends infer Err
            ? Err extends XqlError<string>
              ? Err
              : {
                  row: Row;
                  params: {
                    [N in Distinct<
                      ParamNames<StripMarkers<Q>>
                    >[number]]: ParamType<S, E0, StripMarkers<Q>, N>;
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

/** A LIMIT inside a subquery carries the rest of the expression, e.g. `1)::int4`. */
type LimitValue<S extends string> = S extends `${infer A})${string}`
  ? A
  : S extends `${infer A};${string}`
    ? A
    : S;

type IsLimitValue<Raw extends string, V extends string = LimitValue<Raw>> = IsDigits<V> extends true
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

type StripSemis<S extends string> = S extends `${infer R};`
  ? StripSemis<R>
  : S;

type PopDirs<
  W extends readonly string[],
  Suffix extends string[] = [],
> = W extends readonly [...infer I extends string[], infer L extends string]
  ? Lowercase<L> extends DirWord
    ? PopDirs<I, [L, ...Suffix]>
    : { head: W; suffix: Suffix }
  : { head: []; suffix: Suffix };

type HasDirWord<W extends readonly string[]> = W extends readonly [
  infer H extends string,
  ...infer R extends string[],
]
  ? Lowercase<H> extends DirWord
    ? true
    : HasDirWord<R>
  : false;

type IsSimpleTok<S extends string> = S extends `${string}${
  | "("
  | ")"
  | "'"
  | '"'
  | ","
  | "+"
  | "-"
  | "*"
  | "/"}${string}`
  ? false
  : true;

/**
 * An ORDER BY item is `<expression> [asc|desc] [nulls first|last]`. Only the
 * direction suffix is checkable — an expression may be a function call, a CASE,
 * or arithmetic, none of which can be told from a malformed direction by shape
 * alone. So the suffix is peeled off and validated, and the remainder is only
 * questioned when it looks like a bare column followed by a stray word.
 */
type CheckOrderItem<Item extends string> =
  PopDirs<Words<StripSemis<Item>>> extends infer P extends {
    head: readonly string[];
    suffix: readonly string[];
  }
    ? P["head"] extends readonly []
      ? BadDirection<Item>
      : ValidDirection<P["suffix"]> extends true
        ? P["head"] extends readonly [string]
          ? null
          : P["head"] extends readonly [string, ...infer R extends string[]]
            ? HasDirWord<R> extends true
              ? BadDirection<Item>
              : P["head"] extends readonly [
                    infer A extends string,
                    infer B extends string,
                  ]
                ? IsSimpleTok<A> extends true
                  ? IsPlainIdent<B> extends true
                    ? BadDirection<Item>
                    : null
                  : null
                : null
            : null
        : BadDirection<Item>
    : null;

type BadDirection<Item extends string> =
  XqlError<`invalid ORDER BY direction in "${Item}" — use asc or desc, optionally followed by nulls first/last`>;

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

/**
 * `distinct` and `distinct on (...)` sit between SELECT and the select list.
 * They do not change the row type, so they are removed before resolving it —
 * otherwise `distinct` reads as the first output column.
 */
type StripDistinctOn<T extends readonly string[]> = T extends readonly [
  string,
  ...infer R extends string[],
]
  ? R extends readonly [infer N extends string, ...infer R2 extends string[]]
    ? Lowercase<N> extends "on"
      ? ParenGroup<R2> extends { rest: infer Rest extends readonly string[] }
        ? Join<Rest, " ">
        : ""
      : Join<R, " ">
    : ""
  : "";

/** The expressions inside `distinct on (...)`, which are still column refs. */
type ExtractOnGroup<T extends readonly string[]> = T extends readonly [
  string,
  ...infer R extends string[],
]
  ? R extends readonly [infer N extends string, ...infer R2 extends string[]]
    ? Lowercase<N> extends "on"
      ? ParenGroup<R2> extends { items: infer I extends readonly string[] }
        ? Join<I, " ">
        : ""
      : ""
    : ""
  : "";

type DistinctOnGroup<Cols extends string> =
  Words<Cols> extends readonly [infer H extends string, ...string[]]
    ? Lowercase<H> extends "distinct"
      ? ExtractOnGroup<WTokens<Cols>>
      : ""
    : "";

type StripDistinct<Cols extends string> =
  Words<Cols> extends readonly [infer H extends string, ...string[]]
    ? Lowercase<H> extends "distinct" | "all"
      ? StripDistinctOn<WTokens<Cols>>
      : Cols
    : Cols;

type StartsWithWith<Q extends string> =
  Words<Q> extends readonly [infer H extends string, ...string[]]
    ? Lowercase<H> extends "with"
      ? true
      : false
    : false;

// ---------------------------------------------------------------------------
// Conditional predicate fragments
// ---------------------------------------------------------------------------

type Falsy = false | null | undefined | "";

export type FragmentParts = readonly (string | false | null | undefined)[];

/**
 * A part whose type has widened to `string` carries no literal to validate, so
 * the whole predicate would silently lose checking. Detected and refused.
 */
export type HasWidePart<T extends readonly unknown[]> = number extends T["length"]
  ? true
  : T extends readonly [infer H, ...infer R]
    ? string extends Exclude<H, Falsy>
      ? true
      : HasWidePart<R>
    : false;

type JoinParts<
  T extends readonly unknown[],
  Sep extends string,
  Acc extends string = "",
  First extends boolean = true,
> = T extends readonly [infer H, ...infer R]
  ? Exclude<H, Falsy> extends infer S
    ? [S] extends [never]
      ? JoinParts<R, Sep, Acc, First>
      : S extends string
        ? JoinParts<
            R,
            Sep,
            First extends true ? `(${S})` : `${Acc} ${Sep} (${S})`,
            false
          >
        : JoinParts<R, Sep, Acc, First>
    : never
  : Acc;

export type PredicateText<
  T extends FragmentParts,
  Sep extends string,
  Empty extends string,
> = JoinParts<T, Sep> extends infer S extends string
  ? S extends ""
    ? Empty
    : S
  : never;

/**
 * Returned in place of a predicate when the parts have widened to `string`.
 * A value-position template literal accepts any type, so an error object here
 * would just widen the query and silently drop all checking; a sentinel keeps
 * the query a literal and lets CheckRoles report it properly.
 */
export type DynamicFragmentSentinel = "«w:__xql_dynamic__»";

// ---------------------------------------------------------------------------
// WITH (common table expressions)
// ---------------------------------------------------------------------------

/**
 * A CTE body may be a SELECT or a data-modifying statement with RETURNING, so it
 * dispatches the same way a top-level statement does.
 */
type CteBody<S extends SchemaDef, Q extends string> =
  StatementKind<Q> extends "select"
    ? ParseSelectQuery<S, Q>
    : BuildWrite<S, Q>;

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
      ? CteBody<S, Join<G["items"], " ">> extends infer B
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
          ? // A FROM clause is optional: `select (select …) as a` is a whole
            // query whose columns are all self-typing.
            FindKw<Sel["after"], TailKw> extends infer Bare extends KwSplit
            ? Build<
                S,
                PQ,
                Trim<Join<Bare["before"], " ">>,
                "",
                Trim<Join<[Bare["kw"], ...Bare["after"]], " ">>
              >
            : never
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
