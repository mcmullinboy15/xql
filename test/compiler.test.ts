import assert from "node:assert/strict";
import test from "node:test";
import {
  analyzePostgresStatement,
  compileQuery,
  diffCatalog,
  emitGeneratedModule,
  emitRuntimeManifestModule,
  extractQueriesFromSource,
  type CompilerCatalog,
  type PostgresParser,
  XqlCompilerError,
} from "../src/compiler/index.ts";

const S = (sval: string) => ({ String: { sval } });
const col = (...parts: string[]) => ({
  ColumnRef: { fields: parts.map(S) },
});
const target = (value: unknown, name?: string) => ({
  ResTarget: { ...(name ? { name } : {}), val: value },
});
const range = (relname: string, alias?: string) => ({
  RangeVar: {
    relname,
    inh: true,
    relpersistence: "p",
    ...(alias ? { alias: { Alias: { aliasname: alias } } } : {}),
  },
});
const param = (number: number) => ({ ParamRef: { number } });
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
        quantity: { name: "quantity", sqlType: "int4", nullable: false },
      },
    },
    "public.variant": {
      schema: "public",
      name: "variant",
      columns: {
        id: { name: "id", sqlType: "int8", nullable: false },
        product_id: { name: "product_id", sqlType: "int8", nullable: false },
        sku: { name: "sku", sqlType: "text", nullable: true },
      },
    },
  },
};

function selectAst() {
  return {
    stmt: {
      SelectStmt: {
        targetList: [
          target(col("p", "id")),
          target({
            FuncCall: {
              funcname: [S("sum")],
              args: [col("p", "quantity")],
            },
          }, "total"),
        ],
        fromClause: [range("product", "p")],
        whereClause: eq(col("p", "id"), param(1)),
        limitOption: "LIMIT_OPTION_DEFAULT",
        op: "SETOP_NONE",
      },
    },
  };
}

test("compileQuery uses PostgreSQL AST semantics for output and parameters", async () => {
  let parsedSql = "";
  const parser: PostgresParser = {
    async parse(sql) {
      parsedSql = sql;
      return { version: 180001, stmts: [selectAst()] };
    },
  };
  const source = `select p.id, sum(p.quantity) as total from product p where p.id = :id`;
  const artifact = await compileQuery(source, catalog, parser);

  assert.equal(parsedSql, `select p.id, sum(p.quantity) as total from product p where p.id = $1`);
  assert.equal(artifact.sql, source);
  assert.equal(artifact.kind, "select");
  assert.deepEqual(artifact.columns, [
    { name: "id", sqlType: "int8", nullable: false },
    { name: "total", sqlType: "int8", nullable: true },
  ]);
  assert.deepEqual(artifact.params, [
    { name: "id", sqlType: "int8", nullable: false },
  ]);
  assert.equal(artifact.postgresVersion, 180001);
});

test("compiler rejects a bad column in JOIN ON", () => {
  const ast = {
    stmt: {
      SelectStmt: {
        targetList: [target(col("p", "id"))],
        fromClause: [{
          JoinExpr: {
            jointype: "JOIN_INNER",
            larg: range("product", "p"),
            rarg: range("variant", "v"),
            quals: eq(col("v", "producct_id"), col("p", "id")),
          },
        }],
        limitOption: "LIMIT_OPTION_DEFAULT",
        op: "SETOP_NONE",
      },
    },
  };

  assert.throws(
    () => analyzePostgresStatement(ast, catalog),
    (error) => error instanceof XqlCompilerError &&
      error.diagnostic.code === "XQL_UNKNOWN_COLUMN" &&
      /producct_id/.test(error.message),
  );
});

test("LEFT JOIN applies relation nullability to compiled output", () => {
  const ast = {
    stmt: {
      SelectStmt: {
        targetList: [target(col("p", "id")), target(col("v", "product_id"))],
        fromClause: [{
          JoinExpr: {
            jointype: "JOIN_LEFT",
            larg: range("product", "p"),
            rarg: range("variant", "v"),
            quals: eq(col("v", "product_id"), col("p", "id")),
          },
        }],
        limitOption: "LIMIT_OPTION_DEFAULT",
        op: "SETOP_NONE",
      },
    },
  };
  const analyzed = analyzePostgresStatement(ast, catalog);
  assert.deepEqual(analyzed.columns, [
    { name: "id", sqlType: "int8", nullable: false },
    { name: "product_id", sqlType: "int8", nullable: true },
  ]);
});

test("compiler extraction resolves reusable static XQL fragments", () => {
  const source = `
    const from = xql.from(\`product p left join variant v on v.product_id = p.id\`);
    const cols = xql.cols(\`p.id, v.sku\`);
    const where = xql.where(\`p.id = :id\`);
    const query = xql(\`select \${cols} from \${from} where \${where}\`, { id: 1n });
  `;
  const extracted = extractQueriesFromSource(source, "example.ts");
  assert.equal(extracted.diagnostics.length, 0);
  assert.deepEqual(extracted.queries.map((query) => query.source), [
    "select «c:p.id, v.sku» from «f:product p left join variant v on v.product_id = p.id» where «w:p.id = :id»",
  ]);
});

test("dynamic source is diagnosed instead of pretending it was compiled", () => {
  const extracted = extractQueriesFromSource(
    `const query = xql(\`select id from product where title = '\${runtime}'\`);`,
    "dynamic.ts",
  );
  assert.equal(extracted.queries.length, 0);
  assert.equal(extracted.diagnostics[0]?.code, "XQL_DYNAMIC_SOURCE");
});

test("generated types and runtime manifest form a one-way dependency", () => {
  const artifacts = [{
    source: "select id from product where id = :id",
    sql: "select id from product where id = :id",
    kind: "select" as const,
    columns: [{ name: "id", sqlType: "int8", nullable: false }],
    params: [{ name: "id", sqlType: "int8", nullable: false }],
  }];
  const typesModule = emitGeneratedModule(artifacts);
  const runtimeModule = emitRuntimeManifestModule(artifacts);
  assert.match(typesModule, /interface GeneratedQueryRegistry/);
  assert.match(typesModule, /GeneratedQueryInfo<\{ "id": bigint; \}, \{ "id": bigint; \}>/);
  assert.doesNotMatch(typesModule, /runtime\.js/);
  assert.doesNotMatch(typesModule, /export const manifest/);
  assert.match(runtimeModule, /import type "\.\/generated\.js"/);
  assert.match(runtimeModule, /export const manifest/);
  assert.match(runtimeModule, /CompiledManifest/);
});

test("catalog diff identifies database drift", () => {
  const changed: CompilerCatalog = {
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
  const diff = diffCatalog(catalog, changed);
  assert.equal(diff.equal, false);
  assert.deepEqual(diff.changedColumns, ["public.product.title"]);
});
