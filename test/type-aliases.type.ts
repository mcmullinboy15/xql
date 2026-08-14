import { defineSchema, t } from "../src/schema.ts";
import type { RowOfQuery } from "../src/type/query.ts";
import type { XqlError } from "../src/type/select.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

const schema = defineSchema({ thing: { id: t.int8(), label: t.text() } });
type S = typeof schema;

// CockroachDB spells text as `string`, which is by far the most common cast in
// a CRDB codebase.
type _1 = Expect<Equal<RowOfQuery<S, "select id::string as s from thing">, { s: string }>>;
type _2 = Expect<Equal<RowOfQuery<S, "select id::string[] as s from thing">, { s: string[] }>>;

// the rest of the CockroachDB spellings resolve to the same types as their
// Postgres equivalents
type _3 = Expect<Equal<RowOfQuery<S, "select id::int2 as a from thing">, { a: number }>>;
type _4 = Expect<Equal<RowOfQuery<S, "select id::float4 as a from thing">, { a: number }>>;
type _5 = Expect<Equal<RowOfQuery<S, "select id::bigserial as a from thing">, { a: bigint }>>;
type _6 = Expect<Equal<RowOfQuery<S, "select id::serial4 as a from thing">, { a: number }>>;
type _7 = Expect<Equal<RowOfQuery<S, "select id::oid as a from thing">, { a: number }>>;
type _8 = Expect<Equal<RowOfQuery<S, "select label::name as a from thing">, { a: string }>>;
type _9 = Expect<Equal<RowOfQuery<S, "select label::inet as a from thing">, { a: string }>>;
type _10 = Expect<Equal<RowOfQuery<S, "select label::time as a from thing">, { a: string }>>;
type _11 = Expect<Equal<RowOfQuery<S, "select label::interval as a from thing">, { a: string }>>;
type _12 = Expect<Equal<RowOfQuery<S, "select label::bpchar as a from thing">, { a: string }>>;

// an unknown type is still rejected rather than silently accepted
type _13 = Expect<Equal<
  RowOfQuery<S, "select id::nosuchtype as a from thing">,
  XqlError<'unknown cast type "nosuchtype"'>
>>;
