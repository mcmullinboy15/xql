import type { SchemaDef } from "../schema.ts";
import type { CompiledQueryDescriptor } from "../compiled.ts";

export interface DescribeQueryResult {
  readonly queryParams: readonly { readonly dataTypeID: number }[];
  readonly resultFields: readonly { readonly name: string; readonly dataTypeID: number }[];
}

export interface CompilerDatabase {
  describeQuery(query: string): Promise<DescribeQueryResult>;
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ): Promise<{ readonly rows: readonly T[] }>;
  exec?(query: string): Promise<unknown>;
  close?(): Promise<void>;
}

export interface PgTypeInfo {
  readonly oid: number;
  readonly schema: string;
  readonly name: string;
  readonly kind: string;
  readonly elementOid: number;
  readonly baseOid: number;
  readonly enumValues: readonly string[];
}

export interface CatalogColumn {
  readonly schema: string;
  readonly table: string;
  readonly name: string;
  readonly ordinal: number;
  readonly typeOid: number;
  readonly nullable: boolean;
}

export interface CatalogSnapshot {
  readonly postgresVersion: string;
  readonly types: readonly PgTypeInfo[];
  readonly columns: readonly CatalogColumn[];
}

export interface SourceQuery {
  readonly source: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

export interface SourceDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface CompileQueryOptions {
  readonly schema?: SchemaDef;
  /** `false` preserves XQL's historical non-null parameter API. */
  readonly allowNullParameters?: boolean;
  /** Conservative is sound for all PostgreSQL syntax; legacy reuses the old parser when possible. */
  readonly nullability?: "conservative" | "legacy";
}

export interface CompiledProject {
  readonly postgresVersion: string;
  readonly catalog: CatalogSnapshot;
  readonly queries: readonly CompiledQueryDescriptor[];
  readonly diagnostics: readonly SourceDiagnostic[];
}
