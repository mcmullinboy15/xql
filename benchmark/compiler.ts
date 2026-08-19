import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { compileProject } from "../src/compiler/project.ts";
import type { CompilerCatalog } from "../src/compiler/types.ts";

const DEFAULT_COUNTS = [100, 1_000, 5_000, 10_000, 25_000] as const;
const CHUNK_SIZE = 250;

interface PhaseResult {
  wallMs: number;
  compileMs: number;
  memoryMb: number;
  filesScanned: number;
  uniqueQueries: number;
  cacheHits: number;
  cacheMisses: number;
  compiledQueries: number;
}

interface CompilerBenchmarkResult {
  count: number;
  cold: PhaseResult;
  noChange: PhaseResult;
  oneQueryEdit: PhaseResult;
  oneFileEdit: PhaseResult;
  generatedBytes: number;
  cacheBytes: number;
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

function queryText(i: number): string {
  return `select id, title from product where id = :id_${i}`;
}

function editedQueryText(i: number): string {
  return `select id from product where id = :id_${i}`;
}

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

async function writeFixture(root: string, count: number): Promise<string[]> {
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, "catalog.json"), JSON.stringify(catalog), "utf8");
  await fs.writeFile(path.join(root, "fixture.ts"), "declare const xql: any;\n", "utf8");

  const files: string[] = [];
  for (let start = 0; start < count; start += CHUNK_SIZE) {
    const end = Math.min(count, start + CHUNK_SIZE);
    const file = path.join(root, `queries-${start}-${end}.ts`);
    const lines = ["declare const xql: any;"];
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

async function worker(root: string): Promise<void> {
  const parsedCatalog = JSON.parse(await fs.readFile(path.join(root, "catalog.json"), "utf8")) as CompilerCatalog;
  const started = performance.now();
  const result = await compileProject({
    root,
    catalog: parsedCatalog,
    compiledOnly: true,
  });
  const compileMs = performance.now() - started;
  const memoryMb = process.resourceUsage().maxRSS / 1024;
  console.log(JSON.stringify({
    compileMs,
    memoryMb,
    ...result.stats,
  }));
}

function runWorker(root: string): PhaseResult {
  const script = fileURLToPath(import.meta.url);
  const started = performance.now();
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", script, "--worker", root],
    {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  const wallMs = performance.now() - started;
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? "");
    process.stdout.write(result.stdout ?? "");
    throw new Error(`compiler benchmark worker failed with ${result.status}`);
  }
  const lines = (result.stdout ?? "").trim().split("\n").filter(Boolean);
  const parsed = JSON.parse(lines.at(-1) ?? "{}") as Omit<PhaseResult, "wallMs">;
  return { wallMs, ...parsed };
}

async function editOneQuery(file: string, index: number): Promise<void> {
  const text = await fs.readFile(file, "utf8");
  const before = JSON.stringify(queryText(index));
  const after = JSON.stringify(editedQueryText(index));
  if (!text.includes(before)) throw new Error(`query ${index} not found in ${file}`);
  await fs.writeFile(file, text.replace(before, after), "utf8");
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, "..");
  const benchRoot = path.join(repoRoot, ".xql-bench");
  await fs.mkdir(benchRoot, { recursive: true });
  const results: CompilerBenchmarkResult[] = [];

  for (const count of counts()) {
    const root = path.join(benchRoot, `compiler-${count}`);
    const queryFiles = await writeFixture(root, count);
    await fs.rm(path.join(root, ".xql"), { recursive: true, force: true });

    process.stdout.write(`compiler benchmark ${count.toLocaleString().padStart(6)} queries ... `);
    const cold = runWorker(root);
    const noChange = runWorker(root);

    const editIndex = Math.floor(count / 2);
    const editFile = queryFiles[Math.floor(editIndex / CHUNK_SIZE)]!;
    await editOneQuery(editFile, editIndex);
    const oneQueryEdit = runWorker(root);

    await fs.appendFile(editFile, `\n// non-query edit ${Date.now()}\n`, "utf8");
    const oneFileEdit = runWorker(root);

    const generatedBytes = (await fs.stat(path.join(root, ".xql/generated.ts"))).size;
    const cacheBytes = (await fs.stat(path.join(root, ".xql/cache.json"))).size;
    results.push({ count, cold, noChange, oneQueryEdit, oneFileEdit, generatedBytes, cacheBytes });

    console.log(
      `${Math.round(cold.wallMs)}ms cold / ${Math.round(noChange.wallMs)}ms no-change / ` +
      `${Math.round(oneQueryEdit.wallMs)}ms one-query / ${Math.round(oneFileEdit.wallMs)}ms file-only`,
    );
  }

  const out = path.join(benchRoot, "compiler-results.json");
  await fs.writeFile(out, JSON.stringify(results, null, 2) + "\n", "utf8");

  console.log("\nCompiler summary (wall-clock ms)");
  console.log("queries\tcold\tno-change\tone-query\tfile-only\tmemory(MB)\tgenerated(KB)");
  for (const result of results) {
    const memory = Math.max(
      result.cold.memoryMb,
      result.noChange.memoryMb,
      result.oneQueryEdit.memoryMb,
      result.oneFileEdit.memoryMb,
    );
    console.log([
      result.count,
      Math.round(result.cold.wallMs),
      Math.round(result.noChange.wallMs),
      Math.round(result.oneQueryEdit.wallMs),
      Math.round(result.oneFileEdit.wallMs),
      Math.round(memory),
      Math.round(result.generatedBytes / 1024),
    ].join("\t"));
  }
  console.log(`\nFull diagnostics: ${out}`);
}

const workerRoot = option("--worker");
if (workerRoot !== undefined) await worker(path.resolve(workerRoot));
else await main();
