import type { Join, ReplaceAll, Words } from "./string.ts";

/** Parens and commas become their own tokens so clause structure is walkable. */
export type WTokens<S extends string> = Words<
  ReplaceAll<ReplaceAll<ReplaceAll<S, "(", " ( ">, ")", " ) ">, ",", " , ">
>;

export type DropKw<
  T extends readonly string[],
  Kw extends string,
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? Lowercase<H> extends Kw
    ? R
    : T
  : T;

export interface Split2 {
  before: readonly string[];
  after: readonly string[];
  found: boolean;
}

export type SplitAt<
  T extends readonly string[],
  Kw extends string,
  Acc extends string[] = [],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? Lowercase<H> extends Kw
    ? { before: Acc; after: R; found: true }
    : SplitAt<R, Kw, [...Acc, H]>
  : { before: Acc; after: []; found: false };

/** Consumes a parenthesised group, assuming `T[0]` is `(`. */
export type ParenGroup<
  T extends readonly string[],
  Depth extends 1[] = [],
  Acc extends string[] = [],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? H extends "("
    ? ParenGroup<R, [...Depth, 1], Depth extends [] ? Acc : [...Acc, H]>
    : H extends ")"
      ? Depth extends [1, ...infer Rest extends 1[]]
        ? Rest extends []
          ? { items: Acc; rest: R }
          : ParenGroup<R, Rest, [...Acc, H]>
        : { items: Acc; rest: R }
      : ParenGroup<R, Depth, [...Acc, H]>
  : { items: Acc; rest: [] };

/** Splits a token run on commas at paren depth zero. */
type SplitCommas<
  T extends readonly string[],
  Depth extends 1[] = [],
  Cur extends string[] = [],
  Acc extends string[][] = [],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? H extends ","
    ? Depth extends []
      ? SplitCommas<R, Depth, [], [...Acc, Cur]>
      : SplitCommas<R, Depth, [...Cur, H], Acc>
    : H extends "("
      ? SplitCommas<R, [...Depth, 1], [...Cur, H], Acc>
      : H extends ")"
        ? Depth extends [1, ...infer Rest extends 1[]]
          ? SplitCommas<R, Rest, [...Cur, H], Acc>
          : SplitCommas<R, Depth, [...Cur, H], Acc>
        : SplitCommas<R, Depth, [...Cur, H], Acc>
  : Cur extends []
    ? Acc
    : [...Acc, Cur];

type JoinEach<T extends readonly string[][]> = {
  [K in keyof T]: Join<T[K], " ">;
};

export interface WriteInfo {
  kind: "insert" | "update" | "delete";
  table: string;
  alias: string;
  returning: string;
  /** `[column, valueExpression]` for INSERT ... VALUES, so params can be typed. */
  pairs: readonly (readonly [string, string])[];
  /** Columns assigned by INSERT's column list or UPDATE's SET clause. */
  targets: readonly string[];
  tail: string;
}

type NoAliasNext =
  | "("
  | "values"
  | "default"
  | "select"
  | "set"
  | "where"
  | "using"
  | "returning"
  | "overriding"
  | "on";

/** Reads `table`, `table alias`, or `table as alias`. */
type ReadTarget<T extends readonly string[]> = T extends readonly [
  infer Tbl extends string,
  ...infer R extends string[],
]
  ? R extends readonly [infer A extends string, ...infer R2 extends string[]]
    ? Lowercase<A> extends "as"
      ? R2 extends readonly [
          infer Al extends string,
          ...infer R3 extends string[],
        ]
        ? { table: Tbl; alias: Al; rest: R3 }
        : { table: Tbl; alias: Tbl; rest: [] }
      : Lowercase<A> extends NoAliasNext
        ? { table: Tbl; alias: Tbl; rest: R }
        : { table: Tbl; alias: A; rest: R2 }
    : { table: Tbl; alias: Tbl; rest: [] }
  : never;

type Target = { table: string; alias: string; rest: readonly string[] };

type Zip<
  A extends readonly string[],
  B extends readonly string[],
  Acc extends (readonly [string, string])[] = [],
