import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { compileProject } from "../src/compiler/project.ts";
import type { CompilerCatalog } from "../src/compiler/types.ts";

const DEFAULT_COUNTS = [25_000] as const;
const CHUNK_SIZE = 250;

interface TypeDiagnostics {
  wallMs: number;
  exitCode: number | null;
  files?: number;
  types?: number;
  instantiations?: number;
  memoryMb?: number;
  checkSeconds?: number;
  totalSeconds?: number;
  stdout: string;
  stderr: string;
}

interface QueryEditResult {
  count: number;
  initialCompileMs: number;
  coldTypecheck: TypeDiagnostics;
  warmTypecheck: TypeDiagnostics;
  editCompileMs: number;
  editCompiledQueries: number;
  editCacheHits: number;
  editFilesRead: number;
  editRuntimeUpdated: boolean;
  editTypesUpdated: boolean;
  editTypecheck: TypeDiagnostics;
  combinedEditMs: number;
  generatedBytes: number;
  runtimeBytes: number;
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

function counts(): number[] {
  const raw = option("--counts");
  if (!raw) return [...DEFAULT_COUNTS];
  return raw.split(",").map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const benchRoot = path.join(repoRoot, ".xql-bench");
const tsc = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);

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

function queryText(i: number): string {
  return `select id, title from product where id = :id_${i}`;
}

function editedQueryText(i: number): string {
  return `select id from product where id = :id_${i}`;
}

function parseMetric(output: string, name: string): number | undefined {
  const match = new RegExp(`^${name}:\\s+([0-9.]+)`, "mi").exec(output);
  return match ? Number(match[1]) : undefined;
}

function runTsc(root: string): TypeDiagnostics {
  const started = performance.now();
  const result = spawnSync(tsc, ["-p", "tsconfig.json", "--extendedDiagnostics"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const wallMs = performance.now() - started;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    wallMs,
    exitCode: result.status,
    files: parseMetric(stdout, "Files"),
    types: parseMetric(stdout, "Types"),
    instantiations: parseMetric(stdout, "Instantiations"),
    memoryMb: (() => {
      const kb = parseMetric(stdout, "Memory used");
      return kb === undefined ? undefined : kb / 1024;
    })(),
    checkSeconds: parseMetric(stdout, "Check time"),
    totalSeconds: parseMetric(stdout, "Total time"),
    stdout,
    stderr,
  };
}

function assertTsc(result: TypeDiagnostics, phase: string): void {
  if (result.exitCode === 0) return;
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  throw new Error(`${phase} typecheck failed`);
}

async function writeFixture(root: string, count: number): Promise<string[]> {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });

  await fs.writeFile(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2022",
        module: "nodenext",
        moduleResolution: "nodenext",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        incremental: true,
        tsBuildInfoFile: "./.tsbuildinfo",
        allowImportingTsExtensions: true,
        types: ["node"],
        paths: { xql: ["../../dist/index.d.ts"] },
      },
      include: ["./fixture.ts", "./queries-*.ts", "./.xql/generated.ts"],
    }, null, 2) + "\n",
    "utf8",
  );

  await fs.writeFile(
    path.join(root, "fixture.ts"),
    `import { createXql, defineSchema, t } from "xql";\n` +
    `import { manifest } from "./.xql/runtime.js";\n` +
    `const schema = defineSchema({ product: { id: t.int8(), title: t.text() } });\n` +
    `export const xql = createXql(schema, { query: async () => [] }, { manifest });\n`,
    "utf8",
  );

  const files: string[] = [];
  for (let start = 0; start < count; start += CHUNK_SIZE) {
    const end = Math.min(count, start + CHUNK_SIZE);
    const file = path.join(root, `queries-${start}-${end}.ts`);
    const lines = [`import { xql } from "./fixture.ts";`];
    for (let i = start; i < end; i++) {
      lines.push(
        `const q${i} = xql(${JSON.stringify(queryText(i))}, { ${JSON.stringify(`id_${i}`)}: 1n });`,
        `void q${i};`,
      );
    }
    await fs.writeFile(file, lines.join("\n") + "\n", "utf8");
    files.push(file);
  }
  return files;
}

async function editOneQuery(file: string, index: number): Promise<void> {
  const text = await fs.readFile(file, "utf8");
  const before = JSON.stringify(queryText(index));
  const after = JSON.stringify(editedQueryText(index));
  if (!text.includes(before)) throw new Error(`query ${index} not found in ${file}`);
  await fs.writeFile(file, text.replace(before, after), "utf8");
}

