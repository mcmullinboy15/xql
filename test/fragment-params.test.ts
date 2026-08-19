import assert from "node:assert/strict";
import test from "node:test";
import { createXql } from "../src/xql.ts";
import { fakeAdapter, schema } from "./fixture.ts";

test("runtime boolean includes fragment SQL and its params together", () => {
  const { adapter } = fakeAdapter();
  const xql = createXql(schema, adapter);
  const rand: boolean = true;

  const query = xql(
    `select p.id from product p where ${xql.and(
      rand && xql.fragment(`p.price > :e`, { e: "10.00" }),
    )}`,
  );

  assert.deepEqual(query.toSql(), {
    text: "select p.id from product p where (p.price > $1)",
    values: ["10.00"],
  });
});

test("runtime false boolean excludes fragment SQL and params together", () => {
  const { adapter } = fakeAdapter();
  const xql = createXql(schema, adapter);
  const rand: boolean = false;

  const query = xql(
    `select p.id from product p where ${xql.and(
      rand && xql.fragment(`p.price > :e`, { e: "10.00" }),
    )}`,
  );

  assert.deepEqual(query.toSql(), {
    text: "select p.id from product p where true",
    values: [],
  });
});

test("outer params and active fragment params bind in SQL order", () => {
  const { adapter } = fakeAdapter();
  const xql = createXql(schema, adapter);

  const query = xql(
    `select p.id from product p where ${xql.and(
      `p.id = :id`,
      xql.fragment(`p.price > :e`, { e: "10.00" }),
    )}`,
    { id: 7n },
  );

  assert.deepEqual(query.toSql(), {
    text: "select p.id from product p where (p.id = $1) and (p.price > $2)",
    values: [7n, "10.00"],
  });
});

test("duplicate ownership is rejected before binding", () => {
  const { adapter } = fakeAdapter();
  const xql = createXql(schema, adapter);

  assert.throws(
    () => xql(
      `select p.id from product p where ${xql.and(
        xql.fragment(`p.price > :e`, { e: "10.00" }),
        xql.fragment(`p.price < :e`, { e: "20.00" }),
      )}`,
    ),
    /duplicate value for parameter :e/,
  );
});

test("fragment params must exactly match the fragment SQL at runtime", () => {
  const { adapter } = fakeAdapter();
  const xql = createXql(schema, adapter);

  assert.throws(
    () => xql.fragment(`p.price > :e`, {} as never),
    /missing value for fragment parameter :e/,
  );
  assert.throws(
    () => xql.fragment(
      `p.price > :e`,
      { e: "10.00", extra: 1 } as never,
    ),
    /fragment parameter :extra is not present in the fragment SQL/,
  );
});

test("parameter-owning predicate results fail clearly if reused", () => {
  const { adapter } = fakeAdapter();
  const xql = createXql(schema, adapter);
  const predicate = xql.and(
    xql.fragment(`p.price > :e`, { e: "10.00" }),
  );

  xql(`select p.id from product p where ${predicate}`).toSql();
  assert.throws(
    () => xql(`select p.id from product p where ${predicate}`),
    /parameter-owning xql\.and\(\)\/xql\.or\(\) results are single-use/,
  );
});
