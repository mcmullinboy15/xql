import { defineSchema, t } from "../src/schema.ts";
import type { ParseFrom } from "../src/type/from.ts";
import type { ParseSelect, XqlError } from "../src/type/select.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const schema = defineSchema({
  product: {
    id: t.int8(),
    title: t.text(),
    price: t.numeric().nullable(),
    created_at: t.timestamptz(),
  },
  variant: {
    id: t.int8(),
    product_id: t.int8(),
    sku: t.text().nullable(),
  },
});
type S = typeof schema;

type Inner = ParseFrom<"product p join variant v on v.product_id = p.id">;
type Left  = ParseFrom<"product p left join variant v on v.product_id = p.id">;
type One   = ParseFrom<"product">;

// qualified columns
type _1 = Expect<Equal<ParseSelect<S, Inner, "p.id, p.title">, { id: bigint; title: string }>>;

// LEFT JOIN makes the right side's columns nullable, on top of column nullability
type _2 = Expect<Equal<
  ParseSelect<S, Left, "p.id, v.sku, v.product_id">,
  { id: bigint; sku: string | null; product_id: bigint | null }
>>;

// column-level nullable survives an inner join
type _3 = Expect<Equal<ParseSelect<S, Inner, "p.price, v.sku">, { price: string | null; sku: string | null }>>;

// explicit alias
type _4 = Expect<Equal<ParseSelect<S, Inner, "p.title as name">, { name: string }>>;

// unqualified, unambiguous
type _5 = Expect<Equal<ParseSelect<S, One, "id, title">, { id: bigint; title: string }>>;

// unqualified ambiguous -> error
type _6 = Expect<Equal<
  ParseSelect<S, Inner, "id">,
  XqlError<'ambiguous column "id" — qualify it, it exists on more than one table in scope (p, v)'>
>>;

// unknown column
type _7 = Expect<Equal<
  ParseSelect<S, Inner, "p.titl">,
  XqlError<'unknown column "titl" on table "product"'>
>>;

// unknown alias
type _8 = Expect<Equal<
  ParseSelect<S, Inner, "z.id">,
  XqlError<'unknown table alias "z" — in scope: p, v'>
>>;

// star
type _9 = Expect<Equal<
  ParseSelect<S, One, "*">,
  { id: bigint; title: string; price: string | null; created_at: Date }
>>;

// alias star with LEFT JOIN nullability
type _10 = Expect<Equal<
  ParseSelect<S, Left, "v.*">,
  { id: bigint | null; product_id: bigint | null; sku: string | null }
>>;

// aggregates
type _11 = Expect<Equal<ParseSelect<S, Inner, "count(*) as n">, { n: bigint }>>;
type _12 = Expect<Equal<ParseSelect<S, Inner, "max(p.price) as hi">, { hi: string | null }>>;
type _13 = Expect<Equal<ParseSelect<S, Inner, "coalesce(p.price, '0') as pr">, { pr: string }>>;

// explicit cast escape hatch
type _14 = Expect<Equal<ParseSelect<S, Inner, "p.id::text as sid">, { sid: string }>>;
type _15 = Expect<Equal<ParseSelect<S, Inner, "jsonb_agg(v.sku)::jsonb as skus">, { skus: unknown }>>;

// cast without alias keeps the column name
type _16 = Expect<Equal<ParseSelect<S, Inner, "p.id::text">, { id: string }>>;

// unknown function without a cast -> actionable error
type _17 = Expect<Equal<
  ParseSelect<S, Inner, "weird_fn(p.id) as w">,
  XqlError<'cannot infer the type of "weird_fn(p.id)" — add an explicit cast, e.g. weird_fn(p.id)::text'>
>>;

// multiline + mixed
type _18 = Expect<Equal<
  ParseSelect<S, Left, "\n  p.id,\n  p.title as name,\n  v.sku,\n  count(*) as n\n">,
  { id: bigint; name: string; sku: string | null; n: bigint }
>>;
