import { test } from "node:test";
import assert from "node:assert/strict";
import { createXql } from "../src/xql.ts";
import { XqlError } from "../src/runtime/parse.ts";
import { schema, fakeAdapter } from "./fixture.ts";

const mk = (rows: unknown[] = []) => {
  const { adapter, calls } = fakeAdapter(rows);
  return { xql: createXql(schema, adapter), calls };
};

test("emits SQL with positional params, reusing repeats", () => {
  const { xql } = mk();
  const q = xql(`select id from product where id = :id or id = :id and title = :t`, { id: 5n, t: "x" });
  const { text, values } = q.toSql();
  assert.equal(text, "select id from product where id = $1 or id = $1 and title = $2");
  assert.deepEqual(values, [5n, "x"]);
});

test("strips fragment markers from emitted SQL", () => {
  const { xql } = mk();
  const q = xql(`select ${xql.cols(`p.id`)} from ${xql.from(`product p`)} where ${xql.where(`p.id = :id`)}`, { id: 1n });
  assert.equal(q.toSql().text, "select p.id from product p where p.id = $1");
});

test("does not mistake ::casts for params", () => {
  const { xql } = mk();
  const q = xql(`select id::text as sid from product where title = :t`, { t: "a" });
  assert.equal(q.toSql().text, "select id::text as sid from product where title = $1");
  assert.deepEqual(q.toSql().values, ["a"]);
});

test("does not bind inside string literals", () => {
  const { xql } = mk();
  const q = xql(`select id from product where title = ':notaparam' or title = :t`, { t: "a" });
  assert.equal(q.toSql().text, "select id from product where title = ':notaparam' or title = $1");
  assert.deepEqual(q.toSql().values, ["a"]);
});

test("row schema column order matches the select list", () => {
  const { xql } = mk();
  const q = xql(`select ${xql.cols(`p.title, p.id, v.sku`)} from ${xql.from(`product p left join variant v on v.product_id = p.id`)}`);
  assert.deepEqual(Object.keys((q.rowSchema as any).shape), ["title", "id", "sku"]);
});

test("star expands to every column in declaration order", () => {
  const { xql } = mk();
  const q = xql(`select * from product`);
  assert.deepEqual(Object.keys((q.rowSchema as any).shape), ["id", "title", "price", "created_at"]);
});

test("parses and validates rows", async () => {
  const { xql } = mk([{ id: 1n, title: "shirt" }]);
  const rows = await xql(`select id, title from product`);
  assert.deepEqual(rows, [{ id: 1n, title: "shirt" }]);
});

test("rejects rows that do not match the schema", async () => {
  const { xql } = mk([{ id: "not-a-bigint", title: "shirt" }]);
  await assert.rejects(() => xql(`select id, title from product`).rows());
});

test("LEFT JOIN makes the right side nullable at runtime too", async () => {
  const { xql } = mk([{ id: 1n, product_id: null, sku: null }]);
  // variant.product_id is a NOT NULL int8, but the LEFT JOIN can produce null.
  const rows = await xql(
    `select ${xql.cols(`p.id, v.product_id, v.sku`)} from ${xql.from(`product p left join variant v on v.product_id = p.id`)}`,
  );
  assert.deepEqual(rows, [{ id: 1n, product_id: null, sku: null }]);
});

test("INNER JOIN keeps the right side non-null at runtime", async () => {
  const { xql } = mk([{ id: 1n, product_id: null }]);
  await assert.rejects(
    () => xql(`select ${xql.cols(`p.id, v.product_id`)} from ${xql.from(`product p join variant v on v.product_id = p.id`)}`).rows(),
    /invalid|expected/i,
  );
});

test("unknown column throws at construction, with the same message as the type", () => {
  const { xql } = mk();
  assert.throws(() => xql(`select p.titl from product p`), (e: Error) =>
    e instanceof XqlError && e.message === 'unknown column "titl" on table "product"');
});

test("ambiguous unqualified column throws", () => {
  const { xql } = mk();
  assert.throws(() => xql(`select id from product p join variant v on v.product_id = p.id`), (e: Error) =>
    e instanceof XqlError && /^ambiguous column "id"/.test(e.message));
});

