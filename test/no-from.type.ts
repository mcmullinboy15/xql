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
