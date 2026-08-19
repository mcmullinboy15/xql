import type { ParamNames } from "./query.ts";

export interface XqlParamFragment<
  SQL extends string = string,
  Params extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>,
> {
  readonly sql: SQL;
  readonly params: Params;
  readonly __xqlParamFragment: true;
}

type Falsy = false | null | undefined | "";

type StringKeys<T> = Extract<keyof T, string>;
type RequiredNames<SQL extends string> = ParamNames<SQL>[number];

/**
 * `xql.fragment()` owns exactly the named parameters present in its SQL.
 * Missing and extra keys both become `never` at the call site.
 */
export type ExactFragmentParams<
  SQL extends string,
  Params extends Readonly<Record<string, unknown>>,
> = Params
  & Record<Exclude<RequiredNames<SQL>, StringKeys<Params>>, never>
  & Record<Exclude<StringKeys<Params>, RequiredNames<SQL>>, never>;

export type FragmentParts = readonly (
  | string
  | false
  | null
  | undefined
  | XqlParamFragment<string, Readonly<Record<string, unknown>>>
)[];

type ActivePart<T> = Exclude<T, Falsy>;

type PartIsWide<T> = ActivePart<T> extends infer P
  ? [P] extends [never]
    ? false
    : P extends XqlParamFragment<infer SQL, Readonly<Record<string, unknown>>>
      ? string extends SQL ? true : false
      : P extends string
        ? string extends P ? true : false
        : false
  : false;

/** Same fail-closed behavior as ordinary conditional predicate strings. */
export type HasWidePart<T extends readonly unknown[]> = number extends T["length"]
  ? true
  : T extends readonly [infer H, ...infer R]
    ? PartIsWide<H> extends true
      ? true
      : HasWidePart<R>
    : false;

type Distinct<
  T extends readonly string[],
  Acc extends string[] = [],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? Distinct<R, H extends Acc[number] ? Acc : [...Acc, H]>
  : Acc;

/** Compact, literal-safe representation of the value type supplied by a fragment. */
export type FragmentParamTag<T> =
  [T] extends [string] ? "s"
    : [T] extends [number] ? "n"
      : [T] extends [bigint] ? "i"
        : [T] extends [boolean] ? "b"
          : [T] extends [Date] ? "d"
            : [T] extends [Uint8Array] ? "y"
              : [T] extends [null] ? "0"
                : [T] extends [readonly (infer Item)[]]
                  ? `a${FragmentParamTag<Item>}`
                  : "u";

export type FragmentParamType<Tag extends string> =
  Tag extends "s" ? string
    : Tag extends "n" ? number
      : Tag extends "i" ? bigint
        : Tag extends "b" ? boolean
          : Tag extends "d" ? Date
            : Tag extends "y" ? Uint8Array
              : Tag extends "0" ? null
                : Tag extends `a${infer Item extends string}`
                  ? FragmentParamType<Item>[]
                  : unknown;

type ParamMarkers<
  SQL extends string,
  Params extends Readonly<Record<string, unknown>>,
  Names extends readonly string[] = Distinct<ParamNames<SQL>>,
  Acc extends string = "",
> = Names extends readonly [infer H extends string, ...infer R extends string[]]
  ? ParamMarkers<
      SQL,
      Params,
      R,
      `${Acc}«p:${H}:${H extends keyof Params ? FragmentParamTag<Params[H]> : "u"}»`
    >
  : Acc;

type PartText<T> = ActivePart<T> extends infer P
  ? [P] extends [never]
    ? never
    : P extends XqlParamFragment<
          infer SQL,
          infer Params extends Readonly<Record<string, unknown>>
        >
      // Ownership boundaries let the outer query distinguish a placeholder
      // owned by this fragment from the same placeholder used elsewhere.
      ? `«o»${SQL}${ParamMarkers<SQL, Params>}«/o»`
      : P extends string
        ? P
        : never
  : never;

type JoinParts<
  T extends readonly unknown[],
  Sep extends string,
  Acc extends string = "",
  First extends boolean = true,
> = T extends readonly [infer H, ...infer R]
  ? PartText<H> extends infer S
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
  ? S extends "" ? Empty : S
  : never;

type StripOwnershipBoundaries<S extends string> =
  S extends `${infer Before}«o»${infer Middle}«/o»${infer After}`
    ? StripOwnershipBoundaries<`${Before}${Middle}${After}`>
    : S;

/**
 * Type-only metadata is carried inside the literal returned by and()/or().
 * It never reaches PostgreSQL; the public query types canonicalize it first.
 */
export type StripParamMarkers<S extends string> =
  S extends `${infer Before}«p:${string}»${infer After}`
    ? StripParamMarkers<`${Before}${After}`>
    : StripOwnershipBoundaries<S>;

/** Query text with all parameter-owning fragments removed completely. */
export type StripOwnedFragments<S extends string> =
  S extends `${infer Before}«o»${string}«/o»${infer After}`
    ? StripOwnedFragments<`${Before}${After}`>
    : S;

export type OwnedParamNames<S extends string> =
  S extends `${string}«p:${infer Name}:${string}»${infer Rest}`
    ? Name | OwnedParamNames<Rest>
    : never;

export type OwnedParamTag<
  S extends string,
  Name extends string,
> = S extends `${string}«p:${infer Current}:${infer Tag}»${infer Rest}`
  ? Current extends Name
    ? Tag | OwnedParamTag<Rest, Name>
    : OwnedParamTag<Rest, Name>
  : never;

export type DuplicateOwnedParamNames<
  S extends string,
  Seen extends string = never,
  Duplicates extends string = never,
> = S extends `${string}«p:${infer Name}:${string}»${infer Rest}`
  ? DuplicateOwnedParamNames<
      Rest,
      Seen | Name,
      Duplicates | (Name extends Seen ? Name : never)
    >
  : Duplicates;