test("fragment role misuse throws", () => {
  const { xql } = mk();
  assert.throws(() => (xql as any)(`select ${xql.where(`p.id = 1`)} from ${xql.from(`product p`)}`), (e: Error) =>
    e instanceof XqlError && e.message === "a where() fragment is in the SELECT position");
});

test("bad column reference in WHERE throws", () => {
  const { xql } = mk();
  assert.throws(() => (xql as any)(`select p.id from product p where p.nope = 1`), (e: Error) =>
    e instanceof XqlError && e.message === 'unknown column "nope" on table "product"');
});

test("missing param value throws", () => {
  const { xql } = mk();
  assert.throws(() => (xql as any)(`select id from product where id = :id`, {}), (e: Error) =>
    e instanceof XqlError && e.message === "missing value for parameter :id");
});

test("one() requires exactly one row", async () => {
  const { xql } = mk([]);
  await assert.rejects(() => xql(`select id from product`).one(), /expected exactly 1 row, got 0/);
});

test("first() returns null on empty", async () => {
  const { xql } = mk([]);
  assert.equal(await xql(`select id from product`).first(), null);
});

test("aggregates: count is bigint, max is nullable", async () => {
  const { xql } = mk([{ n: 3n, hi: null }]);
  const rows = await xql(`select count(*) as n, max(p.price) as hi from product p`);
  assert.deepEqual(rows, [{ n: 3n, hi: null }]);
});

test("RIGHT JOIN nullifies the prior side", () => {
  const { xql } = mk();
  const q = (xql as any)(`select p.title, v.sku from product p right join variant v on v.product_id = p.id`);
  assert.equal(q.rowSchema.shape.title.safeParse(null).success, true);
  assert.equal(q.rowSchema.shape.sku.safeParse(null).success, true);
});

test("runtime rejects bad refs in ORDER BY and GROUP BY, matching the type level", () => {
  const { xql } = mk();
  for (const q of [
    `select p.id from product p order by p.nope desc`,
    `select p.title, count(*) as n from product p group by p.titl`,
    `select p.id from product p left join variant v on v.product_id = p.id where v.skuu is null`,
  ]) {
    assert.throws(() => (xql as any)(q), (e: Error) => e instanceof XqlError && /^unknown column/.test(e.message), q);
  }
});

test("runtime does not false-positive on casts, decimals, or string literals", () => {
  const { xql } = mk();
  const q = (xql as any)(
    `select p.id from product p where p.id::text = '1.5' and p.price > 1.5 and p.title = 'a.b'`,
  );
  assert.equal(q.toSql().text, "select p.id from product p where p.id::text = '1.5' and p.price > 1.5 and p.title = 'a.b'");
});

test("runtime rejects an alias used outside SELECT that was never joined", () => {
  const { xql } = mk();
  for (const q of [
    `select p.id from product p where z.id = 1`,
    `select p.id from product p order by z.created_at`,
    `select p.id from product p group by z.title`,
    `select p.title, count(*) as n from product p group by p.title having count(v.id) > 1`,
  ]) {
    assert.throws(() => (xql as any)(q), (e: Error) =>
      e instanceof XqlError && /^unknown table alias/.test(e.message), q);
  }
});

test("runtime accepts an alias that is joined, in every tail clause", () => {
  const { xql } = mk();
  assert.doesNotThrow(() => (xql as any)(
    `select p.id from product p left join variant v on v.product_id = p.id
     where v.sku is null group by p.id, v.id order by v.sku`));
});

test("runtime does not false-positive on numeric literals or qualified calls", () => {
  const { xql } = mk();
  assert.doesNotThrow(() => (xql as any)(
    `select p.id from product p where p.price > 1.5 and public.my_func(p.id) = 1 and p.title = 'a.b'`));
});

test("int8 codec accepts number, string and bigint, and rejects lossy numbers", async () => {
  const cases: [unknown, bigint | null][] = [
    [7n, 7n],                                  // Prisma-style
    [7, 7n],                                   // PGlite-style
    ["7", 7n],                                 // node-postgres-style
    ["9007199254740993", 9007199254740993n],   // beyond safe range, as text
    [9007199254740993, null],                  // lossy number -> must reject
    [1.5, null],
    ["abc", null],
  ];
  for (const [input, want] of cases) {
    const { xql } = mk([{ id: input }]);
    const q = xql(`select id from product`);
    if (want === null) {
      await assert.rejects(() => q.rows(), `expected ${String(input)} to be rejected`);
    } else {
      assert.deepEqual(await q.rows(), [{ id: want }], `input ${String(input)}`);
    }
  }
});

