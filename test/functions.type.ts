import { defineSchema, t } from "../src/schema.ts";
import type { RowOfQuery } from "../src/type/query.ts";
import type { XqlError } from "../src/type/select.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const schema = defineSchema({
  product: { id: t.int8(), title: t.text(), digest: t.bytes(), price: t.numeric().nullable() },
  adjustment: { id: t.int8(), product_id: t.int8(), delta: t.int4() },
});
type S = typeof schema;

// functions whose result type SQL fixes need no cast
type _1 = Expect<Equal<RowOfQuery<S, "select lower(p.title) as t from product p">, { t: string }>>;
type _2 = Expect<Equal<RowOfQuery<S, "select encode(p.digest, 'hex') as h from product p">, { h: string }>>;
type _3 = Expect<Equal<RowOfQuery<S, "select length(p.title) as n from product p">, { n: number }>>;
type _4 = Expect<Equal<RowOfQuery<S, "select now() as at from product">, { at: Date }>>;
type _5 = Expect<Equal<RowOfQuery<S, "select row_number() over (order by p.id) as rn from product p">, { rn: bigint }>>;
type _6 = Expect<Equal<RowOfQuery<S, "select decode(p.title, 'hex') as d from product p">, { d: Uint8Array }>>;
// derived from the first argument
type _7 = Expect<Equal<RowOfQuery<S, "select nullif(p.price, '0') as pr from product p">, { pr: string }>>;
type _8 = Expect<Equal<RowOfQuery<S, "select greatest(p.id, 1) as g from product p">, { g: bigint }>>;
// an unknown function still needs a cast rather than being guessed
type _9 = Expect<Equal<
  RowOfQuery<S, "select weird_udf(p.id) as w from product p">,
  XqlError<'cannot infer the type of "weird_udf(p.id)" — add an explicit cast, e.g. weird_udf(p.id)::text'>
>>;

// --- clause splitting is paren-aware ---------------------------------------
// `exists (...)` is boolean, and the subquery's own FROM must not be taken as
// the outer one
type _10 = Expect<Equal<
  RowOfQuery<S, "select exists (select 1 from adjustment a where a.product_id = p.id) as has_adj from product p">,
  { has_adj: boolean }
>>;
type _11 = Expect<Equal<
  RowOfQuery<S, "select (select a.delta from adjustment a where a.product_id = p.id limit 1)::int4 as d from product p">,
  { d: number }
>>;
// a keyword or paren inside a string literal must not move a clause boundary
type _12 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where p.title = 'from nowhere'">,
  { id: bigint }
>>;
// LIMIT is still checked outside a subquery
type _13 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p limit 'abc'">,
  XqlError<"LIMIT must be a number, ALL, or a parameter">
>>;
