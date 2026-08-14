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
