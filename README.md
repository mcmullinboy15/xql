# xql

A SQL-template-string query layer that types and validates its own output.

You write SQL. The type system reads it, resolves it against your schema, and
gives you the row type. At runtime the same parse builds a Zod schema and
validates every row. There is no query builder to learn — the builder is SQL.

```ts
const rows = await xql(`select id, title from product where id = :id`, { id: 7n });
//    ^? { id: bigint; title: string }[]
```

## Composable, scope-aware sections

Each section is its own value. `from` establishes the scope; `cols` and `where`
resolve against it.

```ts
const rows = await xql(
  `select ${xql.cols(`p.id, p.title, v.sku`)}
   from   ${xql.from(`product p left join variant v on v.product_id = p.id`)}
   where  ${xql.where(`p.title is not null and p.id = :id`)}`,
  { id: 7n },
);
//    ^? { id: bigint; title: string; sku: string | null }[]
```

`v.sku` is `string | null` for two independent reasons — the column is nullable
*and* the LEFT JOIN can produce no row. `p.title` stays `string`. A LEFT JOIN
onto a NOT NULL column still widens it:

```ts
xql(`select ${xql.cols(`s.name`)}
     from ${xql.from(`product p left join supplier s on s.id = p.supplier_id`)}`);
//  ^? { name: string | null }[]   — supplier.name is NOT NULL
```

RIGHT JOIN widens the *prior* side; FULL JOIN widens both.

Fragments are ordinary values, so they compose and get reused:

```ts
const withVariants = xql.from(`product p left join variant v on v.product_id = p.id`);

xql(`select ${xql.cols(`p.id, v.sku`)}   from ${withVariants}`);  // { id: bigint; sku: string | null }[]
xql(`select ${xql.cols(`count(*) as n`)} from ${withVariants}`);  // { n: bigint }[]
```

A fragment used in the wrong position is a type error, because each fragment
carries its role:

```ts
xql(`select ${xql.where(`p.id = 1`)} from ${xql.from(`product p`)}`);
//  ^? XqlError<"a where() fragment is in the SELECT position">
```

## Parameters are typed from what they are compared to

Parameters are named (`:name`) and passed as an object. Their types come from
the column on the other side of the comparison:

```ts
xql(`select id from product where id = :id`, { id: 7n });     // ok
xql(`select id from product where id = :id`, { id: "7" });    // Type error: string is not bigint
xql(`select id from product where id = :id`);                 // Type error: missing param
xql(`select id from product`, { id: 7n });                    // Type error: no params accepted
```

When the context can't be resolved (`lower(title) = :q`) the parameter falls
back to `SqlValue`. Repeated params bind once and reuse `$n`. Colons inside
`::casts` and `'string literals'` are never mistaken for parameters. A parameter
compared against more than one column takes its type from the first comparison,
so reusing one name across differently-typed columns is a type error rather than
a silent widening.

## Schema

```ts
const schema = defineSchema({
  product: {
    id: t.int8(),                 // bigint
    title: t.text(),              // string
    price: t.numeric().nullable(),// string | null
    created_at: t.timestamptz(),  // Date
  },
  variant: { id: t.int8(), product_id: t.int8(), sku: t.text().nullable() },
});

const xql = createXql(schema, adapter);
```

`adapter` is anything with `query(text, values) => Promise<unknown[]>`.

## Drivers disagree; codecs hide it

The same SQL type arrives in different JavaScript shapes depending on who
decoded it. For `int8` alone: node-postgres gives a **string**, Prisma gives a
**bigint**, and PGlite gives a **number** — switching to **bigint** only once the
value exceeds `Number.MAX_SAFE_INTEGER`.

Column codecs accept every one of those and normalise to a single declared
TypeScript type, so `id` is `bigint` no matter what is underneath. A number that
cannot round-trip exactly is rejected rather than silently truncated — the
precision was already gone before xql saw it.

