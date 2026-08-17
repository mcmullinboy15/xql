import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

interface Result {
  count: number;
  editCompileMs: number;
  editCompiledQueries: number;
  editFilesRead: number;
  editRuntimeUpdated: boolean;
  editTypesUpdated: boolean;
  editTypecheck: {
    wallMs: number;
    memoryMb?: number;
  };
  combinedEditMs: number;
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at === -1 ? undefined : process.argv[at + 1];
}

const count = Number(option("--count") ?? "25000");
const file = path.resolve(import.meta.dirname, "../.xql-bench/query-edit-results.json");
const results = JSON.parse(await fs.readFile(file, "utf8")) as Result[];
const result = results.find((entry) => entry.count === count);
if (result === undefined) throw new Error(`missing query-edit benchmark result for ${count} queries`);

const scale = Math.max(1, count / 25_000);
const compileBudget = 1_000 * scale;
const typecheckBudget = 1_000 * scale;
const combinedBudget = 1_750 * scale;
const memoryBudget = 900;

const rows = [
  ["incremental XQL compile", `${result.editCompileMs} ms`, `<= ${Math.round(compileBudget)} ms`],
  ["incremental TypeScript", `${result.editTypecheck.wallMs} ms`, `<= ${Math.round(typecheckBudget)} ms`],
  ["combined query-edit loop", `${result.combinedEditMs} ms`, `<= ${Math.round(combinedBudget)} ms`],
  ["TypeScript peak memory", `${result.editTypecheck.memoryMb ?? "?"} MB`, `<= ${memoryBudget} MB`],
  ["queries recompiled", `${result.editCompiledQueries}`, "1"],
  ["source files reread", `${result.editFilesRead}`, "1"],
  ["runtime TypeScript artifact updated", `${result.editRuntimeUpdated}`, "false"],
  ["global type registry updated", `${result.editTypesUpdated}`, "false"],
];

const lines = [
  `### XQL end-to-end development query edit — ${count.toLocaleString()} queries`,
  "",
  "| metric | result | budget |",
  "|---|---:|---:|",
  ...rows.map(([metric, value, budget]) => `| ${metric} | ${value} | ${budget} |`),
];

const failures: string[] = [];
if (result.editCompileMs > compileBudget)
  failures.push(`incremental compiler ${result.editCompileMs}ms exceeds ${Math.round(compileBudget)}ms`);
if (result.editTypecheck.wallMs > typecheckBudget)
  failures.push(`incremental TypeScript ${result.editTypecheck.wallMs}ms exceeds ${Math.round(typecheckBudget)}ms`);
if (result.combinedEditMs > combinedBudget)
  failures.push(`combined query-edit loop ${result.combinedEditMs}ms exceeds ${Math.round(combinedBudget)}ms`);
if ((result.editTypecheck.memoryMb ?? Infinity) > memoryBudget)
  failures.push(`TypeScript memory ${result.editTypecheck.memoryMb ?? "unknown"}MB exceeds ${memoryBudget}MB`);
if (result.editCompiledQueries !== 1)
  failures.push(`query edit recompiled ${result.editCompiledQueries} queries; expected exactly 1`);
if (result.editFilesRead !== 1)
  failures.push(`query edit reread ${result.editFilesRead} source files; expected exactly 1`);
if (result.editRuntimeUpdated)
  failures.push("development query edit rewrote the runtime TypeScript artifact");
if (result.editTypesUpdated)
  failures.push("development query edit rewrote the global type registry");

lines.push("", failures.length === 0
  ? "✅ End-to-end development query-edit budget passed."
  : `❌ ${failures.length} end-to-end development query-edit budget(s) failed.`);

const summary = lines.join("\n") + "\n";
process.stdout.write(summary);
if (process.env.GITHUB_STEP_SUMMARY) await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, summary, "utf8");
if (failures.length > 0) throw new Error(failures.join("\n"));