test("CTE columns come from the body, in every formatting style", () => {
  const { xql } = mk();
  for (const q of [
    `with recent as (select id, title from product) select r.id, r.title from recent r`,
    `with recent as ( select id, title from product ) select r.id, r.title from recent r`,
    `WITH recent AS (\n  select id, title from product\n)\nselect r.id, r.title from recent r`,
  ]) {
    const shape = Object.keys(((xql as any)(q)).rowSchema.shape);
    assert.deepEqual(shape, ["id", "title"], q);
  }
});

test("CTE emits the full original SQL, WITH clause included", () => {
  const { xql } = mk();
  const q = (xql as any)(`with recent as (select id from product) select r.id from recent r`);
  assert.equal(q.toSql().text, "with recent as (select id from product) select r.id from recent r");
});

test("CTE errors and unsupported forms", () => {
  const { xql } = mk();
  const cases: [string, RegExp][] = [
    [`with recent as (select id from product) select r.title from recent r`, /^unknown column "title" on table "recent"/],
    [`with recent as (select nope from product) select r.nope from recent r`, /^unknown column "nope"/],
    [`with recursive t as (select id from product) select t.id from t`, /^WITH RECURSIVE is not supported/],
    [`with t (a) as (select id from product) select t.a from t`, /^column alias lists on a CTE/],
  ];
  for (const [q, re] of cases) {
    assert.throws(() => (xql as any)(q), (e: Error) => e instanceof XqlError && re.test(e.message), q);
  }
});

test("LIMIT and OFFSET must take a count", () => {
  const { xql } = mk();
  for (const q of [
    `select id from product limit 'abc'`,
    `select id from product limit -5`,
    `select id from product offset x`,
  ]) {
    assert.throws(() => (xql as any)(q), (e: Error) =>
      e instanceof XqlError && /must be a number, ALL, or a parameter$/.test(e.message), q);
  }
  assert.doesNotThrow(() => (xql as any)(`select id from product limit all offset 5`));
  assert.doesNotThrow(() => (xql as any)(`select id from product limit :n`, { n: 10 }));
});

test("ORDER BY direction must be asc or desc", () => {
  const { xql } = mk();
  for (const q of [
    `select id from product order by id ascending`,
    `select id from product order by title desc, id descx`,
    `select id from product order by id nulls sideways`,
    `select id from product order by id asc desc`,
    `select id from product order by id nulls`,
    `select id from product order by id first`,
  ]) {
    assert.throws(() => (xql as any)(q), (e: Error) =>
      e instanceof XqlError && /^invalid ORDER BY direction/.test(e.message), q);
  }
});

test("ORDER BY accepts every valid direction form, and leaves expressions alone", () => {
  const { xql } = mk();
  for (const q of [
    `select id from product order by id`,
    `select id from product order by id desc`,
    `select id from product order by id asc nulls last`,
    `select id from product order by id ASC`,
    `select id from product order by id DESC`,
    `select id from product order by id Desc`,
    `select id from product order by id desc NULLS FIRST`,
    `select id from product order by title, id desc limit 10`,
    `select id from product order by price + 1 desc`,
    `select id from product where title = 'a limit b'`,
  ]) {
    assert.doesNotThrow(() => (xql as any)(q), q);
  }
});

test("ORDER BY resolves output names, then scope columns, then rejects", () => {
  const { xql } = mk();
  for (const q of [
    `select p.title as name from product p order by name`,
    `select count(*) as n from product p group by p.title order by n desc`,
    `select p.title from product p order by created_at desc`,
    `select p.title from product p order by 1`,
    `select p.title from product p order by p.created_at desc`,
    `select p.id from product p join variant v on v.product_id = p.id order by id`,
    `select p.title from product p order by price + 1 desc`,
  ]) {
    assert.doesNotThrow(() => (xql as any)(q), q);
  }
  assert.throws(
    () => (xql as any)(`select p.title from product p order by nonexistent`),
    (e: Error) => e instanceof XqlError && /^unknown ORDER BY column "nonexistent"/.test(e.message),
  );
  assert.throws(
    () => (xql as any)(`select p.title as name from product p order by nmae desc`),
    (e: Error) => e instanceof XqlError && /^unknown ORDER BY column "nmae"/.test(e.message),
  );
  assert.throws(
    () => (xql as any)(`select p.title from product p join variant v on v.product_id = p.id order by id`),
    (e: Error) => e instanceof XqlError && /^ambiguous ORDER BY column "id"/.test(e.message),
  );
});

