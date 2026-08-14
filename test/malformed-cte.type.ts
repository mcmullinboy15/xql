import { schema } from "./fixture.ts";
import type { RowOfQuery } from "../src/type/query.ts";
import type { XqlError } from "../src/type/select.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type S = typeof schema;

// A dangling comma after a CTE promises another CTE that never arrives. The
// diagnosis must name the offending token rather than blaming the SELECT.
type _c1 = Expect<Equal<
  RowOfQuery<S, "with asdf as (\n select id from product\n ),\n select p.id from product p">,
  XqlError<'malformed WITH clause near "select"'>
>>;
// ...and without the comma the same query resolves
type _c2 = Expect<Equal<
  RowOfQuery<S, "with asdf as (\n select id from product\n )\n select p.id from product p">,
  { id: bigint }
>>;
// a CTE whose name is followed by a paren instead of `as`
type _c3 = Expect<Equal<
  RowOfQuery<S, "with asdf (select id from product) select p.id from product p">,
  XqlError<'column alias lists on a CTE ("asdf" (...)) are not supported — name the columns in the CTE\'s own SELECT instead'>
>>;
// a CTE name followed by neither `as` nor `(`
type _c4 = Expect<Equal<
  RowOfQuery<S, "with asdf select id from product">,
  XqlError<'malformed WITH clause near "asdf"'>
>>;
