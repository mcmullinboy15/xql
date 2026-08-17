import { promises as fs } from "node:fs";
import path from "node:path";
import type { CompiledQueryArtifact } from "../runtime/compiled.ts";
import { compileQuery } from "./compile-query.ts";
import { emitGeneratedModule } from "./emit.ts";
import { extractQueriesFromSource } from "./extract.ts";
import {
  XqlCompilerError,
  type CompilerCatalog,
  type CompilerDiagnostic,
  type PostgresParser,
} from "./types.ts";

export interface CompileProjectOptions {
  readonly root: string;
  readonly catalog: CompilerCatalog;
  readonly outFile?: string;
  readonly moduleName?: string;
  readonly calleeNames?: readonly string[];
  readonly parser?: PostgresParser;
  /** When true, a runtime-dynamic query is a build failure instead of a legacy fallback. */
  readonly compiledOnly?: boolean;
}

export interface CompileProjectResult {
  readonly artifacts: readonly CompiledQueryArtifact[];
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly outFile: string;
}

async function walk(dir: string, out: string[]): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", ".xql"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
  }
}

export async function compileProject(
  options: CompileProjectOptions,
): Promise<CompileProjectResult> {
  const root = path.resolve(options.root);
  const files: string[] = [];
  await walk(root, files);
  const diagnostics: CompilerDiagnostic[] = [];
  const locations = new Map<string, { file: string; line: number; column: number }>();

  for (const file of files) {
    const text = await fs.readFile(file, "utf8");
    const extracted = extractQueriesFromSource(
      text,
      path.relative(root, file),
      options.calleeNames,
    );
    for (const diagnostic of extracted.diagnostics) {
      diagnostics.push(diagnostic);
      if (options.compiledOnly)
        throw new XqlCompilerError(diagnostic);
    }
    for (const query of extracted.queries)
      if (!locations.has(query.source)) locations.set(query.source, query);
  }

  const artifacts: CompiledQueryArtifact[] = [];
  for (const [source, location] of locations) {
    try {
      artifacts.push(await compileQuery(source, options.catalog, options.parser));
    } catch (cause) {
      if (cause instanceof XqlCompilerError) {
        const diagnostic: CompilerDiagnostic = {
          ...cause.diagnostic,
          file: location.file,
          line: location.line,
          column: location.column,
        };
        diagnostics.push(diagnostic);
        if (options.compiledOnly) throw new XqlCompilerError(diagnostic);
        continue;
      }
      throw cause;
    }
  }

  const outFile = path.resolve(root, options.outFile ?? ".xql/generated.ts");
  await fs.mkdir(path.dirname(outFile), { recursive: true });
  await fs.writeFile(
    outFile,
    emitGeneratedModule(artifacts, options.moduleName ?? "xql"),
    "utf8",
  );
  return { artifacts, diagnostics, outFile };
}
