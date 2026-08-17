import { XqlCompilerError, type ParsedPostgresResult, type PostgresParser } from "./types.ts";

/**
 * Loads libpg-query lazily so the runtime package stays driver-agnostic. The
 * package is a WASM build of PostgreSQL's own parser source. Compiler users
 * should install `libpg-query` alongside xql.
 */
export async function loadPostgresParser(): Promise<PostgresParser> {
  const moduleName = "libpg-query";
  try {
    const mod = (await import(moduleName)) as {
      parse?: (sql: string) => Promise<ParsedPostgresResult> | ParsedPostgresResult;
      default?: { parse?: (sql: string) => Promise<ParsedPostgresResult> | ParsedPostgresResult };
    };
    const parse = mod.parse ?? mod.default?.parse;
    if (parse === undefined) throw new Error("module does not export parse()");
    return {
      async parse(sql: string) {
        return await parse(sql);
      },
    };
  } catch (cause) {
    throw new XqlCompilerError({
      code: "XQL_PARSE_ERROR",
      message: `XQL compiler requires the real PostgreSQL parser. Install libpg-query (npm i -D libpg-query). ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
}

export async function parsePostgres(
  sql: string,
  parser?: PostgresParser,
): Promise<ParsedPostgresResult> {
  const actual = parser ?? await loadPostgresParser();
  try {
    return await actual.parse(sql);
  } catch (cause) {
    throw new XqlCompilerError({
      code: "XQL_PARSE_ERROR",
      message: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
