import { defineSchema, t } from "../src/schema.ts";
import { createXql, type Adapter } from "../src/xql.ts";
import type { ParamsOfQuery, RowOfQuery } from "../src/type/query.ts";
import type { XqlError } from "../src/type/select.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const schema = defineSchema({
  asset: { id: t.int8(), digest: t.bytes(), label: t.text(), thumb: t.bytes().nullable() },
});
type S = typeof schema;
const adapter: Adapter = { query: async () => [] };
const xql = createXql(schema, adapter);

// a bytes column decodes to Uint8Array, and stays nullable when declared so
type _1 = Expect<Equal<
  RowOfQuery<S, "select id, digest, thumb from asset">,
  { id: bigint; digest: Uint8Array; thumb: Uint8Array | null }
>>;

// an explicit array cast on a parameter types it as an array, not the element
type _2 = Expect<Equal<
  ParamsOfQuery<S, "select id from asset where digest = any (:digests::bytes[])">,
  { digests: Uint8Array[] }
>>;
// ...while a scalar cast stays scalar
type _3 = Expect<Equal<
  ParamsOfQuery<S, "select id from asset where digest = :digest::bytes">,
  { digest: Uint8Array }
>>;
// a cast on the parameter wins over the comparison context, which would give
// the element type and be wrong for `= any (...)`
type _4 = Expect<Equal<
  ParamsOfQuery<S, "select id from asset where id = any (:ids::int8[])">,
  { ids: bigint[] }
>>;
// no cast still resolves from context
type _5 = Expect<Equal<
  ParamsOfQuery<S, "select id from asset where label = :label">,
  { label: string }
>>;

// array casts in the select list too
type _6 = Expect<Equal<
  RowOfQuery<S, "select array_agg(a.label)::text[] as labels from asset a">,
  { labels: string[] }
>>;
type _7 = Expect<Equal<
  RowOfQuery<S, "select a.digest::bytea as d from asset a">,
  { d: Uint8Array }
>>;
// an unknown element type is still rejected
type _8 = Expect<Equal<
  RowOfQuery<S, "select a.label::nope[] as x from asset a">,
  XqlError<'unknown cast type "nope[]"'>
>>;

const q = xql(
  `select ${xql.cols(`a.id, a.digest`)} from ${xql.from(`asset a`)} where ${xql.where(`a.digest = any (:digests::bytes[])`)}`,
  { digests: [new Uint8Array([1, 2])] },
);
type _9 = Expect<Equal<
  typeof q extends { rows(): Promise<infer R> } ? R : never,
  { id: bigint; digest: Uint8Array }[]
>>;
