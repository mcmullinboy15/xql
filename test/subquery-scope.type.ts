import { schema } from "./fixture.ts";
import type { RowOfQuery } from "../src/type/query.ts";
import type { XqlError } from "../src/type/select.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type S = typeof schema;

// A subquery brings its own FROM, so its aliases must not be resolved against
// the outer scope — doing so rejected valid SQL.
type _1 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where p.id in (select v.product_id from variant v)">,
  { id: bigint }
>>;
type _2 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where exists (select 1 from variant v where v.product_id = p.id)">,
  { id: bigint }
>>;
type _3 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where p.id in (select v.product_id from variant v where v.sku in (select s.name from supplier s))">,
  { id: bigint }
>>;

// A set operator starts a query with its own scope; the row type comes from the
// first branch, as Postgres does.
type _4 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p union select v.id from variant v">,
  { id: bigint }
>>;
type _5 = Expect<Equal<
  RowOfQuery<S, "select p.title from product p union all select v.sku from variant v">,
  { title: string }
>>;

// The outer scope is still checked, including after a subquery has been skipped
type _6 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where p.nope = 1">,
  XqlError<'unknown column "nope" on table "product"'>
>>;
type _7 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where p.id in (select v.id from variant v) and p.nope = 1">,
  XqlError<'unknown column "nope" on table "product"'>
>>;
// a qualified ref is caught by the reference check...
type _8 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where p.id in (select v.id from variant v) order by p.nope">,
  XqlError<'unknown column "nope" on table "product"'>
>>;
// ...and a bare one by the ORDER BY resolver
type _9 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where p.id in (select v.id from variant v) order by nope">,
  XqlError<'unknown ORDER BY column "nope" — not a selected output name, and not a column on any table in scope (p)'>
>>;
