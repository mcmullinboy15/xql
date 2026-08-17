import { createHash } from "node:crypto";
import { prepare } from "../runtime/parse.ts";
import type {
  CompiledPgType,
  CompiledQueryColumn,
  CompiledQueryDescriptor,
  CompiledQueryParam,
} from "../compiled.ts";
import { rewriteNamedParams, stripXqlMarkers } from "../sql.ts";
import {
  catalogToSchema,
  resolvePgType,
  snapshotCatalog,
} from "./postgres.ts";
import type {
  CatalogSnapshot,
  CompileQueryOptions,
  CompilerDatabase,
  PgTypeInfo,
} from "./types.ts";

function acceptsNull(codec: { safeParse(value: unknown): { success: boolean } }): boolean {
  return codec.safeParse(null).success;
}

function typeMap(catalog: CatalogSnapshot): ReadonlyMap<number, PgTypeInfo> {
  return new Map(catalog.types.map((type) => [type.oid, type]));
}

function withType<T extends object>(type: CompiledPgType, value: T): T & CompiledPgType {
  return { ...value, ...type };
}

export class XqlCompiler {
  #catalog?: CatalogSnapshot;

  constructor(
    readonly database: CompilerDatabase,
    readonly options: CompileQueryOptions = {},
  ) {}

  async catalog(): Promise<CatalogSnapshot> {
    return (this.#catalog ??= await snapshotCatalog(this.database));
  }

  async compile(source: string): Promise<CompiledQueryDescriptor> {
    const sql = stripXqlMarkers(source);
    const rewritten = rewriteNamedParams(sql);
    const catalog = await this.catalog();
    const types = typeMap(catalog);

    // PostgreSQL parses and semantically analyzes the statement against the
    // loaded catalog without executing it. This is the compiler's authority.
    const described = await this.database.describeQuery(rewritten.sql);
    if (described.queryParams.length !== rewritten.names.length) {
      throw new Error(
        `PostgreSQL described ${described.queryParams.length} parameters, ` +
          `but XQL found ${rewritten.names.length} named parameters`,
      );
    }

    let legacyColumns: readonly { name: string; zod: { safeParse(value: unknown): { success: boolean } } }[] | undefined;
    if (this.options.nullability === "legacy") {
      const schema = this.options.schema ?? catalogToSchema(catalog);
      try {
        const legacy = prepare(schema, source);
        if (
          legacy.columns.length === described.resultFields.length &&
          legacy.columns.every((column, index) => column.name === described.resultFields[index]?.name)
        ) legacyColumns = legacy.columns;
      } catch {
        // PostgreSQL remains authoritative. Unsupported legacy syntax simply means
        // nullability falls back to the conservative (nullable) representation.
      }
    }

    const columns: CompiledQueryColumn[] = described.resultFields.map((field, index) =>
      withType(resolvePgType(field.dataTypeID, types), {
        name: field.name,
        nullable: legacyColumns ? acceptsNull(legacyColumns[index]!.zod) : true,
      }),
    );

    const duplicate = columns.find(
      (column, index) => columns.findIndex((candidate) => candidate.name === column.name) !== index,
    );
    if (duplicate) {
      throw new Error(
        `query returns duplicate column name "${duplicate.name}"; object-row drivers would lose data — alias the columns uniquely`,
      );
    }

    const params: CompiledQueryParam[] = described.queryParams.map((param, index) =>
      withType(resolvePgType(param.dataTypeID, types), {
        name: rewritten.names[index]!,
        position: index + 1,
        nullable: this.options.allowNullParameters ?? false,
      }),
    );

    const fingerprint = createHash("sha256").update(source).digest("hex");

    return {
      source,
      fingerprint,
      sql,
      boundSql: rewritten.sql,
      postgresVersion: catalog.postgresVersion,
      nullability: legacyColumns ? "legacy" : "conservative",
      params,
      columns,
    };
  }
}
