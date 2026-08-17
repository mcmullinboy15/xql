import type { CompiledColumn, CompiledParam, CompiledQueryArtifact } from "../runtime/compiled.ts";

export interface CatalogColumn {
  readonly name: string;
  readonly sqlType: string;
  readonly nullable: boolean;
  readonly enumValues?: readonly string[];
}

export interface CatalogTable {
  readonly schema: string;
  readonly name: string;
  readonly columns: Readonly<Record<string, CatalogColumn>>;
}

export interface CompilerCatalog {
  readonly version: 1;
  readonly searchPath: readonly string[];
  /** Keys are schema-qualified (`public.product`). */
  readonly tables: Readonly<Record<string, CatalogTable>>;
}

export interface CatalogQueryResult<Row = Record<string, unknown>> {
  readonly rows: readonly Row[];
}

/** Minimal database surface needed for schema pull; any Postgres driver can adapt to it. */
export interface CatalogAdapter {
  query<Row = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[],
  ): Promise<Row[] | CatalogQueryResult<Row>>;
}

export interface ParsedPostgresResult {
  readonly version?: number;
  readonly stmts: readonly unknown[];
}

export interface PostgresParser {
  parse(sql: string): Promise<ParsedPostgresResult>;
}

export interface CompilerDiagnostic {
  readonly code:
    | "XQL_UNSUPPORTED_SQL"
    | "XQL_UNKNOWN_TABLE"
    | "XQL_UNKNOWN_COLUMN"
    | "XQL_AMBIGUOUS_COLUMN"
    | "XQL_UNRESOLVED_PARAM"
    | "XQL_PARAM_TYPE_CONFLICT"
    | "XQL_DUPLICATE_OUTPUT"
    | "XQL_DYNAMIC_SOURCE"
    | "XQL_PARSE_ERROR";
  readonly message: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

export class XqlCompilerError extends Error {
  override name = "XqlCompilerError";
  readonly diagnostic: CompilerDiagnostic;

  constructor(diagnostic: CompilerDiagnostic) {
    super(diagnostic.message);
    this.diagnostic = diagnostic;
  }
}

export interface ExtractedQuery {
  readonly source: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface AnalyzedStatement {
  readonly kind: CompiledQueryArtifact["kind"];
  readonly columns: readonly CompiledColumn[];
  readonly paramsByNumber: ReadonlyMap<number, Omit<CompiledParam, "name">>;
}
