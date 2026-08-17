import { createXql, defineSchema, t } from "../src/index.ts";
import type { GeneratedQueryInfo } from "../src/type/generated.ts";

declare module "../src/type/generated.ts" {
  interface GeneratedQueryRegistry {
    "select 1::int4 as one": GeneratedQueryInfo<{ one: number }, {}>;
    "select :id::int8 as id": GeneratedQueryInfo<{ id: bigint }, { id: bigint }>;
  }
}

const schema = defineSchema({ product: { id: t.int8() } });
const xql = createXql(schema, { query: async () => [] });

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type Rows<Q> = Q extends { rows(): Promise<infer R> } ? R : never;

// The legacy type parser rejects SELECT without FROM. A generated registry entry
// succeeds, proving the generated branch resolves before RowOfQuery is instantiated.
const constant = xql(`select 1::int4 as one`);
type _constant = Expect<Equal<Rows<typeof constant>, Array<{ one: number }>>>;

const param = xql(`select :id::int8 as id`, { id: 1n });
type _param = Expect<Equal<Rows<typeof param>, Array<{ id: bigint }>>>;

// @ts-expect-error — generated params are concrete; no type-level SQL parsing needed
xql(`select :id::int8 as id`, { id: "1" });