async function runOne(count: number): Promise<QueryEditResult> {
  const root = path.join(benchRoot, `query-edit-${count}`);
  const queryFiles = await writeFixture(root, count);

  const initialCompileStarted = performance.now();
  await compileProject({
    root,
    catalog,
    compiledOnly: true,
  });
  const initialCompileMs = performance.now() - initialCompileStarted;

  await fs.rm(path.join(root, ".tsbuildinfo"), { force: true });
  const coldTypecheck = runTsc(root);
  assertTsc(coldTypecheck, "cold");
  const warmTypecheck = runTsc(root);
  assertTsc(warmTypecheck, "warm");

  const editIndex = Math.floor(count / 2);
  const editFile = queryFiles[Math.floor(editIndex / CHUNK_SIZE)]!;
  await editOneQuery(editFile, editIndex);

  // Development mode: the compiler still proves and caches the changed SQL and
  // refreshes runtime metadata immediately, but defers the global exact-literal
  // registry refresh. That prevents 24,999 unrelated generated calls from being
  // invalidated. The edited query temporarily takes the single-query legacy type
  // path until the next full `xql compile` (which CI/build always performs).
  const editCompileStarted = performance.now();
  const editCompile = await compileProject({
    root,
    catalog,
    compiledOnly: true,
    emitTypes: false,
  });
  const editCompileMs = performance.now() - editCompileStarted;

  const editTypecheck = runTsc(root);
  assertTsc(editTypecheck, "query-edit");

  return {
    count,
    initialCompileMs,
    coldTypecheck,
    warmTypecheck,
    editCompileMs,
    editCompiledQueries: editCompile.stats.compiledQueries,
    editCacheHits: editCompile.stats.cacheHits,
    editFilesRead: editCompile.stats.filesRead,
    editRuntimeUpdated: editCompile.stats.runtimeUpdated,
    editTypesUpdated: editCompile.stats.typesUpdated,
    editTypecheck,
    combinedEditMs: editCompileMs + editTypecheck.wallMs,
    generatedBytes: (await fs.stat(path.join(root, ".xql/generated.ts"))).size,
    runtimeBytes: (await fs.stat(path.join(root, ".xql/runtime.ts"))).size,
  };
}

function compactType(d: TypeDiagnostics) {
  return {
    wallMs: Math.round(d.wallMs),
    files: d.files,
    types: d.types,
    instantiations: d.instantiations,
    memoryMb: d.memoryMb === undefined ? undefined : Math.round(d.memoryMb),
    checkSeconds: d.checkSeconds,
    totalSeconds: d.totalSeconds,
  };
}

async function main(): Promise<void> {
  await fs.mkdir(benchRoot, { recursive: true });
  const results: QueryEditResult[] = [];

  for (const count of counts()) {
    process.stdout.write(`query-edit benchmark ${count.toLocaleString().padStart(6)} queries ... `);
    const result = await runOne(count);
    results.push(result);
    console.log(
      `${Math.round(result.editCompileMs)}ms compile + ` +
      `${Math.round(result.editTypecheck.wallMs)}ms TypeScript = ` +
      `${Math.round(result.combinedEditMs)}ms total`,
    );
  }

  const serializable = results.map((result) => ({
    count: result.count,
    initialCompileMs: Math.round(result.initialCompileMs),
    coldTypecheck: compactType(result.coldTypecheck),
    warmTypecheck: compactType(result.warmTypecheck),
    editCompileMs: Math.round(result.editCompileMs),
    editCompiledQueries: result.editCompiledQueries,
    editCacheHits: result.editCacheHits,
    editFilesRead: result.editFilesRead,
    editRuntimeUpdated: result.editRuntimeUpdated,
    editTypesUpdated: result.editTypesUpdated,
    editTypecheck: compactType(result.editTypecheck),
    combinedEditMs: Math.round(result.combinedEditMs),
    generatedBytes: result.generatedBytes,
    runtimeBytes: result.runtimeBytes,
  }));

  const out = path.join(benchRoot, "query-edit-results.json");
  await fs.writeFile(out, JSON.stringify(serializable, null, 2) + "\n", "utf8");

  console.log("\nEnd-to-end query edit summary");
  console.log("queries\tcompile(ms)\ttsc(ms)\ttotal(ms)\trecompiled\tfiles-read\truntime-updated\ttypes-updated");
  for (const result of results) {
    console.log([
      result.count,
      Math.round(result.editCompileMs),
      Math.round(result.editTypecheck.wallMs),
      Math.round(result.combinedEditMs),
      result.editCompiledQueries,
      result.editFilesRead,
      result.editRuntimeUpdated,
      result.editTypesUpdated,
    ].join("\t"));
  }
  console.log(`\nFull diagnostics: ${out}`);
}

await main();
