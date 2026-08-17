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
  type ExtractedQuery,
  type PostgresParser,
} from "./types.ts";

const COMPILER_CACHE_VERSION = 1 as const;

interface ArtifactCache {
  readonly version: typeof COMPILER_CACHE_VERSION;
  readonly catalogHash: string;
  readonly moduleName: string;
  readonly outFileKey: string;
  readonly generatedStamp: string;
  readonly artifacts: readonly CompiledQueryArtifact[];
}

interface ExtractCacheEntry {
  readonly path: string;
  readonly stamp: string;
  readonly queries: readonly ExtractedQuery[];
  readonly diagnostics: readonly CompilerDiagnostic[];
}

interface ExtractCache {
  readonly version: typeof COMPILER_CACHE_VERSION;
  readonly calleeKey: string;
  readonly files: readonly ExtractCacheEntry[];
}

interface ArtifactCacheState {
  readonly artifacts: Map<string, CompiledQueryArtifact>;
  readonly moduleName?: string;
  readonly outFileKey?: string;
  readonly generatedStamp?: string;
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
  /** Persistent artifact/extraction cache. Defaults to `.xql/cache.json`; set false to disable. */
  readonly cache?: boolean;
  readonly cacheFile?: string;
}

export interface CompileProjectStats {
  readonly filesScanned: number;
  readonly filesRead: number;
  readonly fileCacheHits: number;
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

async function stamp(file: string): Promise<string> {
  const stat = await fs.stat(file, { bigint: true });
  return `${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

async function optionalStamp(file: string): Promise<string | undefined> {
  try {
    return await stamp(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function readArtifactCache(
  file: string,
  expectedCatalogHash: string,
): Promise<ArtifactCacheState> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ArtifactCache>;
    if (
      parsed.version !== COMPILER_CACHE_VERSION ||
      parsed.catalogHash !== expectedCatalogHash ||
      !Array.isArray(parsed.artifacts)
    ) {
      return { artifacts: new Map() };
    }
    return {
      artifacts: new Map(
        parsed.artifacts
          .filter((artifact): artifact is CompiledQueryArtifact =>
            artifact !== null &&
            typeof artifact === "object" &&
            typeof (artifact as CompiledQueryArtifact).source === "string"
          )
          .map((artifact) => [artifact.source, artifact]),
      ),
      ...(typeof parsed.moduleName === "string" ? { moduleName: parsed.moduleName } : {}),
      ...(typeof parsed.outFileKey === "string" ? { outFileKey: parsed.outFileKey } : {}),
      ...(typeof parsed.generatedStamp === "string" ? { generatedStamp: parsed.generatedStamp } : {}),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return { artifacts: new Map() };
    throw error;
  }
}

async function readExtractCache(
  file: string,
  expectedCalleeKey: string,
): Promise<Map<string, ExtractCacheEntry>> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Partial<ExtractCache>;
    if (
      parsed.version !== COMPILER_CACHE_VERSION ||
      parsed.calleeKey !== expectedCalleeKey ||
      !Array.isArray(parsed.files)
    ) {
      return new Map();
    }
    return new Map(
      parsed.files
        .filter((entry): entry is ExtractCacheEntry =>
          entry !== null && typeof entry === "object" && typeof (entry as ExtractCacheEntry).path === "string"
        )
        .map((entry) => [entry.path, entry]),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || error instanceof SyntaxError) return new Map();
    throw error;
  }
}

async function writeFile(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
}

export async function compileProject(
  options: CompileProjectOptions,
): Promise<CompileProjectResult> {
  const root = path.resolve(options.root);
  const files: string[] = [];
  await walk(root, files);

  const useCache = options.cache !== false;
  const resolvedCacheFile = path.resolve(root, options.cacheFile ?? ".xql/cache.json");
  const extractCacheFile = `${resolvedCacheFile}.files`;
  const calleeKey = JSON.stringify(options.calleeNames ?? null);
  const cachedExtract = useCache
    ? await readExtractCache(extractCacheFile, calleeKey)
    : new Map<string, ExtractCacheEntry>();

  const diagnostics: CompilerDiagnostic[] = [];
  const locations = new Map<string, { file: string; line: number; column: number }>();
  const extractEntries: ExtractCacheEntry[] = [];
  let filesRead = 0;
  let fileCacheHits = 0;
  let extractCacheDirty = cachedExtract.size !== files.length;

  for (const file of files) {
    const relative = path.relative(root, file);
    const fileStamp = await stamp(file);
    const cached = cachedExtract.get(relative);
    let entry: ExtractCacheEntry;

    if (cached !== undefined && cached.stamp === fileStamp) {
      entry = cached;
      fileCacheHits++;
    } else {
      const text = await fs.readFile(file, "utf8");
      filesRead++;
      extractCacheDirty = true;
      const extracted = extractQueriesFromSource(text, relative, options.calleeNames);
      entry = {
        path: relative,
        stamp: fileStamp,
        queries: extracted.queries,
        diagnostics: extracted.diagnostics,
      };
    }
    extractEntries.push(entry);

    for (const diagnostic of entry.diagnostics) {
      diagnostics.push(diagnostic);
      if (options.compiledOnly) throw new XqlCompilerError(diagnostic);
    }
    for (const query of entry.queries)
      if (!locations.has(query.source)) locations.set(query.source, query);
  }

  const moduleName = options.moduleName ?? "xql";
  const outFile = path.resolve(root, options.outFile ?? ".xql/generated.ts");
  const outFileKey = path.relative(root, outFile);
  const hash = catalogHash(options.catalog);
  const artifactState = useCache
    ? await readArtifactCache(resolvedCacheFile, hash)
    : { artifacts: new Map<string, CompiledQueryArtifact>() };

  const artifacts: CompiledQueryArtifact[] = [];
  let cacheHits = 0;
  let cacheMisses = 0;
  let compiledQueries = 0;
  let parser = options.parser;

  for (const [source, location] of locations) {
    const hit = artifactState.artifacts.get(source);
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

  const artifactSetUnchanged =
    compiledQueries === 0 &&
    cacheHits === locations.size &&
    artifactState.artifacts.size === artifacts.length &&
    artifactState.moduleName === moduleName &&
    artifactState.outFileKey === outFileKey;
  const currentGeneratedStamp = artifactSetUnchanged ? await optionalStamp(outFile) : undefined;
  const canReuseGenerated =
    artifactSetUnchanged &&
    currentGeneratedStamp !== undefined &&
    currentGeneratedStamp === artifactState.generatedStamp;

  let generatedStamp = currentGeneratedStamp;
  if (!canReuseGenerated) {
    await writeFile(outFile, emitGeneratedModule(artifacts, moduleName));
    generatedStamp = await stamp(outFile);
  }

  if (useCache) {
    if (!artifactSetUnchanged || !canReuseGenerated) {
      const cache: ArtifactCache = {
        version: COMPILER_CACHE_VERSION,
        catalogHash: hash,
        moduleName,
        outFileKey,
        generatedStamp: generatedStamp!,
        artifacts,
      };
      await writeFile(resolvedCacheFile, JSON.stringify(cache) + "\n");
    }
    if (extractCacheDirty) {
      const extractCache: ExtractCache = {
        version: COMPILER_CACHE_VERSION,
        calleeKey,
        files: extractEntries,
      };
      await writeFile(extractCacheFile, JSON.stringify(extractCache) + "\n");
    }
  }

  return {
    artifacts,
    diagnostics,
    outFile,
    ...(useCache ? { cacheFile: resolvedCacheFile } : {}),
    stats: {
      filesScanned: files.length,
      filesRead,
      fileCacheHits,
      uniqueQueries: locations.size,
      cacheHits,
      cacheMisses,
      compiledQueries,
    },
  };
}
