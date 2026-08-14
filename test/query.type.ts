import { defineSchema, t } from "../src/schema.ts";
import type { ParamNames, ParamsOfQuery, RowOfQuery, SqlValue } from "../src/type/query.ts";
import type { XqlError } from "../src/type/select.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const schema = defineSchema({
  product: { id: t.int8(), title: t.text(), price: t.numeric().nullable(), created_at: t.timestamptz() },
  variant: { id: t.int8(), product_id: t.int8(), sku: t.text().nullable() },
});
type S = typeof schema;

// plain query, no fragments
type _1 = Expect<Equal<
  RowOfQuery<S, "select id, title from product where id = :id">,
  { id: bigint; title: string }
>>;

// param type inferred from the column it is compared against
type _2 = Expect<Equal<
  ParamsOfQuery<S, "select id from product where id = :id">,
  { id: bigint }
>>;

// two params, different inferred types
type _3 = Expect<Equal<
  ParamsOfQuery<S, "select id from product where id = :pid and title = :name">,
  { pid: bigint; name: string }
>>;

// param compared to a nullable column -> non-null binding
type _4 = Expect<Equal<
  ParamsOfQuery<S, "select id from product where price = :p">,
  { p: string }
>>;

// unresolvable context falls back to SqlValue
type _5 = Expect<Equal<
  ParamsOfQuery<S, "select id from product where lower(title) = :q">,
  { q: SqlValue }
>>;

// casts must not be mistaken for params
type _6 = Expect<Equal<ParamNames<"select id::text from product">, []>>;
type _7 = Expect<Equal<ParamNames<"select id::text from product where id = :id">, ["id"]>>;

// marker-composed query: select/from/where fragments
type Composed = "select «c:p.id, v.sku» from «f:product p left join variant v on v.product_id = p.id» where «w:p.id = :id»";
type _8 = Expect<Equal<RowOfQuery<S, Composed>, { id: bigint; sku: string | null }>>;
type _9 = Expect<Equal<ParamsOfQuery<S, Composed>, { id: bigint }>>;

// role misuse is caught
type _10 = Expect<Equal<
  RowOfQuery<S, "select «w:p.id = 1» from «f:product p»">,
  XqlError<"a where() fragment is in the SELECT position">
>>;
type _11 = Expect<Equal<
  RowOfQuery<S, "select «c:p.id» from «c:product p»">,
  XqlError<"a cols() fragment is in the FROM position">
>>;

// trailing clauses bound the FROM clause
type _12 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p order by p.created_at desc limit 10">,
  { id: bigint }
>>;
type _13 = Expect<Equal<
  RowOfQuery<S, "select p.title, count(*) as n from product p group by p.title">,
  { title: string; n: bigint }
>>;

// errors propagate out of the full query
type _14 = Expect<Equal<
  RowOfQuery<S, "select p.nope from product p">,
  XqlError<'unknown column "nope" on table "product"'>
>>;
type _15 = Expect<Equal<
  RowOfQuery<S, "select 1 from product">,
  XqlError<'unknown column "1" — not on any table in scope (product)'>
>>;

// ---- type-level validation of refs outside the SELECT list ------------------
type _16 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where p.nope = 1">,
  XqlError<'unknown column "nope" on table "product"'>
>>;
type _17 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p order by p.nope desc">,
  XqlError<'unknown column "nope" on table "product"'>
>>;
type _18 = Expect<Equal<
  RowOfQuery<S, "select p.title, count(*) as n from product p group by p.titl">,
  XqlError<'unknown column "titl" on table "product"'>
>>;
// an alias used in the tail but never joined is rejected
type _19 = Expect<Equal<
  RowOfQuery<S, "select p.title, count(*) as n from product p group by p.title having count(v.id) > 1">,
  XqlError<'unknown table alias "v" — in scope: p'>
>>;
type _20 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p left join variant v on v.product_id = p.id where v.skuu is null">,
  XqlError<'unknown column "skuu" on table "variant"'>
>>;
// valid refs still pass
type _21 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where p.title = :t and p.price is not null order by p.created_at desc limit 10">,
  { id: bigint }
>>;
// no false positives: casts, decimals, schema-qualified names, quoted strings
type _22 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where p.id::text = '1.5' and p.price > 1.5 and p.title = 'a.b'">,
  { id: bigint }
>>;

// ---- an alias used outside SELECT must exist in the FROM/JOIN scope ---------
type _23 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where z.id = 1">,
  XqlError<'unknown table alias "z" — in scope: p'>
>>;
type _24 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p order by z.created_at">,
  XqlError<'unknown table alias "z" — in scope: p'>
>>;
type _25 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p group by z.title">,
  XqlError<'unknown table alias "z" — in scope: p'>
>>;
// an alias that IS joined is accepted, and the scope lists every alias
type _26 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p left join variant v on v.product_id = p.id where v.sku = :s">,
  { id: bigint }
>>;
type _27 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where v.sku = :s">,
  XqlError<'unknown table alias "v" — in scope: p'>
>>;
// the join must actually be in THIS query's from clause, not another fragment
type _28 = Expect<Equal<
  RowOfQuery<S, "select «c:p.id» from «f:product p» where «w:v.sku is null»">,
  XqlError<'unknown table alias "v" — in scope: p'>
>>;
// no false positives: numeric literals, schema-qualified calls, quoted strings
type _29 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p where p.price > 1.5 and public.my_func(p.id) = 1 and p.title = 'a.b'">,
  { id: bigint }
>>;
