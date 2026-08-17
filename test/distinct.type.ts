import { schema } from "./fixture.ts";
import type { RowOfQuery } from "../src/type/query.ts";
import type { XqlError } from "../src/type/select.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type S = typeof schema;

// DISTINCT does not change the row type; it must not be read as a column
type _1 = Expect<Equal<
  RowOfQuery<S, "select distinct p.title, p.id from product p">,
  { title: string; id: bigint }
>>;
type _2 = Expect<Equal<
  RowOfQuery<S, "select DISTINCT p.title from product p">,
  { title: string }
>>;
type _3 = Expect<Equal<RowOfQuery<S, "select distinct * from product">, {
  id: bigint; title: string; price: string | null; created_at: Date;
}>>;
// SELECT ALL is the explicit opposite and is equally transparent
type _4 = Expect<Equal<RowOfQuery<S, "select all p.id from product p">, { id: bigint }>>;

// DISTINCT ON drops its parenthesised expressions from the select list
type _5 = Expect<Equal<
  RowOfQuery<S, "select distinct on (p.title) p.title, p.id from product p">,
  { title: string; id: bigint }
>>;
type _6 = Expect<Equal<
  RowOfQuery<S, "select distinct on (p.title, p.id) p.title from product p">,
  { title: string }
>>;

// ...but its expressions are still column references, and are checked
type _7 = Expect<Equal<
  RowOfQuery<S, "select distinct on (p.nope) p.title from product p">,
  XqlError<'unknown column "nope" on table "product"'>
>>;
type _8 = Expect<Equal<
  RowOfQuery<S, "select distinct on (z.title) p.title from product p">,
  XqlError<'unknown table alias "z" — in scope: p'>
>>;
// the select list itself is still checked
type _9 = Expect<Equal<
  RowOfQuery<S, "select distinct p.nope from product p">,
  XqlError<'unknown column "nope" on table "product"'>
>>;
