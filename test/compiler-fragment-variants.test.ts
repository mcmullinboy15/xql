import assert from "node:assert/strict";
import test from "node:test";
import { extractQueriesWithFragmentVariants } from "../src/compiler/fragment-variants.ts";

test("compiler enumerates both shapes of a runtime-boolean fragment", () => {
  const source = `
    const rand = Math.random() > 0.5;
    const q = xql(\`select p.id from \${xql.from(\`product p\`)} where \${xql.and(rand && xql.fragment(\`p.price > :e\`, { e: "10.00" }))}\`);
  `;

  const extracted = extractQueriesWithFragmentVariants(source, "example.ts");
  assert.deepEqual(extracted.diagnostics, []);
  assert.deepEqual(
    new Set(extracted.queries.map((query) => query.source)),
    new Set([
      "select p.id from «f:product p» where «w:true»",
      "select p.id from «f:product p» where «w:(p.price > :e)»",
    ]),
  );
});

test("compiler enumerates all combinations for independent fragment guards", () => {
  const source = `
    const cheap = Math.random() > 0.5;
    const titled = Math.random() > 0.5;
    xql(\`select p.id from \${xql.from(\`product p\`)} where \${xql.and(
      cheap && xql.fragment(\`p.price > :e\`, { e: "10.00" }),
      titled && xql.fragment(\`p.title = :title\`, { title: "shirt" })
    )}\`);
  `;

  const extracted = extractQueriesWithFragmentVariants(source, "example.ts");
  assert.deepEqual(extracted.diagnostics, []);
  assert.equal(new Set(extracted.queries.map((query) => query.source)).size, 4);
});

test("compiler still fails closed for unrelated dynamic interpolation", () => {
  const source = `
    const rand = Math.random() > 0.5;
    function run(runtime: string) {
      xql(\`select p.id from \${xql.from(\`product p\`)} where \${xql.and(rand && xql.fragment(\`p.price > :e\`, { e: "10.00" }))} and \${runtime}\`);
    }
  `;

  const extracted = extractQueriesWithFragmentVariants(source, "example.ts");
  assert.equal(extracted.queries.length, 0);
  assert.equal(extracted.diagnostics.length, 1);
  assert.equal(extracted.diagnostics[0]?.code, "XQL_DYNAMIC_SOURCE");
});
