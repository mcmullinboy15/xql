import { defineSchema, t } from "../src/schema.ts";
import { createXql, type Adapter } from "../src/xql.ts";

const adapter: Adapter = { query: async () => [] };

const big = defineSchema({
  product: { id: t.int8(), title: t.text(), sku: t.text(), price: t.numeric().nullable(), supplier_id: t.int8().nullable(), created_at: t.timestamptz(), updated_at: t.timestamptz(), archived: t.bool(), account_id: t.int8(), upc: t.text().nullable() },
  variant: { id: t.int8(), product_id: t.int8(), sku: t.text().nullable(), option1: t.text().nullable(), option2: t.text().nullable(), barcode: t.text().nullable() },
  supplier: { id: t.int8(), name: t.text(), lead_time_days: t.int4().nullable(), currency: t.text() },
  inventory_level: { id: t.int8(), variant_id: t.int8(), location_id: t.int8(), on_hand: t.int4(), incoming: t.int4(), reserved: t.int4() },
  location: { id: t.int8(), name: t.text(), code: t.text().nullable() },
});
const x = createXql(big, adapter);

// 5 tables, mixed join kinds, 14 output columns, aggregates, casts, params
const q = x(
  `select ${x.cols(`
      p.id, p.title, p.sku as product_sku, p.price,
      v.id as variant_id, v.sku as variant_sku, v.barcode,
      s.name as supplier_name, s.lead_time_days,
      l.name as location_name, l.code,
      sum(il.on_hand)::int4 as on_hand,
      count(*) as rows_,
      max(p.updated_at) as last_update
   `)}
   from ${x.from(`
      product p
      join variant v on v.product_id = p.id
      left join supplier s on s.id = p.supplier_id
      left join inventory_level il on il.variant_id = v.id
      left join location l on l.id = il.location_id
   `)}
   where ${x.where(`p.account_id = :accountId and p.archived = :archived and s.name ilike :q`)}
   group by p.id, v.id, s.id, l.id
   order by p.updated_at desc
   limit 50`,
  { accountId: 1n, archived: false, q: "%acme%" },
);

type Rows<Q> = Q extends { rows(): Promise<infer R> } ? R : never;
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type _ = Expect<Equal<Rows<typeof q>, {
  id: bigint;
  title: string;
  product_sku: string;
  price: string | null;
  variant_id: bigint;
  variant_sku: string | null;
  barcode: string | null;
  supplier_name: string | null;   // LEFT JOIN supplier
  lead_time_days: number | null;
  location_name: string | null;   // LEFT JOIN location
  code: string | null;
  on_hand: number;
  rows_: bigint;
  last_update: Date | null;
}[]>>;

// The same query behind a CTE. The CTE layer adds a whole extra parse pass, and
// this combination previously exhausted TypeScript's instantiation budget and
// degraded to a bogus XqlError — see the tail-recursion note in type/string.ts.
const withCte = x(
  `with asdf as (
    select * from product where account_id = :accountId1
  )
  select
    p.id, p.title, p.sku as product_sku, p.price,
    v.id as variant_id, v.sku as variant_sku, v.barcode,
    s.name as supplier_name, s.lead_time_days,
    l.name as location_name, l.code,
    sum(il.on_hand)::int4 as on_hand,
    count(*) as rows_,
    max(p.updated_at) as last_update
  from
    product p
    join variant v on v.product_id = p.id
    left join supplier s on s.id = p.supplier_id
    left join inventory_level il on il.variant_id = v.id
    left join location l on l.id = il.location_id
  where p.account_id = :accountId and p.archived = :archived and s.name ilike :q
  group by p.id, v.id, s.id, l.id
  order by p.updated_at desc
  limit 50`,
  { accountId: 1n, accountId1: 1n, archived: false, q: "%acme%" },
);

type _cte = Expect<Equal<Rows<typeof withCte>, {
  id: bigint;
  title: string;
  product_sku: string;
  price: string | null;
  variant_id: bigint;
  variant_sku: string | null;
  barcode: string | null;
  supplier_name: string | null;
  lead_time_days: number | null;
  location_name: string | null;
  code: string | null;
  on_hand: number;
  rows_: bigint;
  last_update: Date | null;
}[]>>;

// Headroom guard: two CTEs, 22 output columns, five joins.
const twoCtes = x(
  `with a as (select * from product where account_id = :a1),
        b as (select id, name from supplier where name ilike :b1)
  select
    p.id, p.title, p.sku as product_sku, p.price, p.upc, p.created_at, p.archived,
    v.id as variant_id, v.sku as variant_sku, v.barcode, v.option1, v.option2,
    s.name as supplier_name, s.lead_time_days, s.currency,
    l.name as location_name, l.code, l.id as location_id,
    sum(il.on_hand)::int4 as on_hand, sum(il.incoming)::int4 as incoming,
    count(*) as rows_, max(p.updated_at) as last_update
  from product p
    join variant v on v.product_id = p.id
    left join supplier s on s.id = p.supplier_id
    left join inventory_level il on il.variant_id = v.id
    left join location l on l.id = il.location_id
  where p.account_id = :accountId and p.archived = :archived and p.upc is not null
  group by p.id, v.id, s.id, l.id
  order by p.updated_at desc, p.title asc
  limit 50`,
  { a1: 1n, b1: "x", accountId: 1n, archived: false },
);
type TwoCteRow = Rows<typeof twoCtes>[number];
type _h1 = Expect<Equal<TwoCteRow["supplier_name"], string | null>>;
type _h2 = Expect<Equal<TwoCteRow["on_hand"], number>>;
type _h3 = Expect<Equal<TwoCteRow["rows_"], bigint>>;
type _h4 = Expect<Equal<TwoCteRow["archived"], boolean>>;