| declared      | TypeScript | accepts                          |
| ------------- | ---------- | -------------------------------- |
| `int8`        | `bigint`   | bigint, safe number, digit string |
| `int4`/`float8` | `number` | number, numeric string           |
| `numeric`     | `string`   | string, number, bigint           |
| `timestamptz` | `Date`     | Date, ISO string, epoch number   |
| `bool`        | `boolean`  | boolean, `"t"`/`"f"`             |

This is covered by an integration suite that runs the real queries against real
Postgres (via PGlite), not a mock.

## CTEs

A `WITH` clause is resolved body-first: each CTE's SELECT is typed against the
schema built so far, and its output columns are registered as a table. From then
on the CTE behaves exactly like a real table — it joins, expands under `*`, and
participates in nullability:

```ts
const rows = await xql(
  `with cheap as (
     select id, title, price from product where price < :max
   )
   select c.title, v.sku
   from cheap c left join variant v on v.product_id = c.id`,
  { max: "10.00" },
);
//    ^? { title: string; sku: string | null }[]
```

Because each CTE is resolved before the next, a later CTE can build on an
earlier one, and a column the CTE does not expose is an error:

```ts
xql(`with recent as (select id from product) select r.title from recent r`);
//  ^? XqlError<'unknown column "title" on table "recent"'>
```

## Writes

`INSERT` / `UPDATE` / `DELETE` share the same machinery. `RETURNING` resolves
against the target table exactly like a `SELECT` list, and insert parameters are
typed by position against the column list:

```ts
const [created] = await xql(
  `insert into product (title, price) values (:title, :price) returning id, title`,
  { title: "shirt", price: "9.99" },
);
//     ^? { id: bigint; title: string }

await xql(`insert into product (title, price) values (:title, :price)`,
  { title: 1, price: "9.99" });          // Type error: title is text, not number
await xql(`insert into product (title, price) values (:title, :price)`,
  { title: null, price: null });         // Type error: title is NOT NULL
```

A `SET` assignment keeps the column's nullability — `set price = :price` accepts
`null` for a nullable column — while a `WHERE` comparison does not, since
`= NULL` is never true. Column names are checked on both sides — `insert into product (titel)` and
`update product set nope = 'x'` are compile errors, as is `returning p.id` when
`p` is not the target alias.

With no `RETURNING` there are no rows to type, so use `rowCount()`:

```ts
const n = await xql(`insert into product (title) values (:t) on conflict do nothing`,
  { t: "x" }).rowCount();
```

For that to be meaningful the adapter should return `{ rows, rowCount }` rather
than a bare array — drivers report affected rows separately from result rows.

## Errors

Mistakes surface at the call site with a readable message, and the same message
is thrown at query-construction time so tests catch it too:

```ts
xql(`select p.titl from product p`);
//  ^? XqlError<'unknown column "titl" on table "product"'>

xql(`select id from product p join variant v on v.product_id = p.id`);
//  ^? XqlError<'ambiguous column "id" — qualify it, it exists on more than one table in scope (p, v)'>

xql(`select z.id from product p`);
//  ^? XqlError<'unknown table alias "z" — in scope: p'>
```

An alias used in `WHERE` / `GROUP BY` / `HAVING` / `ORDER BY` must exist in the
FROM clause too — including when the clauses come from separate fragments:

```ts
xql(`select ${xql.cols(`p.id`)} from ${xql.from(`product p`)} where ${xql.where(`v.sku is null`)}`);
//  ^? XqlError<'unknown table alias "v" — in scope: p'>
```

Numeric literals (`p.price > 1.5`), schema-qualified function calls
(`public.my_func(x)`) and quoted strings are not mistaken for column references.

`LIMIT` / `OFFSET` must take a count — a non-negative integer, `ALL`, or a
parameter (typed as `number | bigint`, not an arbitrary value). `ORDER BY`
directions must be `asc` / `desc`, optionally followed by `nulls first` /
`nulls last`:

