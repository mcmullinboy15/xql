import { test, before } from "node:test";
import assert from "node:assert/strict";
import { PGlite } from "@electric-sql/pglite";
import { defineSchema, t } from "../src/schema.ts";
import { createXql, type Adapter } from "../src/xql.ts";

const schema = defineSchema({
  product: {
    id: t.int8(),
    title: t.text(),
    price: t.numeric().nullable(),
    stock: t.int4(),
    archived: t.bool(),
    created_at: t.timestamptz(),
  },
  variant: { id: t.int8(), product_id: t.int8(), sku: t.text().nullable() },
  supplier: { id: t.int8(), name: t.text() },
});

let db: PGlite;
let xql: ReturnType<typeof createXql<typeof schema>>;

before(async () => {
  db = await PGlite.create();
  await db.exec(`
    create table supplier (id bigint primary key, name text not null);
    create table product (
      id bigint primary key, title text not null, price numeric,
      stock int not null, archived boolean not null default false,
      created_at timestamptz not null default now(), supplier_id bigint
    );
    create table variant (id bigint primary key, product_id bigint not null, sku text);
    insert into supplier values (10, 'Acme');
    insert into product (id, title, price, stock, supplier_id) values
      (1, 'shirt', '19.99', 5, 10),
      (2, 'hat', null, 0, null),
      (3, 'sock', '2.50', 99, 10);
    insert into variant values (100, 1, 'SHIRT-S'), (101, 1, null);
  `);
  const adapter: Adapter = {
    query: async (text, values) => {
      const r = await db.query(text, values);
      // PGlite reports affected rows separately; surface it as rowCount so
      // writes with no RETURNING are still useful.
      return { rows: r.rows as unknown[], rowCount: r.affectedRows ?? r.rows.length };
    },
  };
  xql = createXql(schema, adapter);
});

test("decodes int8 to bigint even though the driver returns a number", async () => {
  const rows = await xql(`select id, title from product order by id`);
  assert.deepEqual(rows, [
    { id: 1n, title: "shirt" },
    { id: 2n, title: "hat" },
    { id: 3n, title: "sock" },
  ]);
  assert.equal(typeof rows[0]!.id, "bigint");
});

test("numeric stays a string, int4 a number, bool a boolean, timestamptz a Date", async () => {
  const rows = await xql(`select price, stock, archived, created_at from product where id = :id`, { id: 1n });
  const row = rows[0]!;
  assert.equal(row.price, "19.99");
  assert.equal(typeof row.stock, "number");
  assert.equal(row.archived, false);
  assert.ok(row.created_at instanceof Date);
});

test("nullable column really comes back null", async () => {
  const rows = await xql(`select price from product where id = :id`, { id: 2n });
  assert.equal(rows[0]!.price, null);
});

test("LEFT JOIN produces nulls that the widened schema accepts", async () => {
  const rows = await xql(
    `select ${xql.cols(`p.id, v.id as variant_id, v.sku`)}
     from ${xql.from(`product p left join variant v on v.product_id = p.id`)}
     where ${xql.where(`p.id = :id`)}
     order by v.id`,
    { id: 2n },
  );
  // product 2 has no variants -> one row with both variant columns null
  assert.deepEqual(rows, [{ id: 2n, variant_id: null, sku: null }]);
});

test("INNER JOIN keeps the joined side non-null", async () => {
  const rows = await xql(
    `select ${xql.cols(`p.title, v.sku`)}
     from ${xql.from(`product p join variant v on v.product_id = p.id`)}
     order by v.id`,
  );
  assert.deepEqual(rows, [
    { title: "shirt", sku: "SHIRT-S" },
    { title: "shirt", sku: null },
  ]);
});

test("LEFT JOIN onto a NOT NULL column widens it", async () => {
  const rows = await xql(
    `select ${xql.cols(`p.id, s.name`)}
     from ${xql.from(`product p left join supplier s on s.id = p.id`)}
     order by p.id`,
  );
  // supplier.name is NOT NULL, but no supplier matches -> null
  assert.deepEqual(rows.map((r) => r.name), [null, null, null]);
});

test("count(*) decodes to bigint", async () => {
  const rows = await xql(`select count(*) as n from product`);
  assert.deepEqual(rows, [{ n: 3n }]);
});

test("aggregates over a join", async () => {
  const rows = await xql(
    `select ${xql.cols(`p.title, count(v.id) as variants`)}
     from ${xql.from(`product p left join variant v on v.product_id = p.id`)}
     group by p.title order by p.title`,
  );
  assert.deepEqual(rows, [
    { title: "hat", variants: 0n },
    { title: "shirt", variants: 2n },
    { title: "sock", variants: 0n },
  ]);
});

test("params bind positionally and are reused", async () => {
  // :min appears twice -> bound once as $1 and referenced twice.
  const rows = await xql(
    `select id from product where stock >= :min and stock <= :max and stock <> :min order by id`,
    { min: 1, max: 100 },
  );
  assert.deepEqual(rows, [{ id: 1n }, { id: 3n }]);
});

test("star expands and validates every column", async () => {
  const rows = await xql(`select * from product where id = :id`, { id: 3n });
  assert.deepEqual(Object.keys(rows[0]!), ["id", "title", "price", "stock", "archived", "created_at"]);
  assert.equal(rows[0]!.id, 3n);
});

test("cast escape hatch round-trips through real SQL", async () => {
  const rows = await xql(`select id::text as sid, upper(title)::text as t from product where id = :id`, { id: 1n });
  assert.deepEqual(rows, [{ sid: "1", t: "SHIRT" }]);
});

