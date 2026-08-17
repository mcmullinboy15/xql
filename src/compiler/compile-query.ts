import { rewriteNamedParams, stripXqlMarkers } from "../runtime/bind.ts";
import type { CompiledQueryArtifact } from "../runtime/compiled.ts";
import { analyzePostgresStatement } from "./analyze.ts";
import { parsePostgres } from "./parser.ts";
import {
  XqlCompilerError,
  type CompilerCatalog,
  type PostgresParser,
} from "./types.ts";

/**
 * Compiles one exact xql() literal. PostgreSQL's parser owns syntax; XQL's
 * catalog analyzer owns query output/parameter semantics; the runtime consumes
 * only the resulting artifact.
 */
export async function compileQuery(
  source: string,
  catalog: CompilerCatalog,
  parser?: PostgresParser,
): Promise<CompiledQueryArtifact> {
  const sql = stripXqlMarkers(source);
  const rewritten = rewriteNamedParams(sql);
  const parsed = await parsePostgres(rewritten.text, parser);
  if (parsed.stmts.length !== 1)
    throw new XqlCompilerError({
      code: "XQL_UNSUPPORTED_SQL",
      message: `xql() must contain exactly one PostgreSQL statement; found ${parsed.stmts.length}`,
    });

  const analyzed = analyzePostgresStatement(parsed.stmts[0], catalog);
  const params = rewritten.names.map((name, index) => {
    const inferred = analyzed.paramsByNumber.get(index + 1);
    if (inferred === undefined)
      throw new XqlCompilerError({
        code: "XQL_UNRESOLVED_PARAM",
        message: `cannot infer the type of parameter :${name}; compare it to a typed expression or add an explicit cast such as :${name}::text`,
      });
    return { name, ...inferred };
  });

  return {
    source,
    sql,
    kind: analyzed.kind,
    columns: analyzed.columns,
    params,
    ...(parsed.version !== undefined ? { postgresVersion: parsed.version } : {}),
  };
}
