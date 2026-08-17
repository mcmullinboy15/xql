import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compileProject, type CompilerCatalog, type PostgresParser } from "../src/compiler/index.ts";

const S = (sval: string) => ({ String: { sval } });
const col = (...parts: string[]) => ({ ColumnRef: { fields: parts.map(S) } });
const target = (value: unknown) => ({ ResTarget: { val: value } });
const param = (number: number) => ({ ParamRef: { number } });
const range = (relname: string) => ({
  RangeVar: { relname, inh: true, relpersistence: "p" },
});
const eq = (left: unknown, right: unknown) => ({
  A_Expr: { kind: "AEXPR_OP", name: [S("=")], lexpr: left, rexpr: right },
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
        title: { name: "title", sqlType: "text", nullable: false },
      },
    },
  },
};

function selectAst() {
  return {
    stmt: {
      SelectStmt: {
        targetList: [target(col("id")), target(col("title"))],
        fromClause: [range("product")],
        whereClause: eq(col("id"), param(1)),
        limitOption: "LIMIT_OPTION_DEFAULT",
        op: "SETOP_NONE",
      },
    },
  };
}

test("compileProject persistently caches exact queries and invalidates on query/catalog changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "xql-compiler-cache-"));
  let parses = 0;
  const parser: PostgresParser = {
    async parse() {
      parses++;
      return { version: 180001, stmts: [selectAst()] };
    },
  };

  try {
    const file = path.join(root, "queries.ts");
    await fs.writeFile(
      file,
      `const q = xql("select id, title from product where id = :id", { id: 1n });\n`,
      "utf8",
    );

    const cold = await compileProject({ root, catalog, parser, compiledOnly: true });
    assert.equal(cold.stats.compiledQueries, 1);
    assert.equal(cold.stats.cacheHits, 0);
    assert.equal(parses, 1);

    const noChange = await compileProject({ root, catalog, parser, compiledOnly: true });
    assert.equal(noChange.stats.compiledQueries, 0);
    assert.equal(noChange.stats.cacheHits, 1);
    assert.equal(parses, 1);

    await fs.writeFile(
      file,
      `const q = xql("select id, title from product where id = :productId", { productId: 1n });\n`,
      "utf8",
    );
    const oneQueryEdit = await compileProject({ root, catalog, parser, compiledOnly: true });
    assert.equal(oneQueryEdit.stats.compiledQueries, 1);
    assert.equal(oneQueryEdit.stats.cacheHits, 0);
    assert.equal(oneQueryEdit.artifacts[0]?.params[0]?.name, "productId");
    assert.equal(parses, 2);

    await fs.appendFile(file, "// comment-only edit\n", "utf8");
    const fileOnlyEdit = await compileProject({ root, catalog, parser, compiledOnly: true });
    assert.equal(fileOnlyEdit.stats.compiledQueries, 0);
    assert.equal(fileOnlyEdit.stats.cacheHits, 1);
    assert.equal(parses, 2);

    const changedCatalog: CompilerCatalog = {
      ...catalog,
      tables: {
        ...catalog.tables,
        "public.product": {
          ...catalog.tables["public.product"]!,
          columns: {
            ...catalog.tables["public.product"]!.columns,
            title: { name: "title", sqlType: "varchar", nullable: false },
          },
        },
      },
    };
    const catalogEdit = await compileProject({
      root,
      catalog: changedCatalog,
      parser,
      compiledOnly: true,
    });
    assert.equal(catalogEdit.stats.compiledQueries, 1);
    assert.equal(catalogEdit.stats.cacheHits, 0);
    assert.equal(parses, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
