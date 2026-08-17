export { analyzePostgresStatement } from "./analyze.ts";
export {
  COLUMNS_SQL,
  ENUMS_SQL,
  diffCatalog,
  emitSchemaModule,
  pullCatalog,
  type CatalogDiff,
} from "./catalog.ts";
export { compileQuery } from "./compile-query.ts";
export { emitGeneratedModule } from "./emit.ts";
export { extractQueriesFromSource, type ExtractResult } from "./extract.ts";
export { loadPostgresParser, parsePostgres } from "./parser.ts";
export {
  compileProject,
  type CompileProjectOptions,
  type CompileProjectResult,
} from "./project.ts";
export {
  XqlCompilerError,
  type AnalyzedStatement,
  type CatalogAdapter,
  type CatalogColumn,
  type CatalogTable,
  type CompilerCatalog,
  type CompilerDiagnostic,
  type ExtractedQuery,
  type ParsedPostgresResult,
  type PostgresParser,
} from "./types.ts";
