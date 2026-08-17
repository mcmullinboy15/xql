import { defineSchema, t } from "../src/schema.ts";
import type { RowOfQuery } from "../src/type/query.ts";
import type { XqlError } from "../src/type/select.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const schema = defineSchema({ product: { id: t.int8(), title: t.text() } });
type S = typeof schema;

// A FROM clause is optional when every column types itself
type _1 = Expect<Equal<
  RowOfQuery<S, "select (select count(*) from product)::int8 as n, exists (select 1 from product) as any_p">,
  { n: bigint; any_p: boolean }
>>;
type _2 = Expect<Equal<RowOfQuery<S, "select 1::int8 as one, 'x'::text as s">, { one: bigint; s: string }>>;
type _3 = Expect<Equal<RowOfQuery<S, "select now() as at">, { at: Date }>>;

// ...but a column reference with no scope cannot resolve, and says so plainly
type _4 = Expect<Equal<
  RowOfQuery<S, "select nope">,
  XqlError<'unknown column "nope" — the query has no FROM clause'>
>>;

// a cast only ends the expression when what follows looks like a type name, so
// a nested cast is not mistaken for the outer one
type _5 = Expect<Equal<
  RowOfQuery<S, "select (select count(*)::int8 from product) as n">,
  XqlError<'cannot infer the type of "(select count(*)::int8 from product)" — add an explicit cast, e.g. (select count(*)::int8 from product)::text'>
>>;
// ...while a genuine unknown type is still named
type _6 = Expect<Equal<
  RowOfQuery<S, "select p.id::nosuchtype as x from product p">,
  XqlError<'unknown cast type "nosuchtype"'>
>>;
// and ordinary queries are unaffected
type _7 = Expect<Equal<RowOfQuery<S, "select p.id, p.title from product p">, { id: bigint; title: string }>>;

// --- FROM constructs xql does not parse fail clearly ------------------------
// A subquery in FROM used to be read as a table literally named "(", giving
// `unknown table alias "a" — in scope: select`.
type _8 = Expect<Equal<
  RowOfQuery<S, "select a.id from ( select id from product ) as a">,
  XqlError<"a subquery in FROM is not supported — lift it into a WITH clause, which xql does resolve">
>>;
type _9 = Expect<Equal<
  RowOfQuery<S, "select p.id from product p, lateral (select 1) as l">,
  XqlError<"a subquery in FROM is not supported — lift it into a WITH clause, which xql does resolve">
>>;
type _10 = Expect<Equal<
  RowOfQuery<S, "select v.sku from unnest(:ids::string[]) as v (sku)">,
  XqlError<'a table function in FROM is not supported ("unnest") — for a list parameter use `= any (:ids::type[])` instead'>
>>;
// the suggested alternative resolves
type _11 = Expect<Equal<
  RowOfQuery<S, "with a as (select id from product) select a.id from a">,
  { id: bigint }
>>;

// the paren may be attached or split off by a token rejoin, as happens inside a
// CTE body — both spellings must be caught
type _12 = Expect<Equal<
  RowOfQuery<S, "select v.sku from unnest ( :ids::string[] ) as v ( sku )">,
  XqlError<'a table function in FROM is not supported ("unnest") — for a list parameter use `= any (:ids::type[])` instead'>
>>;
type _13 = Expect<Equal<
  RowOfQuery<S, "with e as ( select li_id from unnest( :ids::int8[] ) as t (li_id) ) select e.li_id from e">,
  XqlError<'a table function in FROM is not supported ("unnest") — for a list parameter use `= any (:ids::type[])` instead'>
>>;
