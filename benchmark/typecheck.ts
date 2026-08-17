import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const DEFAULT_COUNTS = [100, 1_000, 5_000, 10_000, 25_000] as const;
type Mode = "baseline" | "legacy" | "compiled";

interface Diagnostics {
  wallMs: number;
  exitCode: number | null;
  files?: number;
  types?: number;
  instantiations?: number;
  memoryKb?: number;
  checkSeconds?: number;
  totalSeconds?: number;
  stdout: string;
  stderr: string;
}

interface RunResult {
  count: number;
  mode: Mode;
  cold: Diagnostics;
  warm: Diagnostics;
  edit: Diagnostics;
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

function modes(): Mode[] {
  const raw = option("--modes");
  if (!raw) return ["baseline", "legacy", "compiled"];
  const allowed = new Set<Mode>(["baseline", "legacy", "compiled"]);
  return raw.split(",").filter((mode): mode is Mode => allowed.has(mode as Mode));
}

function xqlEntry(): string {
  return option("--xql-entry") ?? "../../src/index.ts";
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const benchRoot = path.join(repoRoot, ".xql-bench");
const tsc = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);

function queryText(i: number): string {
  return `select id, title from product where id = :id_${i}`;
}

function parseMetric(output: string, name: string): number | undefined {
  const match = new RegExp(`^${name}:\\s+([0-9.]+)`, "mi").exec(output);
  return match ? Number(match[1]) : undefined;
}

function diagnostics(stdout: string, stderr: string, wallMs: number, exitCode: number | null): Diagnostics {
  return {
    wallMs,
    exitCode,
    files: parseMetric(stdout, "Files"),
    types: parseMetric(stdout, "Types"),
    instantiations: parseMetric(stdout, "Instantiations"),
    memoryKb: parseMetric(stdout, "Memory used"),
    checkSeconds: parseMetric(stdout, "Check time"),
    totalSeconds: parseMetric(stdout, "Total time"),
    stdout,
    stderr,
  };
}

function runTsc(dir: string): Diagnostics {
  const start = performance.now();
  const result = spawnSync(tsc, ["-p", "tsconfig.json", "--extendedDiagnostics"], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    maxBuffer: 64 * 1024 * 1024,
  });
  const wallMs = performance.now() - start;
  return diagnostics(result.stdout ?? "", result.stderr ?? "", wallMs, result.status);
}

async function writeFixture(dir: string, mode: Mode, count: number): Promise<string[]> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });

  const include = ["./**/*.ts"];
  await fs.writeFile(
    path.join(dir, "tsconfig.json"),
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
        // TypeScript 7 removed baseUrl. `paths` entries are resolved relative
        // to the config file directly, which is exactly what this fixture wants.
        paths: { xql: [xqlEntry()] },
      },
      include,
    }, null, 2),
  );

  if (mode !== "baseline") {
    await fs.writeFile(
      path.join(dir, "fixture.ts"),
      `import { createXql, defineSchema, t } from "xql";\n` +
      `const schema = defineSchema({ product: { id: t.int8(), title: t.text() } });\n` +
      `export const xql = createXql(schema, { query: async () => [] });\n`,
    );
  }

  if (mode === "compiled") {
    const registry: string[] = [
      `import type { GeneratedQueryInfo } from "xql";`,
      `declare module "xql" {`,
      `  interface GeneratedQueryRegistry {`,
    ];
    for (let i = 0; i < count; i++) {
      registry.push(
        `    ${JSON.stringify(queryText(i))}: GeneratedQueryInfo<{ id: bigint; title: string }, { ${JSON.stringify(`id_${i}`)}: bigint }>;`,
      );
    }
    registry.push(`  }`, `}`, ``);
    await fs.writeFile(path.join(dir, "generated.ts"), registry.join("\n"));
  }

  const chunkSize = 250;
  const queryFiles: string[] = [];
  for (let start = 0; start < count; start += chunkSize) {
    const end = Math.min(count, start + chunkSize);
    const file = path.join(dir, `queries-${start}-${end}.ts`);
    queryFiles.push(file);
    const lines: string[] = [];
    if (mode === "baseline") {
      lines.push(
        `declare function query<Row, Params>(sql: string, params: Params): Promise<Row[]>;`,
      );
      for (let i = start; i < end; i++) {
        lines.push(
          `const q${i} = query<{ id: bigint; title: string }, { ${JSON.stringify(`id_${i}`)}: bigint }>(${JSON.stringify(queryText(i))}, { ${JSON.stringify(`id_${i}`)}: 1n });`,
          `void q${i};`,
        );
      }
    } else {
      lines.push(`import { xql } from "./fixture.ts";`);
      for (let i = start; i < end; i++) {
        lines.push(
          `const q${i} = xql(${JSON.stringify(queryText(i))}, { ${JSON.stringify(`id_${i}`)}: 1n });`,
          `void q${i};`,
        );
      }
    }
    await fs.writeFile(file, lines.join("\n") + "\n");
  }
  return queryFiles;
}

