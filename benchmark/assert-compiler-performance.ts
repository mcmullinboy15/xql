import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

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

const count = Number(option("--count"));
if (!Number.isSafeInteger(count) || count <= 0) throw new Error("--count must be a positive integer");

const repoRoot = path.resolve(import.meta.dirname, "..");
const results = JSON.parse(
  await fs.readFile(path.join(repoRoot, ".xql-bench/compiler-results.json"), "utf8"),
) as CompilerBenchmarkResult[];
const result = results.find((entry) => entry.count === count);
if (result === undefined) throw new Error(`missing compiler benchmark result for ${count} queries`);

const failures: string[] = [];
const assert = (ok: boolean, message: string) => { if (!ok) failures.push(message); };
const incrementalBudgetMs = Math.max(750, count * 0.06);
const oneQueryBudgetMs = Math.max(1000, count * 0.08);
const coldBudgetMs = Math.max(2500, count * 2);
const maxMemoryMb = 1024;
const maxGeneratedBytesPerQuery = 1200;
const maxCacheBytesPerQuery = 1000;

assert(result.cold.uniqueQueries === count, `cold compile found ${result.cold.uniqueQueries} unique queries, expected ${count}`);
assert(result.cold.compiledQueries === count, `cold compile compiled ${result.cold.compiledQueries}, expected ${count}`);
assert(result.cold.cacheHits === 0, `cold compile unexpectedly had ${result.cold.cacheHits} cache hits`);
assert(result.noChange.compiledQueries === 0, `no-change compile recompiled ${result.noChange.compiledQueries} queries`);
assert(result.noChange.cacheHits === count, `no-change compile only reused ${result.noChange.cacheHits}/${count} queries`);
assert(result.oneQueryEdit.compiledQueries === 1, `one-query edit compiled ${result.oneQueryEdit.compiledQueries} queries instead of exactly 1`);
assert(result.oneQueryEdit.cacheHits === count - 1, `one-query edit reused ${result.oneQueryEdit.cacheHits}/${count - 1} unchanged queries`);
assert(result.oneFileEdit.compiledQueries === 0, `non-query file edit recompiled ${result.oneFileEdit.compiledQueries} queries`);
assert(result.oneFileEdit.cacheHits === count, `non-query file edit only reused ${result.oneFileEdit.cacheHits}/${count} queries`);

assert(result.cold.wallMs <= coldBudgetMs, `cold compiler wall ${Math.round(result.cold.wallMs)}ms exceeds ${Math.round(coldBudgetMs)}ms`);
assert(result.noChange.wallMs <= incrementalBudgetMs, `no-change compiler wall ${Math.round(result.noChange.wallMs)}ms exceeds ${Math.round(incrementalBudgetMs)}ms`);
assert(result.oneQueryEdit.wallMs <= oneQueryBudgetMs, `one-query edit compiler wall ${Math.round(result.oneQueryEdit.wallMs)}ms exceeds ${Math.round(oneQueryBudgetMs)}ms`);
assert(result.oneFileEdit.wallMs <= incrementalBudgetMs, `file-only edit compiler wall ${Math.round(result.oneFileEdit.wallMs)}ms exceeds ${Math.round(incrementalBudgetMs)}ms`);

const memoryMb = Math.max(
  result.cold.memoryMb,
  result.noChange.memoryMb,
  result.oneQueryEdit.memoryMb,
  result.oneFileEdit.memoryMb,
);
const generatedBytesPerQuery = result.generatedBytes / count;
const cacheBytesPerQuery = result.cacheBytes / count;
assert(memoryMb <= maxMemoryMb, `compiler peak memory ${Math.round(memoryMb)}MB exceeds ${maxMemoryMb}MB`);
assert(generatedBytesPerQuery <= maxGeneratedBytesPerQuery, `generated module is ${Math.round(generatedBytesPerQuery)} bytes/query, exceeds ${maxGeneratedBytesPerQuery}`);
assert(cacheBytesPerQuery <= maxCacheBytesPerQuery, `compiler cache is ${Math.round(cacheBytesPerQuery)} bytes/query, exceeds ${maxCacheBytesPerQuery}`);

const summary = [
  `### XQL compiler performance — ${count.toLocaleString()} queries`,
  "",
  "| metric | result | budget |",
  "|---|---:|---:|",
  `| cold compile | ${Math.round(result.cold.wallMs)} ms | <= ${Math.round(coldBudgetMs)} ms |`,
  `| no-change compile | ${Math.round(result.noChange.wallMs)} ms | <= ${Math.round(incrementalBudgetMs)} ms |`,
  `| one-query edit | ${Math.round(result.oneQueryEdit.wallMs)} ms | <= ${Math.round(oneQueryBudgetMs)} ms |`,
  `| file-only edit | ${Math.round(result.oneFileEdit.wallMs)} ms | <= ${Math.round(incrementalBudgetMs)} ms |`,
  `| peak memory | ${Math.round(memoryMb)} MB | <= ${maxMemoryMb} MB |`,
  `| generated size/query | ${Math.round(generatedBytesPerQuery)} B | <= ${maxGeneratedBytesPerQuery} B |`,
  `| cache size/query | ${Math.round(cacheBytesPerQuery)} B | <= ${maxCacheBytesPerQuery} B |`,
  `| no-change recompiles | ${result.noChange.compiledQueries} | 0 |`,
  `| one-query edit recompiles | ${result.oneQueryEdit.compiledQueries} | 1 |`,
  `| file-only edit recompiles | ${result.oneFileEdit.compiledQueries} | 0 |`,
  "",
  failures.length === 0 ? "✅ All XQL compiler-performance budgets passed." : `❌ ${failures.length} compiler budget(s) failed.`,
].join("\n");

if (process.env.GITHUB_STEP_SUMMARY) {
  await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary + "\n", "utf8");
}
console.log(summary);
if (failures.length > 0) throw new Error(failures.join("\n"));
