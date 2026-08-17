import { XqlCompiler } from "./compiler.ts";
import {
  catalogFingerprint,
  createManifest,
  generateCatalogJson,
  generateManifestModule,
  generateSchemaModule,
  generateTypes,
} from "./generate.ts";
import type {
  CompiledProject,
  CompileQueryOptions,
  CompilerDatabase,
  SourceDiagnostic,
  SourceQuery,
} from "./types.ts";

export async function compileProject(options: {
  readonly database: CompilerDatabase;
  readonly sources: readonly SourceQuery[];
  readonly diagnostics?: readonly SourceDiagnostic[];
  readonly compiler?: CompileQueryOptions;
}): Promise<CompiledProject> {
  const compiler = new XqlCompiler(options.database, options.compiler);
  const catalog = await compiler.catalog();
  const unique = new Map(options.sources.map((source) => [source.source, source]));
  const queries = [];
  for (const source of unique.values()) queries.push(await compiler.compile(source.source));
  return {
    postgresVersion: catalog.postgresVersion,
    catalog,
    queries,
    diagnostics: [...(options.diagnostics ?? [])],
  };
}

export function generateProjectArtifacts(project: CompiledProject, moduleName = "xql") {
  const manifest = createManifest(project.postgresVersion, project.queries);
  return {
    manifest,
    catalogFingerprint: catalogFingerprint(project.catalog),
    types: generateTypes(project.queries, moduleName),
    manifestModule: generateManifestModule(manifest, moduleName),
    schemaModule: generateSchemaModule(project.catalog, moduleName),
    catalogJson: generateCatalogJson(project.catalog),
  };
}
