import { createXql } from "../src/xql.ts";
import { schema, xql } from "./fixture.ts";

declare global {
  namespace XqlGenerated {
    interface Queries {
      "select 1 as __compiled_n": {
        row: { __compiled_n: number };
        params: {};
      };
    }
  }
}

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
type Rows<Q> = Q extends { rows(): Promise<infer R> } ? R : never;

// SELECT-without-FROM is deliberately unsupported by the legacy type parser.
// The generated registry must bypass it entirely.
const compiledOnly = xql(`select 1 as __compiled_n`);
type _compiledBypass = Expect<Equal<Rows<typeof compiledOnly>, { __compiled_n: number }[]>>;

const strict = createXql(schema, { query: async () => [] }, { requireCompiled: true });
strict(`select 1 as __compiled_n`);
// @ts-expect-error strict compiler mode refuses strings absent from generated types
strict(`select id from product`);
