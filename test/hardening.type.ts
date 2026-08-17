import { createXql, defineSchema, t } from "../src/index.ts";
import type { XqlError } from "../src/type/select.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type Rows<Q> = Q extends { rows(): Promise<infer R> } ? R : never;

const schema = defineSchema({
  product: {
    id: t.int8(),
    title: t.text(),
    quantity: t.int4(),
  },
  variant: {
    id: t.int8(),
    product_id: t.int8(),
  },
});
const xql = createXql(schema, { query: async () => [] });

const sum = xql(`select sum(quantity) as total from product`);
type _sum = Expect<Equal<Rows<typeof sum>, Array<{ total: bigint | null }>>>;

const avg = xql(`select avg(quantity) as average from product`);
type _avg = Expect<Equal<Rows<typeof avg>, Array<{ average: string | null }>>>;

// An explicit cast does not make a nullable aggregate non-null.
const castSum = xql(`select sum(quantity)::int4 as total from product`);
type _castSum = Expect<Equal<Rows<typeof castSum>, Array<{ total: number | null }>>>;

const badJoin = xql(
  `select p.id from product p join variant v on v.producct_id = p.id`,
);
type _join = Expect<Equal<
  typeof badJoin,
  XqlError<'unknown column "producct_id" on table "variant" in JOIN expression'>
>>;

// Unknown parameter context is no longer silently widened to SqlValue.
// @ts-expect-error — :q needs an explicit type context/cast
xql(`select id from product where lower(title) = :q`, { q: "shirt" });

// The SQL cast is the explicit escape hatch and supplies the parameter type.
xql(`select id from product where lower(title) = :q::text`, { q: "shirt" });
// @ts-expect-error — :q::text is string, not number
xql(`select id from product where lower(title) = :q::text`, { q: 123 });
