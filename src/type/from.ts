import type { ReplaceAll, Words } from "./string.ts";

export interface FromEntry {
  table: string;
  alias: string;
  nullable: boolean;
}

type StopKw =
  | "join"
  | "left"
  | "right"
  | "inner"
  | "full"
  | "cross"
  | "natural"
  | "on"
  | "using"
  | ",";

type JoinStart =
  | "join"
  | "left"
  | "right"
  | "inner"
  | "full"
  | "cross"
  | "natural"
  | ",";

interface Ref {
  table: string;
  alias: string;
  rest: readonly string[];
}

/** Reads `table`, `table alias`, or `table as alias`. */
type ReadRef<T extends readonly string[]> = T extends readonly [
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
      : Lowercase<A> extends StopKw
        ? { table: Tbl; alias: Tbl; rest: R }
        : { table: Tbl; alias: A; rest: R2 }
    : { table: Tbl; alias: Tbl; rest: [] }
  : never;

type DropJoinWords<T extends readonly string[]> = T extends readonly [
  infer H extends string,
  ...infer R extends string[],
]
  ? Lowercase<H> extends "outer" | "join" | "inner" | "natural" | "cross"
    ? DropJoinWords<R>
    : T
  : [];

type SkipToJoin<T extends readonly string[]> = T extends readonly [
  infer H extends string,
  ...infer R extends string[],
]
  ? Lowercase<H> extends JoinStart
    ? T
    : SkipToJoin<R>
  : [];

/** Consumes an `ON ...` / `USING ...` tail, stopping at the next join. */
type SkipOnClause<T extends readonly string[]> = T extends readonly [
  infer H extends string,
  ...infer R extends string[],
]
  ? Lowercase<H> extends "on" | "using"
    ? SkipToJoin<R>
    : T
  : [];

/**
 * `addNull` — the newly joined table can be all-NULL (LEFT/FULL).
 * `priorNull` — every previously joined table can be all-NULL (RIGHT/FULL).
 */
interface JoinKind {
  addNull: boolean;
  priorNull: boolean;
  rest: readonly string[];
}

type ReadJoinKind<T extends readonly string[]> = T extends readonly [
  infer H extends string,
  ...infer R extends string[],
]
  ? Lowercase<H> extends ","
    ? { addNull: false; priorNull: false; rest: R }
    : Lowercase<H> extends "join" | "inner" | "cross" | "natural"
      ? { addNull: false; priorNull: false; rest: DropJoinWords<R> }
      : Lowercase<H> extends "left"
        ? { addNull: true; priorNull: false; rest: DropJoinWords<R> }
        : Lowercase<H> extends "right"
          ? { addNull: false; priorNull: true; rest: DropJoinWords<R> }
          : Lowercase<H> extends "full"
            ? { addNull: true; priorNull: true; rest: DropJoinWords<R> }
            : never
  : never;

type MarkNullable<E extends readonly FromEntry[]> = {
  [K in keyof E]: {
    table: E[K]["table"];
    alias: E[K]["alias"];
    nullable: true;
  };
};

type Append<
  Acc extends readonly FromEntry[],
  PriorNull extends boolean,
  E extends FromEntry,
> = PriorNull extends true ? [...MarkNullable<Acc>, E] : [...Acc, E];

type ParseJoins<
  T extends readonly string[],
  Acc extends readonly FromEntry[],
> = T extends readonly []
  ? Acc
  : ReadJoinKind<T> extends infer K extends JoinKind
    ? ReadRef<K["rest"]> extends infer R extends Ref
      ? ParseJoins<
          SkipOnClause<R["rest"]>,
          Append<
            Acc,
            K["priorNull"],
            { table: R["table"]; alias: R["alias"]; nullable: K["addNull"] }
          >
        >
      : Acc
    : Acc;

/** `product p left join variant v on ...` -> ordered table entries with join nullability. */
export type ParseFrom<S extends string> =
  ReadRef<Words<ReplaceAll<S, ",", " , ">>> extends infer R extends Ref
    ? ParseJoins<
        R["rest"],
        [{ table: R["table"]; alias: R["alias"]; nullable: false }]
      >
    : never;
