import { schema } from "./fixture.ts";
import type { RowOfQuery } from "../src/type/query.ts";

type S = typeof schema;
type IsErr<Q extends string> = RowOfQuery<S, Q> extends { __xql_error__: string }
  ? true
  : false;
type Accepts<T extends false> = T;
type Rejects<T extends true> = T;

// Valid SQL that must not be mistaken for an unknown column. Keywords, function
// names, cast types, literals and quoted strings all appear next to operators.
type _a1 = Accepts<IsErr<"select id from product where title = :t">>;
type _a2 = Accepts<IsErr<"select id from product where price is null">>;
type _a3 = Accepts<IsErr<"select id from product where price is not null">>;
type _a4 = Accepts<IsErr<"select id from product where id in (1, 2, 3)">>;
type _a5 = Accepts<IsErr<"select id from product where id between 1 and 5">>;
type _a6 = Accepts<IsErr<"select id from product where lower(title) = :q">>;
type _a7 = Accepts<IsErr<"select id from product where id::text = :t">>;
type _a8 = Accepts<IsErr<"select id from product where created_at > current_timestamp">>;
type _a9 = Accepts<IsErr<"select id from product where created_at > now() - interval '1 day'">>;
type _a10 = Accepts<IsErr<"select id from product where title like '%x%' escape '!'">>;
type _a11 = Accepts<IsErr<"select id from product where case when id = 1 then true else false end">>;
type _a12 = Accepts<IsErr<"select id from product where not price is null">>;
type _a13 = Accepts<IsErr<"select id from product where id = any(array[1,2])">>;
type _a14 = Accepts<IsErr<"select id from product where title = 'a = b'">>;
type _a15 = Accepts<IsErr<"select id from product where cast(id as text) = :t">>;
type _a16 = Accepts<IsErr<"select p.id from product p join variant v on v.product_id = p.id where sku = :s">>;

// Output names are allowed in GROUP BY / ORDER BY, where Postgres allows them.
type _a17 = Accepts<IsErr<"select title as name, count(*) as n from product group by name">>;
type _a18 = Accepts<IsErr<"select title as name from product order by name">>;

// Unknown or ambiguous bare columns are rejected.
type _b1 = Rejects<IsErr<"select id from product where account_id = 1">>;
type _b2 = Rejects<IsErr<"select id from product where nope > 5">>;
type _b3 = Rejects<IsErr<"select id from product where 5 < nope">>;
// ...and an output name does NOT rescue an ambiguous ref in WHERE
type _b4 = Rejects<IsErr<"select p.id from product p join variant v on v.product_id = p.id where id = 1">>;
// including inside a CTE body
type _b5 = Rejects<IsErr<"with cheap as (select id from product where account_id < 5) select c.id from cheap c">>;