async function one(mode: Mode, count: number): Promise<RunResult> {
  const dir = path.join(benchRoot, `${mode}-${count}`);
  const queryFiles = await writeFixture(dir, mode, count);
  await fs.rm(path.join(dir, ".tsbuildinfo"), { force: true });

  const cold = runTsc(dir);
  if (cold.exitCode !== 0) {
    console.error(cold.stdout, cold.stderr);
    throw new Error(`${mode}/${count} cold typecheck failed`);
  }

  const warm = runTsc(dir);
  if (warm.exitCode !== 0) throw new Error(`${mode}/${count} warm typecheck failed`);

  // Approximate an editor-sized invalidation by changing one query file without
  // changing any shared schema/generated declarations.
  await fs.appendFile(queryFiles[Math.floor(queryFiles.length / 2)]!, `\n// edit ${Date.now()}\n`);
  const edit = runTsc(dir);
  if (edit.exitCode !== 0) throw new Error(`${mode}/${count} edit typecheck failed`);

  return { count, mode, cold, warm, edit };
}

function compact(d: Diagnostics) {
  return {
    wallMs: Math.round(d.wallMs),
    totalSeconds: d.totalSeconds,
    checkSeconds: d.checkSeconds,
    memoryMb: d.memoryKb === undefined ? undefined : Math.round(d.memoryKb / 1024),
    types: d.types,
    instantiations: d.instantiations,
  };
}

async function main() {
  await fs.mkdir(benchRoot, { recursive: true });
  const results: RunResult[] = [];
  for (const count of counts()) {
    for (const mode of modes()) {
      process.stdout.write(`type benchmark ${mode.padEnd(8)} ${count.toLocaleString().padStart(6)} queries ... `);
      const result = await one(mode, count);
      results.push(result);
      console.log(`${Math.round(result.cold.wallMs)}ms cold / ${Math.round(result.edit.wallMs)}ms edit`);
    }
  }

  const serializable = results.map((result) => ({
    count: result.count,
    mode: result.mode,
    cold: compact(result.cold),
    warm: compact(result.warm),
    edit: compact(result.edit),
  }));
  const out = path.join(benchRoot, "results.json");
  await fs.writeFile(out, JSON.stringify(serializable, null, 2) + "\n");

  console.log("\nSummary (wall-clock ms)");
  console.log("queries\tmode\tcold\twarm\tedit\tmemory(MB)\tinstantiations");
  for (const result of results) {
    console.log([
      result.count,
      result.mode,
      Math.round(result.cold.wallMs),
      Math.round(result.warm.wallMs),
      Math.round(result.edit.wallMs),
      result.cold.memoryKb === undefined ? "" : Math.round(result.cold.memoryKb / 1024),
      result.cold.instantiations ?? "",
    ].join("\t"));
  }
  console.log(`\nFull diagnostics: ${out}`);
}

await main();