```ts
xql(`select id from product limit 'abc'`);
//  ^? XqlError<"LIMIT must be a number, ALL, or a parameter">

xql(`select id from product order by id ascending`);
//  ^? XqlError<'invalid ORDER BY direction in "id ascending" — use asc or desc, ...'>
```

An `ORDER BY` item containing an operator (`order by price + 1 desc`) is treated
as an expression and left alone.

`ORDER BY` columns are resolved the way Postgres resolves them — an ordinal, then
one of the query's own output names, then an unambiguous column from the FROM
scope:

```ts
xql(`select p.title as name from product p order by name`);        // ok — output name
xql(`select p.title from product p order by created_at desc`);     // ok — scope column
xql(`select p.title from product p order by 1`);                   // ok — ordinal
xql(`select p.title as name from product p order by nmae`);
//  ^? XqlError<'unknown ORDER BY column "nmae" — not a selected output name, and not a column on any table in scope (p)'>
xql(`select p.title from product p join variant v on v.product_id = p.id order by id`);
//  ^? XqlError<'ambiguous ORDER BY column "id" — qualify it, ...'>
```

Output names win over scope columns, so `select p.id ... order by id` is the
selected `id`, not an ambiguous reference — same as Postgres.

Because the error type replaces the `Query`, calling `.rows()` on it is itself
a compile error that quotes the reason.

## Expressions

- Columns, qualified (`p.id`) or bare (resolved across the scope, ambiguity rejected).
- `*` and `p.*`, expanded in declaration order with join nullability applied.
- Aliases: `expr as name`, or `p.id name`.
- Aggregates with derivable types: `count` → `bigint`, `sum`/`avg`/`min`/`max` →
  the argument's type, nullable, `coalesce` → the first argument, non-null.
- Anything else needs an explicit cast, which doubles as the escape hatch and is
  real SQL:

```ts
xql(`select jsonb_agg(v.sku)::jsonb as skus, my_udf(p.id)::text as x from ...`);
```

## Why `xql(\`...\`)` and not `` xql`...` ``

TypeScript types the first argument of a *tagged* template as
`TemplateStringsArray`, discarding the literal types — there is no workaround
(`const` type params, tuple constraints, and spread-tuple parameters all fail).
An *untagged* template passed to a `const T extends string` parameter does keep
its full literal type, including interpolated literal-typed values. So the
design costs exactly one pair of parentheses, and buys everything else.

## Known limits

- Subqueries in `FROM` are not parsed; the FROM clause is expected to be a
  table expression with joins.
- Bare (unqualified) column references in `WHERE`, `GROUP BY` and `HAVING` are
  not checked — only `alias.column` ones there. `ORDER BY` bare names are checked.
- Schema-qualified table references (`public.product`) are not resolved.
- Identifier case is preserved, but quoted identifiers containing SQL keywords
  or whitespace are not handled.
- `WITH RECURSIVE` is rejected — the body references the CTE being defined, so
  it cannot be resolved before that CTE exists.
- Column alias lists (`with t (a, b) as ...`) are rejected; name the columns in
  the CTE's own SELECT instead.
- Data-modifying CTEs (`with x as (insert ... returning ...)`) are not typed.
- Subqueries in `FROM` are not parsed. They are rejected, but the message talks
  about an unknown alias rather than naming the real cause.
- Subqueries in `WHERE` do work — `where id in (select ...)` is fine, because the
  tail is reference-checked rather than structurally parsed.
- `UPDATE ... FROM` extra tables are not added to the scope.

## Development

```bash
npm run typecheck   # type-level tests are assertions that must compile
npm test            # runtime + real-Postgres integration tests
npm run check       # both
```

Type-level tests live in `test/*.type.ts` — they pass by compiling. Runtime
tests in `test/runtime.test.ts` assert the Zod schema mirrors the types, and
`test/pg.test.ts` runs the same queries against a real Postgres instance.
# xql
