import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { extractQueriesWithFragmentVariants } from "../src/compiler/fragment-variants.ts";
import { compileProject } from "../src/compiler/project.ts";
import type { CompilerCatalog, PostgresParser } from "../src/compiler/types.ts";

const S = (sval: string) => ({ String: { sval } });
const col = (...parts: string[]) => ({ ColumnRef: { fields: parts.map(S) } });
const target = (value: unknown) => ({ ResTarget: { val: value } });
const param = (number: number) => ({ ParamRef: { number } });
const range = (relname: string, alias: string) => ({
  RangeVar: {
    relname,
    inh: true,
    relpersistence: "p",
    alias: { Alias: { aliasname: alias } },
  },
});
const op = (name: string, left: unknown, right: unknown) => ({
  A_Expr: { kind: "AEXPR_OP", name: [S(name)], lexpr: left, rexpr: right },
});

const catalog: CompilerCatalog = {
  version: 1,
  searchPath: ["public"],
  tables: {
    "public.product": {
      schema: "public",
      name: "product",
      columns: {
        id: { name: "id", sqlType: "int8", nullable: false },
        price: { name: "price", sqlType: "numeric", nullable: true },
      },
    },
  },
};

function selectAst(withParam: boolean) {
  return {
    stmt: {
      SelectStmt: {
        targetList: [target(col("p", "id"))],
        fromClause: [range("product", "p")],
        whereClause: withParam
          ? op(">", col("p", "price"), param(1))
          : { A_Const: { val: { Boolean: { boolval: true } } } },
        limitOption: "LIMIT_OPTION_DEFAULT",
        op: "SETOP_NONE",
      },
    },
  };
}

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

test("compiledOnly project emits both runtime boolean query variants", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xql-fragment-variants-"));
  const parser: PostgresParser = {
    async parse(sql) {
      return {
        version: 180001,
        stmts: [selectAst(sql.includes("$1"))],
      };
    },
  };

  try {
    await fs.writeFile(
      path.join(root, "query.ts"),
      `const rand = Math.random() > 0.5;\n` +
      `xql(\`select p.id from \${xql.from(\`product p\`)} where \${xql.and(rand && xql.fragment(\`p.price > :e\`, { e: "10.00" }))}\`);\n`,
      "utf8",
    );

    const result = await compileProject({
      root,
      catalog,
      parser,
      compiledOnly: true,
    });

    assert.equal(result.diagnostics.length, 0);
    assert.equal(result.artifacts.length, 2);

    const byParams = [...result.artifacts].sort((a, b) => a.params.length - b.params.length);
    assert.equal(byParams[0]!.params.length, 0);
    assert.deepEqual(byParams[1]!.params, [
      { name: "e", sqlType: "numeric", nullable: false },
    ]);

    const generated = await fs.readFile(result.outFile, "utf8");
    assert.match(generated, /where «w:true»/);
    assert.match(generated, /where «w:\(p\.price > :e\)»/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
