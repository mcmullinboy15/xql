import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CompiledQueryArtifact } from "../runtime/compiled.ts";
import { compileQuery } from "./compile-query.ts";
import { emitGeneratedModule } from "./emit.ts";
import { extractQueriesFromSource } from "./extract.ts";
import { loadPostgresParser } from "./parser.ts";
import {
  XqlCompilerError,
  type CompilerCatalog,
  type CompilerDiagnostic,
  type PostgresParser,
} from "./types.ts";

const COMPILER_CACHE_VERSION = 1 as const;

interface CompilerCache {
  readonly version: typeof COMPILER_CACHE_VERSION;
  readonly catalogHash: string;
  readonly artifacts: readonly CompiledQueryArtifact[];
}

export interface CompileProjectOptions {
  readonly root: string;
  readonly catalog: CompilerCatalog;
  readonly outFile?: string;
  readonly moduleName?: string;
  readonly calleeNames?: readonly string[];
  readonly parser?: PostgresParser;
  /** When true, a runtime-dynamic query is a build failure instead of a legacy fallback. */
  readonly compiledOnly?: boolean;
  /** Persistent artifact cache. Defaults to `.xql/cache.json`; set false to disable. */
  readonly cache?: boolean;
  readonly cacheFile?: string;
}

export interface CompileProjectStats {
  readonly filesScanned: number;
  readonly uniqueQueries: number;
  readonly cacheHits: number;
  readonly cacheMisses: number;
  readonly compiledQueries: number;
}

export interface CompileProjectResult {
  readonly artifacts: readonly CompiledQueryArtifact[];
  readonly diagnostics: readonly CompilerDiagnostic[];
  readonly outFile: string;
  readonly cacheFile?: string;
  readonly stats: CompileProjectStats;
}

async function walk(dir: string, out: string[]): Promise<void> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", ".xql"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (/\.(?:ts|tsx|mts|cts)$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) out.push(full);
  }
}

function catalogHash(catalog: CompilerCatalog): string {
  return createHash("sha256").update(JSON.stringify(catalog)).digest("hex");
}

async function readCache(
  file: string,
  expectedCatalogHash: string,
): Promise<Map<string, CompiledQueryArtifact>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<CompilerCache>;
    if (
      parsed.version !== COMPILER_CACHE_VERSION ||
      parsed.catalogHash !== expectedCatalogHash ||
      !Array.isArray(parsed.artifacts)
    ) {
      return new Map();
    }
    return new Map(
      parsed.artifacts
        .filter((artifact): artifact is CompiledQueryArtifact =>
          artifact !== null &&
          typeof artifact === "object" &&
          typeof (artifact as CompiledQueryArtifact).source === "string"
        )
        .map((artifact) => [artifact.source, artifact]),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return new Map();
    throw error;
  }
}

async function writeIfChanged(file: string, content: string): Promise<void> {
  try {
    if (await fs.readFile(file, "utf8") === content) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, content, "utf8");
  await fs.rename(temp, file);
}

async function writeCache(
  file: string,
  hash: string,
  artifacts: readonly CompiledQueryArtifact[],
): Promise<void> {
  const cache: CompilerCache = {
    version: COMPILER_CACHE_VERSION,
    catalogHash: hash,
    artifacts,
  };
  await writeIfChanged(file, JSON.stringify(cache) + "\n");
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

  const useCache = options.cache !== false;
  const resolvedCacheFile = path.resolve(root, options.cacheFile ?? ".xql/cache.json");
  const hash = catalogHash(options.catalog);
  const cached = useCache
    ? await readCache(resolvedCacheFile, hash)
    : new Map<string, CompiledQueryArtifact>();

  const artifacts: CompiledQueryArtifact[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let compiledQueries = 0;
  let parser = options.parser;

  for (const [source, location] of locations) {
    const hit = cached.get(source);
    if (hit !== undefined) {
      artifacts.push(hit);
      cacheHits++;
      continue;
    }

    cacheMisses++;
    try {
      parser ??= await loadPostgresParser();
      artifacts.push(await compileQuery(source, options.catalog, parser));
      compiledQueries++;
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
  const generated = emitGeneratedModule(artifacts, options.moduleName ?? "xql");
  await writeIfChanged(outFile, generated);
  if (useCache) await writeCache(resolvedCacheFile, hash, artifacts);

  return {
    artifacts,
    diagnostics,
    outFile,
    ...(useCache ? { cacheFile: resolvedCacheFile } : {}),
    stats: {
      filesScanned: files.length,
      uniqueQueries: locations.size,
      cacheHits,
      cacheMisses,
      compiledQueries,
    },
  };
}