test("ids beyond MAX_SAFE_INTEGER round-trip exactly", async () => {
  // PGlite hands back a number for in-range int8 and a bigint beyond it; the
  // codec normalises both to bigint, so callers never see the difference.
  await db.exec(`insert into product (id, title, stock) values (9007199254740993, 'huge', 0)`);
  const rows = await xql(`select id from product where title = :t`, { t: "huge" });
  assert.equal(rows[0]!.id, 9007199254740993n);
  await db.exec(`delete from product where title = 'huge'`);
});

// --- writes (run last so the SELECT tests above see a stable dataset) --------

test("insert ... returning gives typed rows and really writes", async () => {
  const rows = await xql(
    `insert into product (id, title, price, stock) values (:id, :title, :price, :stock)
     returning id, title, price`,
    { id: 50n, title: "new", price: "9.99", stock: 3 },
  );
  assert.deepEqual(rows, [{ id: 50n, title: "new", price: "9.99" }]);
  assert.deepEqual(await xql(`select title from product where id = :id`, { id: 50n }), [
    { title: "new" },
  ]);
});

test("insert without returning reports rowCount", async () => {
  const n = await xql(
    `insert into product (id, title, stock) values (:id, :title, :stock)`,
    { id: 51n, title: "counted", stock: 1 },
  ).rowCount();
  assert.equal(n, 1);
});

test("insert on conflict do nothing affects no rows", async () => {
  const n = await xql(
    `insert into product (id, title, stock) values (:id, :title, :stock)
     on conflict (id) do nothing`,
    { id: 50n, title: "dup", stock: 0 },
  ).rowCount();
  assert.equal(n, 0);
});

test("returning * validates every declared column", async () => {
  const rows = await xql(
    `insert into product (id, title, stock) values (:id, :title, :stock) returning *`,
    { id: 52n, title: "star", stock: 2 },
  );
  assert.equal(rows[0]!.id, 52n);
  assert.equal(rows[0]!.price, null);
  assert.ok(rows[0]!.created_at instanceof Date);
});

test("update ... returning", async () => {
  const rows = await xql(
    `update product set title = :title, price = :price where id = :id returning id, title, price`,
    { title: "renamed", price: null, id: 50n },
  );
  assert.deepEqual(rows, [{ id: 50n, title: "renamed", price: null }]);
});

test("update with an alias", async () => {
  const rows = await xql(
    `update product p set title = :t where p.id = :id returning p.title as name`,
    { t: "aliased", id: 50n },
  );
  assert.deepEqual(rows, [{ name: "aliased" }]);
});

test("delete ... returning", async () => {
  const rows = await xql(`delete from product where id = :id returning id, title`, { id: 51n });
  assert.deepEqual(rows, [{ id: 51n, title: "counted" }]);
  assert.equal(await xql(`select id from product where id = :id`, { id: 51n }).rowCount(), 0);
});

test("write errors throw at construction with the same message as the type", () => {
  assert.throws(() => (xql as any)(`insert into product (titel) values ('x')`),
    (e: Error) => e.message === 'unknown column "titel" on table "product"');
  assert.throws(() => (xql as any)(`update product set nope = 'x'`),
    (e: Error) => e.message === 'unknown column "nope" on table "product"');
  assert.throws(() => (xql as any)(`insert into nosuch (a) values (1)`),
    (e: Error) => e.message === 'unknown table "nosuch"');
  assert.throws(() => (xql as any)(`delete from product returning p.id`),
    (e: Error) => /unknown table alias "p"/.test(e.message));
});

// --- CTEs against real Postgres ---------------------------------------------

test("CTE resolves as a table and actually executes", async () => {
  const rows = await xql(
    `with cheap as (
       select id, title, price from product where id <= :maxId
     )
     select c.title, c.price from cheap c order by c.title`,
    { maxId: 3n },
  );
  assert.deepEqual(rows, [
    { title: "hat", price: null },
    { title: "shirt", price: "19.99" },
    { title: "sock", price: "2.50" },
  ]);
});

test("CTE joins a real table, with LEFT JOIN nullability", async () => {
  const rows = await xql(
    `with p as (select id, title from product where id <= :maxId)
     select p.title, v.sku
     from p left join variant v on v.product_id = p.id
     order by p.title, v.id`,
    { maxId: 2n },
  );
  assert.deepEqual(rows, [
    { title: "hat", sku: null },
    { title: "shirt", sku: "SHIRT-S" },
    { title: "shirt", sku: null },
  ]);
});

test("a later CTE can build on an earlier one", async () => {
  const rows = await xql(
    `with a as (select id, title, price from product where price is not null),
          b as (select title from a)
     select b.title from b order by b.title`,
  );
  assert.deepEqual(rows.map((r) => r.title), ["shirt", "sock"]);
});

test("aggregate inside a CTE keeps its decoded type", async () => {
  const rows = await xql(
    `with counts as (select count(*) as n from product where id <= :maxId)
     select c.n from counts c`,
    { maxId: 3n },
  );
  assert.equal(rows[0]!.n, 3n);
  assert.equal(typeof rows[0]!.n, "bigint");
});

test("select * over a CTE expands to the CTE's columns only", async () => {
  const rows = await xql(
    `with slim as (select id, price from product where id = :id) select * from slim`,
    { id: 1n },
  );
  assert.deepEqual(Object.keys(rows[0]!), ["id", "price"]);
  assert.deepEqual(rows, [{ id: 1n, price: "19.99" }]);
});