> = A extends readonly [infer AH extends string, ...infer AR extends string[]]
  ? B extends readonly [infer BH extends string, ...infer BR extends string[]]
    ? Zip<AR, BR, [...Acc, [AH, BH]]>
    : Acc
  : Acc;

type ParseInsert<T extends readonly string[]> =
  SplitAt<T, "returning"> extends infer RS extends Split2
    ? ReadTarget<DropKw<DropKw<RS["before"], "insert">, "into">> extends infer Tg
      ? Tg extends Target
        ? (
            Tg["rest"] extends readonly ["(", ...string[]]
              ? ParenGroup<Tg["rest"]>
              : { items: []; rest: Tg["rest"] }
          ) extends infer C extends { items: string[]; rest: readonly string[] }
          ? SplitAt<C["rest"], "values"> extends infer V extends Split2
            ? (
                V["after"] extends readonly ["(", ...string[]]
                  ? ParenGroup<V["after"]>
                  : { items: []; rest: [] }
              ) extends infer Vals extends { items: string[] }
              ? {
                  kind: "insert";
                  table: Tg["table"];
                  alias: Tg["alias"];
                  returning: Join<RS["after"], " ">;
                  pairs: Zip<
                    JoinEach<SplitCommas<C["items"]>>,
                    JoinEach<SplitCommas<Vals["items"]>>
                  >;
                  targets: JoinEach<SplitCommas<C["items"]>>;
                  tail: "";
                }
              : never
            : never
          : never
        : never
      : never
    : never;

/** `title = :t` -> `["title", ":t"]`, so SET params type like INSERT ones. */
type SetPairs<
  T extends readonly string[][],
  Acc extends (readonly [string, string])[] = [],
> = T extends readonly [
  infer H extends string[],
  ...infer R extends string[][],
]
  ? H extends readonly [
      infer C extends string,
      infer Eq extends string,
      ...infer V extends string[],
    ]
    ? Eq extends "="
      ? SetPairs<R, [...Acc, [C, Join<V, " ">]]>
      : SetPairs<R, Acc>
    : SetPairs<R, Acc>
  : Acc;

type SetTargets<T extends readonly string[][]> = {
  [K in keyof T]: T[K] extends readonly [infer H extends string, ...string[]]
    ? H
    : "";
};

type ParseUpdate<T extends readonly string[]> =
  SplitAt<T, "returning"> extends infer RS extends Split2
    ? ReadTarget<DropKw<RS["before"], "update">> extends infer Tg
      ? Tg extends Target
        ? SplitAt<Tg["rest"], "set"> extends infer St extends Split2
          ? SplitAt<St["after"], "where" | "from"> extends infer W extends Split2
            ? {
                kind: "update";
                table: Tg["table"];
                alias: Tg["alias"];
                returning: Join<RS["after"], " ">;
                pairs: SetPairs<SplitCommas<W["before"]>>;
                targets: SetTargets<SplitCommas<W["before"]>>;
                tail: Join<St["after"], " ">;
              }
            : never
          : never
        : never
      : never
    : never;

type ParseDelete<T extends readonly string[]> =
  SplitAt<T, "returning"> extends infer RS extends Split2
    ? ReadTarget<DropKw<DropKw<RS["before"], "delete">, "from">> extends infer Tg
      ? Tg extends Target
        ? {
            kind: "delete";
            table: Tg["table"];
            alias: Tg["alias"];
            returning: Join<RS["after"], " ">;
            pairs: [];
            targets: [];
            tail: Join<Tg["rest"], " ">;
          }
        : never
      : never
    : never;

export type StatementKind<Q extends string> =
  Words<Q> extends readonly [infer H extends string, ...string[]]
    ? Lowercase<H> extends "insert"
      ? "insert"
      : Lowercase<H> extends "update"
        ? "update"
        : Lowercase<H> extends "delete"
          ? "delete"
          : "select"
    : "select";

export type ParseWrite<Q extends string> =
  StatementKind<Q> extends "insert"
    ? ParseInsert<WTokens<Q>>
    : StatementKind<Q> extends "update"
      ? ParseUpdate<WTokens<Q>>
      : ParseDelete<WTokens<Q>>;
