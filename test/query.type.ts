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

// ---- CTEs are refused rather than mis-parsed --------------------------------
// Clause splitting would otherwise find the CTE's inner SELECT and silently
// type the row from the subquery.
type _30 = Expect<Equal<
  RowOfQuery<S, "with recent as (\n  select id from product\n)\nselect p.title from product p">,
  XqlError<"WITH (common table expressions) is not supported — clause splitting would latch onto the CTE body and type the wrong columns">
>>;
type _31 = Expect<Equal<
  RowOfQuery<S, "WITH recent AS (select id from product) select p.title from product p">,
  XqlError<"WITH (common table expressions) is not supported — clause splitting would latch onto the CTE body and type the wrong columns">
>>;

// ---- LIMIT / OFFSET take a count -------------------------------------------
type _32 = Expect<Equal<
  RowOfQuery<S, "select id from product limit 'abc'">,
  XqlError<"LIMIT must be a number, ALL, or a parameter">
>>;
type _33 = Expect<Equal<
  RowOfQuery<S, "select id from product limit -5">,
  XqlError<"LIMIT must be a number, ALL, or a parameter">
>>;
type _34 = Expect<Equal<
  RowOfQuery<S, "select id from product offset x">,
  XqlError<"OFFSET must be a number, ALL, or a parameter">
>>;
type _35 = Expect<Equal<RowOfQuery<S, "select id from product limit all offset 5">, { id: bigint }>>;
// a LIMIT parameter is a count, not an arbitrary SqlValue
type _36 = Expect<Equal<
  ParamsOfQuery<S, "select id from product limit :n">,
  { n: number | bigint }
>>;

// ---- ORDER BY direction must be asc / desc ---------------------------------
type _37 = Expect<Equal<
  RowOfQuery<S, "select id from product order by id ascending">,
  XqlError<'invalid ORDER BY direction in "id ascending" — use asc or desc, optionally followed by nulls first/last'>
>>;
type _38 = Expect<Equal<
  RowOfQuery<S, "select id from product order by title desc, id descx">,
  XqlError<'invalid ORDER BY direction in "id descx" — use asc or desc, optionally followed by nulls first/last'>
>>;
type _39 = Expect<Equal<
  RowOfQuery<S, "select id from product order by id nulls sideways">,
  XqlError<'invalid ORDER BY direction in "id nulls sideways" — use asc or desc, optionally followed by nulls first/last'>
>>;
// valid direction forms all pass
type _40 = Expect<Equal<RowOfQuery<S, "select id from product order by id">, { id: bigint }>>;
type _41 = Expect<Equal<RowOfQuery<S, "select id from product order by id desc">, { id: bigint }>>;
type _42 = Expect<Equal<RowOfQuery<S, "select id from product order by id asc nulls last">, { id: bigint }>>;
type _43 = Expect<Equal<RowOfQuery<S, "select id from product order by title, id desc limit 10">, { id: bigint }>>;
// expressions are left alone rather than mis-flagged
type _44 = Expect<Equal<RowOfQuery<S, "select id from product order by price + 1 desc">, { id: bigint }>>;

// ---- ORDER BY columns resolve against output names, then the FROM scope -----
// a select-list alias is a valid ORDER BY target (Postgres resolves output names first)
type _45 = Expect<Equal<
  RowOfQuery<S, "select p.title as name from product p order by name">,
  { name: string }
>>;
type _46 = Expect<Equal<
  RowOfQuery<S, "select count(*) as n from product p group by p.title order by n desc">,
  { n: bigint }
>>;
// a bare input column not in the select list still resolves against the scope
type _47 = Expect<Equal<
  RowOfQuery<S, "select p.title from product p order by created_at desc">,
  { title: string }
>>;
// ordinals are allowed
type _48 = Expect<Equal<RowOfQuery<S, "select p.title from product p order by 1">, { title: string }>>;
// a name that is neither an output name nor a scope column is rejected
type _49 = Expect<Equal<
  RowOfQuery<S, "select p.title from product p order by nonexistent">,
  XqlError<'unknown ORDER BY column "nonexistent" — not a selected output name, and not a column on any table in scope (p)'>
>>;
// a typo'd select alias is rejected
type _50 = Expect<Equal<
  RowOfQuery<S, "select p.title as name from product p order by nmae desc">,
  XqlError<'unknown ORDER BY column "nmae" — not a selected output name, and not a column on any table in scope (p)'>
>>;
// a bare name on two joined tables, not selected, is ambiguous
type _51 = Expect<Equal<
  RowOfQuery<S, "select p.title from product p join variant v on v.product_id = p.id order by id">,
  XqlError<'ambiguous ORDER BY column "id" — qualify it, it exists on more than one table in scope (p, v)'>
>>;
// ...but if it IS the output name, the output wins, as Postgres does
type _52 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p join variant v on v.product_id = p.id order by id">,
  { id: bigint }
>>;
// expressions are still left alone
type _53 = Expect<Equal<
  RowOfQuery<S, "select p.title from product p order by price + 1 desc">,
  { title: string }
>>;
