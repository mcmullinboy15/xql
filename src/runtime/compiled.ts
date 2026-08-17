import { z } from "zod";
import { codecForSqlType, type Codec } from "../schema.ts";

export interface CompiledColumn {
  readonly name: string;
  readonly sqlType: string;
  readonly nullable: boolean;
  readonly enumValues?: readonly string[];
}

export interface CompiledParam {
  readonly name: string;
  readonly sqlType: string;
  readonly nullable: boolean;
}

export interface CompiledQueryArtifact {
  /** Exact literal value passed to xql(), including XQL fragment markers. */
  readonly source: string;
  /** Marker-free SQL. Named parameters are kept for the normal runtime binder. */
  readonly sql: string;
  readonly kind: "select" | "insert" | "update" | "delete";
  readonly columns: readonly CompiledColumn[];
  readonly params: readonly CompiledParam[];
  /** PostgreSQL parser version used by the compiler, when available. */
  readonly postgresVersion?: number;
}

export interface CompiledManifest {
  readonly version: 1;
  readonly queries: Readonly<Record<string, CompiledQueryArtifact>>;
}

export function codecForCompiledColumn(column: CompiledColumn): Codec<unknown> {
  if (column.enumValues !== undefined && column.enumValues.length > 0) {
    const [first, ...rest] = column.enumValues;
    const codec = z.enum([first!, ...rest]);
    return column.nullable ? codec.nullable() : codec;
  }
  return codecForSqlType(column.sqlType, column.nullable);
}

export function rowSchemaFromArtifact(
  artifact: CompiledQueryArtifact,
): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, Codec<unknown>> = {};
  for (const column of artifact.columns) shape[column.name] = codecForCompiledColumn(column);
  return z.object(shape);
}