test("bare column refs in the tail resolve, without false-positiving on SQL syntax", () => {
  const { xql } = mk();
  for (const q of [
    `select id from product where title = :t`,
    `select id from product where price is null`,
    `select id from product where price is not null`,
    `select id from product where id in (1, 2, 3)`,
    `select id from product where id between 1 and 5`,
    `select id from product where lower(title) = :q`,
    `select id from product where id::text = :t`,
    `select id from product where created_at > current_timestamp`,
    `select id from product where created_at > now() - interval '1 day'`,
    `select id from product where title like '%x%' escape '!'`,
    `select id from product where case when id = 1 then true else false end`,
    `select id from product where not price is null`,
    `select id from product where id = any(array[1,2])`,
    `select id from product where title = 'a = b'`,
    `select id from product where cast(id as text) = :t`,
    `select title as name, count(*) as n from product group by name`,
    `select title as name from product order by name`,
  ]) {
    assert.doesNotThrow(() => (xql as any)(q, { t: "x", q: "x", s: "x" }), q);
  }
});

test("unknown and ambiguous bare column refs are rejected", () => {
  const { xql } = mk();
  const cases: [string, RegExp][] = [
    [`select id from product where account_id = 1`, /^unknown column "account_id"/],
    [`select id from product where nope > 5`, /^unknown column "nope"/],
    [`select id from product where 5 < nope`, /^unknown column "nope"/],
    // an output name does not rescue an ambiguous ref in WHERE
    [`select p.id from product p join variant v on v.product_id = p.id where id = 1`, /^ambiguous column "id"/],
    [`with cheap as (select id from product where account_id < 5) select c.id from cheap c`, /^unknown column "account_id"/],
  ];
  for (const [q, re] of cases) {
    assert.throws(() => (xql as any)(q), (e: Error) => e instanceof XqlError && re.test(e.message), q);
  }
});

test("multiple CTEs: chained, independent, joined, and shadowing", () => {
  const { xql } = mk();
  const cases: [string, string[]][] = [
    [`with a as (select id, title from product), b as (select product_id, sku from variant) select a.title, b.sku from a join b on b.product_id = a.id`, ["title", "sku"]],
    [`with a as (select id, title from product), b as (select id, title from a), c as (select title from b) select c.title from c`, ["title"]],
    [`with a as (select id from product), b as (select sku from variant) select a.id, b.sku from a, b`, ["id", "sku"]],
    [`with product as (select id from product) select product.id from product`, ["id"]],
  ];
  for (const [q, expected] of cases) {
    assert.deepEqual(Object.keys(((xql as any)(q)).rowSchema.shape), expected, q);
  }
});

test("multiple CTEs: errors point at the right body", () => {
  const { xql } = mk();
  const cases: [string, RegExp][] = [
    [`with a as (select id from product), b as (select nope from a) select b.nope from b`, /^unknown column "nope" — not on any table in scope \(a\)/],
    [`with a as (select id from b), b as (select id from product) select a.id from a`, /^unknown column "id" — not on any table in scope \(b\)/],
    [`with a as (select id, title from product), b as (select id from a) select b.title from b`, /^unknown column "title" on table "b"/],
  ];
  for (const [q, re] of cases) {
    assert.throws(() => (xql as any)(q), (e: Error) => e instanceof XqlError && re.test(e.message), q);
  }
});

test("a dangling comma after a CTE is reported as a malformed WITH clause", () => {
  const { xql } = mk();
  const cte = `with asdf as (\n  select id from product where id = :a\n  )`;
  const body = `\n  select p.title from product p where p.id = :b`;
  assert.throws(
    () => (xql as any)(`${cte},${body}`, { a: 1n, b: 1n }),
    (e: Error) => e instanceof XqlError && e.message === 'malformed WITH clause near "select"',
  );
  // the same query without the comma is fine
  assert.doesNotThrow(() => (xql as any)(`${cte}${body}`, { a: 1n, b: 1n }));
});
