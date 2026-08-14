import { schema, xql } from "./fixture.ts";
import type { XqlError } from "../src/type/select.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type Rows<Q> = Q extends { rows(): Promise<infer R> } ? R : Q;

const cols = xql.cols(`p.id, p.title, p.price, v.sku`);
const product = xql.from(`product p left join variant v on v.product_id = p.id`);
declare const flag: boolean;

// conditional parts resolve, and the row type is unaffected by which are on
const q1 = xql(
  `select ${cols} from ${product}
   where ${xql.and(flag && `p.title is not null`, flag && `p.price > :e`)}`,
  { e: "" },
);
type _1 = Expect<Equal<
  Rows<typeof q1>,
  { id: bigint; title: string; price: string | null; sku: string | null }[]
>>;

// @ts-expect-error — a param inside a conditional part is still required
xql(`select ${cols} from ${product} where ${xql.and(flag && `p.price > :e`)}`);

// @ts-expect-error — :e is compared to price (numeric -> string), not a number
xql(`select ${cols} from ${product} where ${xql.and(flag && `p.price > :e`)}`, { e: 1 });

// @ts-expect-error — a bad column inside a conditional part is caught
xql(`select ${cols} from ${product} where ${xql.and(flag && `p.nope = 1`)}`).rows();

// an array built with push() has no literals left, so checking would be lost
const parts: string[] = [];
const bad = xql(`select ${cols} from ${product} where ${xql.and(...parts)}`);
type _3 = Expect<Equal<
  typeof bad,
  XqlError<"conditions must be literal strings — write them inline (cond && `...`) rather than pushing into an array, which erases the literal types">
>>;

export type _S = typeof schema;

// a statically-false condition drops out entirely, so its param is not required
const q2 = xql(
  `select ${cols} from ${product} where ${xql.and(true && `p.id > 0`, false && `p.title = :t`)}`,
);
type _4 = Expect<Equal<Rows<typeof q2>, { id: bigint; title: string; price: string | null; sku: string | null }[]>>;

// ...but a runtime-varying condition keeps its param required
// @ts-expect-error — :t may be present, so it must be supplied
xql(`select ${cols} from ${product} where ${xql.and(flag && `p.title = :t`)}`);
