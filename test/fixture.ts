import { defineSchema, t } from "../src/schema.ts";
import { createXql, type Adapter } from "../src/xql.ts";

export const schema = defineSchema({
  product: {
    id: t.int8(),
    title: t.text(),
    price: t.numeric().nullable(),
    created_at: t.timestamptz(),
  },
  variant: {
    id: t.int8(),
    product_id: t.int8(),
    sku: t.text().nullable(),
  },
  supplier: {
    id: t.int8(),
    name: t.text(),
  },
});

export function fakeAdapter(rows: unknown[] = []) {
  const calls: { text: string; values: unknown[] }[] = [];
  const adapter: Adapter = {
    query: async (text, values) => {
      calls.push({ text, values });
      return rows;
    },
  };
  return { adapter, calls };
}

export const { adapter } = fakeAdapter();
export const xql = createXql(schema, adapter);
