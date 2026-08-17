#!/usr/bin/env node
import { promises as fs } from "node:fs";
import path from "node:path";
import { diffCatalog, emitSchemaModule, pullCatalog } from "./catalog.ts";
import { compileProject } from "./project.ts";
import type { CatalogAdapter, CompilerCatalog } from "./types.ts";

function flag(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at === -1 ? undefined : args[at + 1];
}

function has(args: readonly string[], name: string): boolean {
  return args.includes(name);
}

async function loadPgAdapter(connectionString: string): Promise<{
  adapter: CatalogAdapter;
  close(): Promise<void>;
}> {
  const moduleName = "pg";
  let mod: Record<string, unknown>;
  try {
    mod = await import(moduleName) as Record<string, unknown>;
  } catch {
    throw new Error("`xql schema pull` needs node-postgres for catalog access. Install it with `npm i -D pg` or call pullCatalog() with your own adapter.");
  }
  const Client = (mod.Client ?? (mod.default as Record<string, unknown> | undefined)?.Client) as
    | (new (options: { connectionString: string }) => {
        connect(): Promise<void>;
        end(): Promise<void>;
        query(text: string, values?: readonly unknown[]): Promise<{ rows: unknown[] }>;
      })
    | undefined;
  if (Client === undefined) throw new Error("installed pg package does not export Client");
  const client = new Client({ connectionString });
  await client.connect();
  return {
    adapter: {
      async query<Row>(text: string, values?: readonly unknown[]) {
        const result = await client.query(text, values);
        return result.rows as Row[];
      },
    },
    close: () => client.end(),
  };
}

async function readCatalog(file: string): Promise<CompilerCatalog> {
  return JSON.parse(await fs.readFile(file, "utf8")) as CompilerCatalog;
}

async function schemaPull(args: readonly string[]): Promise<void> {
  const connection = flag(args, "--connection") ?? process.env.DATABASE_URL;
  if (!connection) throw new Error("schema pull requires --connection or DATABASE_URL");
  const schemas = (flag(args, "--schemas") ?? "public").split(",").map((x) => x.trim()).filter(Boolean);
  const catalogFile = path.resolve(flag(args, "--catalog") ?? ".xql/catalog.json");
  const schemaFile = flag(args, "--schema-out");
  const pg = await loadPgAdapter(connection);
  try {
    const catalog = await pullCatalog(pg.adapter, schemas);
    await fs.mkdir(path.dirname(catalogFile), { recursive: true });
    await fs.writeFile(catalogFile, JSON.stringify(catalog, null, 2) + "\n", "utf8");
    if (schemaFile) {
      const out = path.resolve(schemaFile);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, emitSchemaModule(catalog), "utf8");
    }
    console.log(`XQL catalog: ${catalogFile}`);
  } finally {
    await pg.close();
  }
}

async function schemaVerify(args: readonly string[]): Promise<void> {
  const connection = flag(args, "--connection") ?? process.env.DATABASE_URL;
  if (!connection) throw new Error("schema verify requires --connection or DATABASE_URL");
  const catalogFile = path.resolve(rootOrCwd(args), flag(args, "--catalog") ?? ".xql/catalog.json");
  const expected = await readCatalog(catalogFile);
  const pg = await loadPgAdapter(connection);
  try {
    const actual = await pullCatalog(pg.adapter, expected.searchPath);
    const diff = diffCatalog(expected, actual);
    if (!diff.equal) {
      console.error("XQL catalog drift detected.");
      if (diff.missingTables.length) console.error(`Missing tables: ${diff.missingTables.join(", ")}`);
      if (diff.extraTables.length) console.error(`Extra tables: ${diff.extraTables.join(", ")}`);
      if (diff.changedColumns.length) console.error(`Changed columns: ${diff.changedColumns.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    console.log("XQL catalog matches PostgreSQL.");
  } finally {
    await pg.close();
  }
}

function rootOrCwd(args: readonly string[]): string {
  return path.resolve(flag(args, "--root") ?? process.cwd());
}

async function compile(args: readonly string[]): Promise<void> {
  const root = rootOrCwd(args);
  const catalogFile = path.resolve(root, flag(args, "--catalog") ?? ".xql/catalog.json");
  const catalog = await readCatalog(catalogFile);
  const result = await compileProject({
    root,
    catalog,
    outFile: flag(args, "--out") ?? ".xql/generated.ts",
    ...(flag(args, "--runtime-out") ? { runtimeFile: flag(args, "--runtime-out")! } : {}),
    moduleName: flag(args, "--module") ?? "xql",
    compiledOnly: has(args, "--compiled-only"),
    cache: !has(args, "--no-cache"),
    emitTypes: !has(args, "--defer-types"),
    ...(flag(args, "--cache") ? { cacheFile: flag(args, "--cache")! } : {}),
  });
  for (const diagnostic of result.diagnostics) {
    const where = diagnostic.file ? `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}: ` : "";
    console.warn(`${where}${diagnostic.code}: ${diagnostic.message}`);
  }
  const stats = result.stats;
  const types = stats.typesUpdated ? "types refreshed" : has(args, "--defer-types") ? "types deferred" : "types reused";
  console.log(
    `XQL compiled ${stats.compiledQueries}, reused ${stats.cacheHits} cached, ${stats.uniqueQueries} unique; runtime ${stats.runtimeUpdated ? "updated" : "reused"}; ${types}`,
  );
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  if (command === "compile") return compile(args.slice(1));
  if (command === "schema" && args[1] === "pull") return schemaPull(args.slice(2));
  if (command === "schema" && args[1] === "verify") return schemaVerify(args.slice(2));
  console.error(`Usage:
  xql compile [--root .] [--catalog .xql/catalog.json] [--out .xql/generated.ts] [--runtime-out .xql/runtime.ts] [--cache .xql/cache.json] [--no-cache] [--compiled-only] [--defer-types]
  xql schema pull [--connection postgres://...] [--schemas public] [--catalog .xql/catalog.json] [--schema-out xql.schema.ts]
  xql schema verify [--connection postgres://...] [--catalog .xql/catalog.json]`);
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
