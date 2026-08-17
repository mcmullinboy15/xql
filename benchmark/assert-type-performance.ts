import { readFile, appendFile } from "node:fs/promises";
import process from "node:process";

interface Diagnostics {
  readonly wallMs: number;
  readonly memoryMb: number;
  readonly types: number;
  readonly instantiations: number;
}

interface Result {
  readonly count: number;
  readonly mode: "baseline" | "legacy" | "compiled";
  readonly cold: Diagnostics;
  readonly warm: Diagnostics;
  readonly edit: Diagnostics;
}

const BUDGETS = {
  // Cold startup matters for CI and fresh editor/project loads. This ceiling is
  // intentionally tested at 25k queries, not extrapolated from a toy project.
  coldMs: 3_500,
  // Warm and one-file edit checks approximate the interactive developer loop.
  warmMs: 750,
  editMs: 750,
  // Keep the entire 25k-query consumer project comfortably below 1 GiB.
  memoryMb: 800,
  // These are XQL's *added* costs above the hand-typed baseline. Per-query
  // ceilings catch super-linear generated-type growth regardless of machine speed.
  addedInstantiationsPerQuery: 85,
  addedTypesPerQuery: 20,
} as const;

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const count = Number(option("--count"));
if (!Number.isSafeInteger(count) || count <= 0)
  throw new Error("--count must be a positive integer");

const results = JSON.parse(
  await readFile(".xql-bench/results.json", "utf8"),
) as Result[];

const baseline = results.find(
  (result) => result.count === count && result.mode === "baseline",
);
const compiled = results.find(
  (result) => result.count === count && result.mode === "compiled",
);
if (baseline === undefined || compiled === undefined)
  throw new Error(`missing baseline/compiled benchmark results for ${count} queries`);

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`missing benchmark metric: ${label}`);
  return value;
}

for (const [label, diagnostics] of [
  ["baseline cold", baseline.cold],
  ["compiled cold", compiled.cold],
  ["compiled warm", compiled.warm],
  ["compiled edit", compiled.edit],
] as const) {
  finite(diagnostics.wallMs, `${label} wallMs`);
  finite(diagnostics.memoryMb, `${label} memoryMb`);
  finite(diagnostics.types, `${label} types`);
  finite(diagnostics.instantiations, `${label} instantiations`);
}

const addedInstantiations = Math.max(
  0,
  compiled.cold.instantiations - baseline.cold.instantiations,
);
const addedTypes = Math.max(0, compiled.cold.types - baseline.cold.types);
const addedInstantiationsPerQuery = addedInstantiations / count;
const addedTypesPerQuery = addedTypes / count;
const coldRatio = compiled.cold.wallMs / baseline.cold.wallMs;
const memoryRatio = compiled.cold.memoryMb / baseline.cold.memoryMb;

const failures: string[] = [];
const assertBudget = (ok: boolean, message: string) => {
  if (!ok) failures.push(message);
};

assertBudget(
  compiled.cold.wallMs <= BUDGETS.coldMs,
  `cold typecheck ${compiled.cold.wallMs}ms exceeds ${BUDGETS.coldMs}ms`,
);
assertBudget(
  compiled.warm.wallMs <= BUDGETS.warmMs,
  `warm typecheck ${compiled.warm.wallMs}ms exceeds ${BUDGETS.warmMs}ms`,
);
assertBudget(
  compiled.edit.wallMs <= BUDGETS.editMs,
  `one-file edit typecheck ${compiled.edit.wallMs}ms exceeds ${BUDGETS.editMs}ms`,
);
assertBudget(
  compiled.cold.memoryMb <= BUDGETS.memoryMb,
  `peak memory ${compiled.cold.memoryMb}MB exceeds ${BUDGETS.memoryMb}MB`,
);
assertBudget(
  addedInstantiationsPerQuery <= BUDGETS.addedInstantiationsPerQuery,
  `XQL adds ${addedInstantiationsPerQuery.toFixed(1)} generic instantiations/query; budget is ${BUDGETS.addedInstantiationsPerQuery}`,
);
assertBudget(
  addedTypesPerQuery <= BUDGETS.addedTypesPerQuery,
  `XQL adds ${addedTypesPerQuery.toFixed(1)} types/query; budget is ${BUDGETS.addedTypesPerQuery}`,
);

const summary = [
  `### XQL type-performance — ${count.toLocaleString()} queries`,
  "",
  "| metric | baseline | compiled XQL | budget |",
  "|---|---:|---:|---:|",
  `| cold wall | ${baseline.cold.wallMs} ms | ${compiled.cold.wallMs} ms (${coldRatio.toFixed(2)}x) | ≤ ${BUDGETS.coldMs} ms |`,
  `| warm wall | ${baseline.warm.wallMs} ms | ${compiled.warm.wallMs} ms | ≤ ${BUDGETS.warmMs} ms |`,
  `| one-file edit | ${baseline.edit.wallMs} ms | ${compiled.edit.wallMs} ms | ≤ ${BUDGETS.editMs} ms |`,
  `| cold memory | ${baseline.cold.memoryMb} MB | ${compiled.cold.memoryMb} MB (${memoryRatio.toFixed(2)}x) | ≤ ${BUDGETS.memoryMb} MB |`,
  `| added instantiations/query | — | ${addedInstantiationsPerQuery.toFixed(1)} | ≤ ${BUDGETS.addedInstantiationsPerQuery} |`,
  `| added types/query | — | ${addedTypesPerQuery.toFixed(1)} | ≤ ${BUDGETS.addedTypesPerQuery} |`,
  "",
  failures.length === 0
    ? "✅ All XQL type-performance budgets passed."
    : `❌ ${failures.length} XQL type-performance budget(s) failed.`,
].join("\n");

console.log(summary);
if (process.env.GITHUB_STEP_SUMMARY !== undefined)
  await appendFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);

if (failures.length > 0) throw new Error(failures.join("\n"));
