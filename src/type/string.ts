export type Ws = " " | "\n" | "\t" | "\r";

export type TrimL<S extends string> = S extends `${Ws}${infer R}` ? TrimL<R> : S;
export type TrimR<S extends string> = S extends `${infer R}${Ws}` ? TrimR<R> : S;
export type Trim<S extends string> = TrimL<TrimR<S>>;

/**
 * Tail-recursive: the accumulator keeps TypeScript's 1000-iteration budget
 * available instead of the ~100 it allows a type that rebuilds around its own
 * recursive call.
 */
export type ReplaceAll<
  S extends string,
  From extends string,
  To extends string,
  Acc extends string = "",
> = From extends ""
  ? `${Acc}${S}`
  : S extends `${infer A}${From}${infer B}`
    ? ReplaceAll<B, From, To, `${Acc}${A}${To}`>
    : `${Acc}${S}`;

export type Split<
  S extends string,
  D extends string,
  Acc extends string[] = [],
> = S extends `${infer H}${D}${infer T}`
  ? Split<T, D, [...Acc, H]>
  : [...Acc, S];

export type Compact<
  T extends readonly string[],
  Acc extends string[] = [],
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? Compact<R, H extends "" ? Acc : [...Acc, H]>
  : Acc;

export type Join<
  T extends readonly string[],
  D extends string = "",
  Acc extends string = "",
  First extends boolean = true,
> = T extends readonly [infer H extends string, ...infer R extends string[]]
  ? Join<R, D, First extends true ? H : `${Acc}${D}${H}`, false>
  : Acc;

type Spaced<S extends string> = ReplaceAll<
  ReplaceAll<ReplaceAll<S, "\n", " ">, "\t", " ">,
  "\r",
  " "
>;

/** Whitespace-delimited tokens, empties dropped. */
export type Words<S extends string> = Compact<Split<Spaced<S>, " ">>;

/** Splits off the segment after the final occurrence of `D`. */
export type AfterLast<
  S extends string,
  D extends string,
> = S extends `${infer _A}${D}${infer B}`
  ? B extends `${string}${D}${string}`
    ? AfterLast<B, D>
    : B
  : never;

export type BeforeLast<
  S extends string,
  D extends string,
  Acc extends string = "",
> = S extends `${infer A}${D}${infer B}`
  ? B extends `${string}${D}${string}`
    ? BeforeLast<B, D, `${Acc}${A}${D}`>
    : `${Acc}${A}`
  : Acc;

type Ones = 1[];
type CountOf<
  S extends string,
  C extends string,
  Acc extends Ones = [],
> = S extends `${string}${C}${infer R}` ? CountOf<R, C, [...Acc, 1]> : Acc;

export type Balanced<S extends string> =
  CountOf<S, "(">["length"] extends CountOf<S, ")">["length"] ? true : false;

/**
 * Splits on commas that are not inside parentheses, by splitting naively and
 * re-joining any run whose parens are still open.
 */
export type SplitTopLevel<
  S extends string,
  Parts extends readonly string[] = Split<S, ",">,
  Acc extends string[] = [],
  Cur extends string = "",
  Started extends boolean = false,
> = Parts extends readonly [
  infer H extends string,
  ...infer R extends string[],
]
  ? Started extends true
    ? Balanced<`${Cur},${H}`> extends true
      ? SplitTopLevel<S, R, [...Acc, `${Cur},${H}`], "", false>
      : SplitTopLevel<S, R, Acc, `${Cur},${H}`, true>
    : Balanced<H> extends true
      ? SplitTopLevel<S, R, [...Acc, H], "", false>
      : SplitTopLevel<S, R, Acc, H, true>
  : Started extends true
    ? [...Acc, Cur]
    : Acc;
