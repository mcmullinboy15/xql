import { schema, xql } from "./fixture.ts";
import type { XqlError } from "../src/type/select.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type Rows<Q> = Q extends { rows(): Promise<infer R> } ? R : Q;

// ---- Goal 1: plain xql(`...`), auto-typed ------------------------------------
const q1 = xql(`select id, title from product`);
type _1 = Expect<Equal<Rows<typeof q1>, { id: bigint; title: string }[]>>;

// ---- Goal 2: composable, join-aware sections --------------------------------
const q2 = xql(
  `select ${xql.cols(`p.id, p.title, v.sku`)}
   from ${xql.from(`product p left join variant v on v.product_id = p.id`)}
   where ${xql.where(`p.title is not null`)}`,
);
// v.sku is string|null from the column AND the LEFT JOIN; p.title stays string.
type _2 = Expect<Equal<
  Rows<typeof q2>,
  { id: bigint; title: string; sku: string | null }[]
>>;

// A three-table join keeps every alias in scope
const q3 = xql(
  `select ${xql.cols(`p.title, s.name, v.sku`)}
   from ${xql.from(`product p join supplier s on s.id = p.id left join variant v on v.product_id = p.id`)}`,
);
type _3 = Expect<Equal<
  Rows<typeof q3>,
  { title: string; name: string; sku: string | null }[]
>>;

// ---- Params are typed from the column they are compared against -------------
const q4 = xql(`select id from product where id = :id`, { id: 7n });
type _4 = Expect<Equal<Rows<typeof q4>, { id: bigint }[]>>;

// @ts-expect-error — id is bigint, not string
xql(`select id from product where id = :id`, { id: "7" });

// @ts-expect-error — missing required param
xql(`select id from product where id = :id`);

// @ts-expect-error — no params accepted when the query has none
xql(`select id from product`, { id: 1n });

// ---- Errors surface at the call site ---------------------------------------
const bad1 = xql(`select p.titl from product p`);
type _5 = Expect<Equal<typeof bad1, XqlError<'unknown column "titl" on table "product"'>>>;
// @ts-expect-error — the error type has no .rows()
bad1.rows();

const bad2 = xql(`select id from product p join variant v on v.product_id = p.id`);
type _6 = Expect<Equal<typeof bad2, XqlError<'ambiguous column "id" — qualify it, it exists on more than one table in scope (p, v)'>>>;

// a column that exists only on the *other* table in scope
const bad3 = xql(`select ${xql.cols(`p.sku`)} from ${xql.from(`product p`)}`);
type _7 = Expect<Equal<typeof bad3, XqlError<'unknown column "sku" on table "product"'>>>;

// ---- Fragment role misuse is caught ----------------------------------------
const bad4 = xql(`select ${xql.where(`p.id = 1`)} from ${xql.from(`product p`)}`);
type _8 = Expect<Equal<typeof bad4, XqlError<"a where() fragment is in the SELECT position">>>;

// ---- Fragments are reusable values -----------------------------------------
const productWithVariants = xql.from(`product p left join variant v on v.product_id = p.id`);
const q5 = xql(`select ${xql.cols(`p.id, v.sku`)} from ${productWithVariants}`);
const q6 = xql(`select ${xql.cols(`count(*) as n`)} from ${productWithVariants}`);
type _9 = Expect<Equal<Rows<typeof q5>, { id: bigint; sku: string | null }[]>>;
type _10 = Expect<Equal<Rows<typeof q6>, { n: bigint }[]>>;

// ---- star, casts, aggregates ------------------------------------------------
const q7 = xql(`select * from product`);
type _11 = Expect<Equal<Rows<typeof q7>, { id: bigint; title: string; price: string | null; created_at: Date }[]>>;

const q8 = xql(`select p.id::text as sid, count(*) as n from product p group by p.id`);
type _12 = Expect<Equal<Rows<typeof q8>, { sid: string; n: bigint }[]>>;

// awaiting works directly
async function _demo() {
  const rows = await xql(`select id, title from product`);
  const t: string = rows[0]!.title;
  return t;
}
export type SchemaShape = typeof schema;

// ---- Writes: INSERT / UPDATE / DELETE with typed RETURNING ------------------
const w1 = xql(`insert into product (title, price) values (:title, :price) returning id, title`,
  { title: "shirt", price: "1.00" });
type _w1 = Expect<Equal<Rows<typeof w1>, { id: bigint; title: string }[]>>;

// insert params take their type from the column they are positioned against
// @ts-expect-error — title is text, not a number
xql(`insert into product (title, price) values (:title, :price)`, { title: 1, price: "1.00" });

// a nullable column accepts null
const w2 = xql(`insert into product (title, price) values (:title, :price)`, { title: "x", price: null });
type _w2 = Expect<Equal<Rows<typeof w2>, {}[]>>;

// @ts-expect-error — title is NOT NULL, so null is rejected
xql(`insert into product (title, price) values (:title, :price)`, { title: null, price: null });

// returning * expands
const w3 = xql(`insert into product (title) values (:title) returning *`, { title: "x" });
type _w3 = Expect<Equal<Rows<typeof w3>, { id: bigint; title: string; price: string | null; created_at: Date }[]>>;

// UPDATE: set-target params typed, where params typed, returning resolved
const w4 = xql(`update product set title = :title where id = :id returning id, title`, { title: "x", id: 1n });
type _w4 = Expect<Equal<Rows<typeof w4>, { id: bigint; title: string }[]>>;

// @ts-expect-error — id is bigint
xql(`update product set title = :title where id = :id`, { title: "x", id: 1 });

// DELETE
const w5 = xql(`delete from product where id = :id returning id`, { id: 1n });
type _w5 = Expect<Equal<Rows<typeof w5>, { id: bigint }[]>>;

// aliases work in writes
const w6 = xql(`update product p set title = :t where p.id = :id returning p.title as name`, { t: "x", id: 1n });
type _w6 = Expect<Equal<Rows<typeof w6>, { name: string }[]>>;

// ---- write errors surface at the call site ---------------------------------
const bw1 = xql(`insert into product (titel) values ('x')`);
type _e1 = Expect<Equal<typeof bw1, XqlError<'unknown column "titel" on table "product"'>>>;

const bw2 = xql(`update product set nope = 'x'`);
type _e2 = Expect<Equal<typeof bw2, XqlError<'unknown column "nope" on table "product"'>>>;

const bw3 = xql(`delete from product returning p.id`);
type _e3 = Expect<Equal<typeof bw3, XqlError<'unknown table alias "p" — in scope: product'>>>;

const bw4 = xql(`insert into nosuch (a) values (1)`);
type _e4 = Expect<Equal<typeof bw4, XqlError<'unknown table "nosuch"'>>>;

const bw5 = xql(`delete from product where nope = 1 returning id`);
type _e5 = Expect<Equal<Rows<typeof bw5>, { id: bigint }[]>>; // bare refs in tail are not checked

// SET assignments keep column nullability (unlike WHERE comparisons)
const w7 = xql(`update product set price = :price where id = :id`, { price: null, id: 1n });
type _w7 = Expect<Equal<Rows<typeof w7>, {}[]>>;
// @ts-expect-error — WHERE comparison against a nullable column still rejects null
xql(`select id from product where price = :p`, { p: null });
