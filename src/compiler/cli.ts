#!/usr/bin/env node
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SchemaDef } from "../schema.ts";
import { catalogFingerprint, generateCatalogJson, generateSchemaModule } from "./generate.ts";
import { createPgliteCompilerDatabase, snapshotCatalog } from "./postgres.ts";
import { extractXqlQueries } from "./source.ts";
import { compileProject, generateProjectArtifacts } from "./project.ts";
import type { CatalogSnapshot, CompilerDatabase } from "./types.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

async function sourceFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (["node_modules", "dist", ".git", ".xql"].includes(entry.name)) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (/\.[cm]?tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

async function loadSchema(modulePath: string): Promise<SchemaDef> {
  const url = pathToFileURL(path.resolve(modulePath)).href;
  const loaded = await import(url) as { schema?: SchemaDef; default?: SchemaDef };
  const schema = loaded.schema ?? loaded.default;
  if (!schema) throw new Error(`${modulePath} must export \`schema\` or a default SchemaDef`);
  return schema;
}

async function loadCompilerDatabase(modulePath: string): Promise<CompilerDatabase> {
  const url = pathToFileURL(path.resolve(modulePath)).href;
  const loaded = await import(url) as {
    database?: CompilerDatabase;
    default?: CompilerDatabase | (() => CompilerDatabase | Promise<CompilerDatabase>);
  };
  const candidate = loaded.database ?? loaded.default;
  const database = typeof candidate === "function" ? await candidate() : candidate;
  if (!database?.describeQuery || !database?.query)
    throw new Error(`${modulePath} must export a CompilerDatabase as \`database\` or default`);
  return database;
}

async function openDatabase(): Promise<{ database: CompilerDatabase; schema?: SchemaDef; owned: boolean }> {
  const databaseModule = arg("--database-module");
  if (databaseModule)
    return { database: await loadCompilerDatabase(databaseModule), owned: false };

  const ddlPath = arg("--ddl");
  const schemaPath = arg("--schema");
  if (!ddlPath && !schemaPath) {
    throw new Error(
      "provide --database-module <module>, --ddl <schema.sql>, or --schema <schema-module>",
    );
  }
  const schema = schemaPath ? await loadSchema(schemaPath) : undefined;
  const ddl = ddlPath ? await readFile(path.resolve(ddlPath), "utf8") : undefined;
  return {
    database: await createPgliteCompilerDatabase({ ddl, schema }),
    schema,
    owned: true,
  };
}

async function closeDatabase(database: CompilerDatabase, owned: boolean) {
  if (owned) await database.close?.();
}

async function compileCommand() {
  const src = path.resolve(arg("--src") ?? "src");
  const out = path.resolve(arg("--out") ?? ".xql");
  const moduleName = arg("--module") ?? "xql";
  const opened = await openDatabase();
  try {
    const queries = [];
    const diagnostics = [];
    for (const file of await sourceFiles(src)) {
      const extracted = extractXqlQueries(await readFile(file, "utf8"), file);
      queries.push(...extracted.queries);
      diagnostics.push(...extracted.diagnostics);
    }

    const project = await compileProject({
      database: opened.database,
      sources: queries,
      diagnostics,
      compiler: {
        schema: opened.schema,
        nullability: has("--legacy-nullability") ? "legacy" : "conservative",
      },
    });
    const artifacts = generateProjectArtifacts(project, moduleName);
    await mkdir(out, { recursive: true });
    await writeFile(path.join(out, "types.d.ts"), artifacts.types);
    await writeFile(path.join(out, "manifest.ts"), artifacts.manifestModule);
    await writeFile(path.join(out, "schema.ts"), artifacts.schemaModule);
    await writeFile(path.join(out, "catalog.json"), artifacts.catalogJson);
    await writeFile(path.join(out, "catalog.sha256"), `${artifacts.catalogFingerprint}\n`);

    console.log(`xql: compiled ${project.queries.length} unique queries against PostgreSQL ${project.postgresVersion}`);
    if (project.diagnostics.length > 0) {
      console.log(`xql: ${project.diagnostics.length} dynamic queries kept on the type-level fallback`);
      for (const diagnostic of project.diagnostics)
        console.log(`  ${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`);
    }
    console.log(`xql: wrote ${path.relative(process.cwd(), out) || out}`);
  } finally {
    await closeDatabase(opened.database, opened.owned);
  }
}

async function schemaPullCommand() {
  const out = path.resolve(arg("--out") ?? "xql.schema.ts");
  const catalogOut = path.resolve(arg("--catalog") ?? ".xql/catalog.json");
  const moduleName = arg("--module") ?? "xql";
  const opened = await openDatabase();
  try {
    const catalog = await snapshotCatalog(opened.database);
    await mkdir(path.dirname(out), { recursive: true });
    await mkdir(path.dirname(catalogOut), { recursive: true });
    await writeFile(out, generateSchemaModule(catalog, moduleName));
    await writeFile(catalogOut, generateCatalogJson(catalog));
    await writeFile(`${catalogOut}.sha256`, `${catalogFingerprint(catalog)}\n`);
    console.log(`xql: pulled PostgreSQL catalog into ${path.relative(process.cwd(), out) || out}`);
  } finally {
    await closeDatabase(opened.database, opened.owned);
  }
}

async function schemaCheckCommand() {
  const snapshotPath = path.resolve(arg("--catalog") ?? ".xql/catalog.json");
  const expected = JSON.parse(await readFile(snapshotPath, "utf8")) as CatalogSnapshot;
  const opened = await openDatabase();
  try {
    const actual = await snapshotCatalog(opened.database);
    const expectedFingerprint = catalogFingerprint(expected);
    const actualFingerprint = catalogFingerprint(actual);
    if (expectedFingerprint !== actualFingerprint) {
      throw new Error(
        `PostgreSQL catalog drift detected: expected ${expectedFingerprint}, got ${actualFingerprint}; ` +
          "run `xql schema pull` and commit the generated changes",
      );
    }
    console.log(`xql: catalog matches ${path.relative(process.cwd(), snapshotPath) || snapshotPath}`);
  } finally {
    await closeDatabase(opened.database, opened.owned);
  }
}

async function main() {
  const [command = "compile", subcommand] = process.argv.slice(2);
  if (command === "compile") return compileCommand();
  if (command === "schema" && subcommand === "pull") return schemaPullCommand();
  if (command === "schema" && subcommand === "check") return schemaCheckCommand();
  throw new Error(
    "usage: xql compile [...] | xql schema pull [...] | xql schema check [...]",
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exitCode = 1;
});
