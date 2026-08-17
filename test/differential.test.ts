import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { createXql, defineSchema, t, type Adapter } from "../src/index.ts";

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

let db: PGlite;
let xql: ReturnType<typeof createXql<typeof schema>>;

before(async () => {
  db = await PGlite.create();
  await db.exec(`
    create table product (
      id bigint primary key,
      title text not null,
      quantity int not null
    );
    create table variant (
      id bigint primary key,
      product_id bigint not null references product(id),
      sku text
    );
    insert into product values (1, 'shirt', 4), (2, 'hat', 2);
    insert into variant values (10, 1, 'S'), (11, 1, null);
  `);
  const adapter: Adapter = {
    async query(text, values) {
      const result = await db.query(text, values);
      return { rows: result.rows as unknown[], rowCount: result.affectedRows ?? result.rows.length };
    },
  };
  xql = createXql(schema, adapter);
});

after(async () => {
  await db.close();
});

interface Case {
  readonly name: string;
  readonly sql: string;
  readonly valid: boolean;
}

function corpus(seedCount: number): Case[] {
  const cases: Case[] = [];
  for (let i = 0; i < seedCount; i++) {
    const gap = " ".repeat((i % 5) + 1);
    const newline = i % 2 === 0 ? "\n" : " ";
    const suffix = `/* differential case ${i} */`;
    const base =
      `select p.id, v.sku${newline}` +
      `from product p${gap}left join variant v on v.product_id = p.id${newline}` +
      `where p.id >= 0 and p.title <> 'literal   :${i}'${newline}` +
      `order by p.id ${suffix}`;
    cases.push({ name: `valid-${i}`, sql: base, valid: true });
    cases.push({
      name: `bad-join-column-${i}`,
      sql: base.replace("v.product_id = p.id", `v.product_id_missing_${i} = p.id`),
      valid: false,
    });
    cases.push({
      name: `bad-where-column-${i}`,
      sql: base.replace("p.id >= 0", `p.id_missing_${i} >= 0`),
      valid: false,
    });
    cases.push({
      name: `bad-alias-${i}`,
      sql: base.replace("p.title <>", "z.title <>"),
      valid: false,
    });
  }
  return cases;
}

async function postgresAccepts(sql: string): Promise<boolean> {
  try {
    await db.query(`explain ${sql}`);
    return true;
  } catch {
    return false;
  }
}

function xqlAccepts(sql: string): boolean {
  try {
    (xql as unknown as (query: string) => unknown)(sql);
    return true;
  } catch {
    return false;
  }
}

test("XQL runtime acceptance agrees with PostgreSQL across generated references", async () => {
  const requested = Number(process.env.XQL_DIFFERENTIAL_SEEDS ?? "250");
  const seedCount = Number.isSafeInteger(requested) && requested > 0 ? requested : 250;
  const mismatches: Array<{
    name: string;
    expected: boolean;
    postgres: boolean;
    xql: boolean;
    sql: string;
  }> = [];

  for (const item of corpus(seedCount)) {
    const [postgres, xqlResult] = await Promise.all([
      postgresAccepts(item.sql),
      Promise.resolve(xqlAccepts(item.sql)),
    ]);
    if (postgres !== item.valid || xqlResult !== item.valid || postgres !== xqlResult) {
      mismatches.push({
        name: item.name,
        expected: item.valid,
        postgres,
        xql: xqlResult,
        sql: item.sql,
      });
      if (mismatches.length >= 10) break;
    }
  }

  assert.deepEqual(mismatches, []);
});
