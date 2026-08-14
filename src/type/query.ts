import type { ColType, SchemaDef } from "../schema.ts";
import type { FromEntry } from "./from.ts";
import { type ParseFrom } from "./from.ts";
import type {
  AliasList,
  EntryByAlias,
  HasCol,
  IsAlias,
  ParseSelect,
  XqlError,
} from "./select.ts";
import type { Join, ReplaceAll, Trim, Words } from "./string.ts";
import type { ParseWrite, StatementKind, WriteInfo } from "./write.ts";

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
}

type FindKw<
  T extends readonly string[],
  Kw extends string,
  Acc extends string[] = [],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? Lowercase<H> extends Kw
    ? { before: Acc; after: R; found: true }
    : FindKw<R, Kw, [...Acc, H]>
  : { before: Acc; after: []; found: false };

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
  ? Ref extends ""
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

type OpChars = ["::", "=", "<", ">", "!", ",", "+", "-", "/", "%", "*", "|"];

/** Parens stay as their own tokens so a function name can be recognised. */
type TailTokens<S extends string> = Words<
  ReplaceEach<
    ReplaceAll<ReplaceAll<MaskStrings<S>, "(", " ( ">, ")", " ) ">,
    OpChars
  >
>;

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

/**
 * Validates `alias.column` references outside the SELECT list — WHERE, GROUP BY,
 * HAVING, ORDER BY. Both an unknown alias and an unknown column are rejected,
 * matching what Postgres itself would refuse at execution time.
 */
type CheckTailRefs<
  S extends SchemaDef,
  E extends readonly FromEntry[],
  Toks extends readonly string[],
> = Toks extends readonly [infer H extends string, ...infer R extends string[]]
  ? H extends `${infer A}.${infer C}`
    ? IsColumnRef<A, C, R> extends true
      ? IsAlias<E, A> extends true
        ? HasCol<S, EntryByAlias<E, A>["table"], C> extends true
          ? CheckTailRefs<S, E, R>
          : XqlError<`unknown column "${C}" on table "${EntryByAlias<E, A>["table"]}"`>
        : XqlError<`unknown table alias "${A}" — in scope: ${AliasList<E>}`>
      : CheckTailRefs<S, E, R>
    : CheckTailRefs<S, E, R>
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
    : ParseFrom<StripMarkers<FromRaw>> extends infer E extends
          readonly FromEntry[]
      ? ParseSelect<S, E, StripMarkers<ColsRaw>> extends infer Row
        ? [Row] extends [XqlError<string>]
          ? Row
          : CheckTailRefs<
                S,
                E,
                TailTokens<StripMarkers<WhereRaw>>
              > extends infer RefErr
            ? RefErr extends XqlError<string>
              ? RefErr
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

/** Full query literal -> `{ row, params }`, or an `XqlError`. */
export type ParseQuery<S extends SchemaDef, Q extends string> =
  StatementKind<Q> extends "select"
    ? ParseSelectQuery<S, Q>
    : BuildWrite<S, Q>;

type ParseSelectQuery<S extends SchemaDef, Q extends string> =
  FindKw<Words<Q>, "select"> extends infer Sel extends KwSplit
    ? Sel["found"] extends false
      ? XqlError<"query must contain a SELECT clause">
      : FindKw<Sel["after"], "from"> extends infer Frm extends KwSplit
        ? Frm["found"] extends false
          ? XqlError<"query must contain a FROM clause">
          : FindKw<Frm["after"], TailKw> extends infer Tail extends KwSplit
            ? Build<
                S,
                Q,
                Trim<Join<Frm["before"], " ">>,
                Trim<Join<Tail["before"], " ">>,
                Trim<Join<Tail["after"], " ">>
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
