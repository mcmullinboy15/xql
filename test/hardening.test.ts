import assert from "node:assert/strict";
import test from "node:test";
import { bindNamedParams, rewriteNamedParams } from "../src/runtime/bind.ts";
import {
  createXql,
  defineSchema,
  t,
  type Adapter,
  type CompiledManifest,
  type QueryEvent,
} from "../src/index.ts";

const schema = defineSchema({
  product: {
    id: t.int8(),
    title: t.text(),
    quantity: t.int4(),
  },
  variant: {
    id: t.int8(),
    product_id: t.int8(),
    sku: t.text().nullable(),
  },
});

test("named parameter rewriting changes only parameter tokens", () => {
  const sql = `select
  ':not_a_param' as literal,
  $$:also_not$$ as dollar,
  $tag$:still_not$tag$ as tagged,
  "odd:name" as quoted,
  id::text as casted
from product
-- :commented
where id = :id
  and title = :title
  and id = :id
  /* :nested /* :still_comment */ comment */`;

  const rewritten = rewriteNamedParams(sql);
  assert.deepEqual(rewritten.names, ["id", "title"]);
  assert.equal(
    rewritten.text,
    sql.replace("id = :id", "id = $1")
      .replace("title = :title", "title = $2")
      .replace("id = :id", "id = $1"),
  );

  assert.deepEqual(bindNamedParams(sql, { id: 7n, title: "hello" }).values, [7n, "hello"]);
});

test("XQL preserves whitespace inside SQL string literals and formatting", () => {
  let executed = "";
  const adapter: Adapter = {
    async query(text) {
      executed = text;
      return [];
    },
  };
  const xql = createXql(schema, adapter);
  const source = `select id, title
from product
where title = 'Foo   Bar'` as const;
  const query = xql(source);

  assert.equal(query.toSql().text, source);
  return query.rows().then(() => assert.equal(executed, source));
});

test("JOIN ON references are validated before the adapter runs", () => {
  let calls = 0;
  const adapter: Adapter = {
    async query() {
      calls++;
      return [];
    },
  };
  const xql = createXql(schema, adapter);

  assert.throws(
    () => xql(`select p.id from product p join variant v on v.producct_id = p.id`),
    /unknown column "producct_id".*JOIN expression/,
  );
  assert.equal(calls, 0);
});

test("SUM(int4) normalises the PostgreSQL int8 result to bigint", async () => {
  const adapter: Adapter = {
    async query() {
      return [{ total: "42" }];
    },
  };
  const xql = createXql(schema, adapter);
  const rows = await xql(`select sum(quantity) as total from product`);
  assert.deepEqual(rows, [{ total: 42n }]);
});

test("AVG(int4) keeps PostgreSQL numeric as an exact string", async () => {
  const adapter: Adapter = {
    async query() {
      return [{ average: "2.5000000000000000" }];
    },
  };
  const xql = createXql(schema, adapter);
  const rows = await xql(`select avg(quantity) as average from product`);
  assert.deepEqual(rows, [{ average: "2.5000000000000000" }]);
});

test("prepared schemas are cached by exact query source", () => {
  const adapter: Adapter = { query: async () => [] };
  const xql = createXql(schema, adapter);
  const source = `select id, title from product` as const;
  assert.equal(xql(source).rowSchema, xql(source).rowSchema);
});

test("compiled manifests bypass the legacy parser and validate rows", async () => {
  const source = `select 1::int4 as x`;
  const manifest: CompiledManifest = {
    version: 1,
    queries: {
      [source]: {
        source,
        sql: source,
        kind: "select",
        columns: [{ name: "x", sqlType: "int4", nullable: false }],
        params: [],
      },
    },
  };
  const adapter: Adapter = { query: async () => [{ x: "7" }] };
  const compiled = createXql(schema, adapter, { manifest, compiledOnly: true });
  const query = (compiled as unknown as (sql: string) => {
    rows(): Promise<Array<{ x: number }>>;
  })(source);
  assert.deepEqual(await query.rows(), [{ x: 7 }]);
});

test("compiledOnly refuses queries missing from the manifest", () => {
  const adapter: Adapter = { query: async () => [] };
  const xql = createXql(schema, adapter, {
    manifest: { version: 1, queries: {} },
    compiledOnly: true,
  });
  assert.throws(
    () => (xql as unknown as (sql: string) => unknown)(`select id from product`),
    /not present in the XQL compiler manifest/,
  );
});

test("observability, streaming, and transactions are adapter capabilities", async () => {
  const events: QueryEvent[] = [];
  let transactionCalls = 0;
  const makeAdapter = (): Adapter => ({
    async query() {
      return [{ id: "1", title: "a" }];
    },
    async *stream() {
      yield { id: "1", title: "a" };
      yield { id: "2", title: "b" };
    },
    async transaction(run) {
      transactionCalls++;
      return run(makeAdapter());
    },
  });
  const xql = createXql(schema, makeAdapter(), { onQuery: (event) => events.push(event) });
  const query = xql(`select id, title from product`);

  assert.deepEqual(await query.rows({ name: "products.list" }), [{ id: 1n, title: "a" }]);
  const streamed: unknown[] = [];
  for await (const row of query.stream()) streamed.push(row);
  assert.deepEqual(streamed, [{ id: 1n, title: "a" }, { id: 2n, title: "b" }]);

  await xql.transaction(async (tx) => {
    assert.deepEqual(await tx(`select id, title from product`).first(), { id: 1n, title: "a" });
  });
  assert.equal(transactionCalls, 1);
  assert.equal(events.filter((event) => event.phase === "start").length, 2);
  assert.equal(events.filter((event) => event.phase === "success").length, 2);
});
