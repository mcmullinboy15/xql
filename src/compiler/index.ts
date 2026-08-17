export { XqlCompiler } from "./compiler.ts";
export { rewriteNamedParams, stripXqlMarkers } from "./named-params.ts";
export {
  catalogToSchema,
  createPgliteCompilerDatabase,
  resolvePgType,
  schemaToDdl,
  snapshotCatalog,
} from "./postgres.ts";
export { extractXqlQueries } from "./source.ts";
export {
  catalogFingerprint,
  createManifest,
  generateCatalogJson,
  generateManifestModule,
  generateSchemaModule,
  generateTypes,
  typescriptTypeForPgType,
} from "./generate.ts";
export { compileProject, generateProjectArtifacts } from "./project.ts";
export type {
  CatalogColumn,
  CatalogSnapshot,
  CompiledProject,
  CompileQueryOptions,
  CompilerDatabase,
  DescribeQueryResult,
  PgTypeInfo,
  SourceDiagnostic,
  SourceQuery,
} from "./types.ts";
