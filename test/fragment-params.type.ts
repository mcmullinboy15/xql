import { xql } from "./fixture.ts";
import type { XqlError } from "../src/type/select.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false;
type Expect<T extends true> = T;
type Rows<Q> = Q extends { rows(): Promise<infer R> } ? R : Q;

declare const rand: boolean;

const cols = xql.cols(`p.id`);
const product = xql.from(`product p`);

// A runtime boolean owns its params atomically: when the branch exists, `e`
// travels with it; when it does not, neither SQL nor `e` exists.
const runtimeConditional = xql(
  `select ${cols}
   from ${product}
   where ${xql.and(
     true && `p.title is not null`,
     rand && xql.fragment(`p.price > :e`, { e: "10.00" }),
     false && `p.title like 'A%'`,
   )}`,
);
type _runtimeRows = Expect<Equal<
  Rows<typeof runtimeConditional>,
  { id: bigint }[]
>>;

// Literal true contributes SQL + params, but the outer query takes no `e`.
const always = xql(
  `select ${cols} from ${product} where ${xql.and(
    true && xql.fragment(`p.price > :e`, { e: "10.00" }),
  )}`,
);
type _alwaysRows = Expect<Equal<Rows<typeof always>, { id: bigint }[]>>;

// @ts-expect-error — fragment-owned `e` must not also be passed outside.
xql(
  `select ${cols} from ${product} where ${xql.and(
    true && xql.fragment(`p.price > :e`, { e: "10.00" }),
  )}`,
  { e: "10.00" },
);

// Literal false contributes neither SQL nor params.
const never = xql(
  `select ${cols} from ${product} where ${xql.and(
    false && xql.fragment(`p.price > :e`, { e: "10.00" }),
  )}`,
);
type _neverRows = Expect<Equal<Rows<typeof never>, { id: bigint }[]>>;

// Ordinary outer params and fragment-owned params compose.
const mixed = xql(
  `select ${cols} from ${product} where ${xql.and(
    `p.id = :id`,
    rand && xql.fragment(`p.price > :e`, { e: "10.00" }),
  )}`,
  { id: 1n },
);
type _mixedRows = Expect<Equal<Rows<typeof mixed>, { id: bigint }[]>>;

// The final query scope still validates the value supplied by the fragment.
const wrongValue = xql(
  `select ${cols} from ${product} where ${xql.and(
    xql.fragment(`p.price > :e`, { e: 10 }),
  )}`,
);
type _wrongValue = Expect<Equal<
  typeof wrongValue,
  XqlError<"xql.fragment parameter :e does not match the SQL parameter type">
>>;

// Fragment params are exact: no missing or unrelated keys.
// @ts-expect-error — missing e
xql.fragment(`p.price > :e`, {});

// @ts-expect-error — extra key is not present in SQL
xql.fragment(`p.price > :e`, { e: "10.00", extra: 1 });

// Repeated use of one name inside the same fragment is fine: it owns one value.
xql.fragment(`p.price > :e and p.price < :e`, { e: "10.00" });

// Two independently-owned active fragments may not claim the same parameter.
const duplicate = xql(
  `select ${cols} from ${product} where ${xql.and(
    xql.fragment(`p.price > :e`, { e: "10.00" }),
    xql.fragment(`p.price < :e`, { e: "20.00" }),
  )}`,
);
type _duplicate = Expect<Equal<
  typeof duplicate,
  XqlError<"duplicate fragment-owned parameter :e">
>>;
