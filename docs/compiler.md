# XQL Compiler Architecture

XQL's public contract stays deliberately small:

```ts
const rows = await xql(
  `select id, title from product where account_id = :accountId`,
  { accountId },
);
```

The industrial path changes **who proves that SQL is safe**, not how application code writes SQL.

```text
                 XQL source
                     │
                     ▼
              XQL compiler
                     │
             PostgreSQL parser
                     │
          PostgreSQL catalog
                     │
          ┌──────────┴──────────┐
          ▼                     ▼
   generated TS types     runtime manifest
          │                     │
          └──────────┬──────────┘
                     ▼
                 XQL runtime
                     │
                     ▼
                 PostgreSQL
```

## Why a compiler

The original XQL prototype intentionally proves that a useful amount of SQL can be understood from a TypeScript literal. That remains valuable as a zero-build compatibility mode. It is not a good place to duplicate PostgreSQL's complete grammar and semantic rules forever.

The compiler therefore has four responsibilities:

1. **Use PostgreSQL's parser.** `libpg-query` exposes an AST produced from PostgreSQL parser sources. XQL does not invent another SQL grammar for compiled queries.
2. **Use PostgreSQL as schema authority.** `xql schema pull` introspects the database catalog instead of asking developers to maintain a parallel handwritten schema.
3. **Resolve query semantics once.** Output columns, SQL types, join nullability and named parameter types are resolved at compile time and written to an artifact.
4. **Generate concrete TypeScript.** The generated registry maps the exact `xql()` literal to a concrete `GeneratedQueryInfo<Row, Params>`. The public `Xql` type checks this registry before invoking the legacy type-level parser.

That last point is the scale mechanism. In compiled mode, TypeScript does not repeatedly execute the SQL parser expressed in conditional/template-literal types for every query during every application typecheck.

## Commands

Install the compiler parser when using compile mode:

```bash
npm install --save-dev libpg-query
```

If catalog pull/verification uses the built-in CLI PostgreSQL adapter, also install `pg`:

```bash
npm install --save-dev pg
```

Both packages are optional peers. Applications using only XQL's runtime do not need either one.

### Pull the database catalog

```bash
DATABASE_URL=postgres://... xql schema pull
```

Defaults:

- schemas: `public`
- catalog: `.xql/catalog.json`

An optional legacy `defineSchema()` mirror can be generated too:

```bash
xql schema pull --schema-out src/xql.schema.ts
```

The JSON catalog is the compiler input. The generated TypeScript schema exists for compatibility with the zero-build runtime path; it is not intended to become a second source of truth.

### Verify schema drift in CI

```bash
DATABASE_URL=postgres://... xql schema verify
```

The command exits non-zero when the checked-in catalog disagrees with PostgreSQL. It reports missing tables, extra tables and changed columns.

### Compile application queries

```bash
xql compile
```

Defaults:

- project root: current directory
- catalog: `.xql/catalog.json`
- output: `.xql/generated.ts`
- module augmentation target: `xql`

The generated file contains two things:

- `GeneratedQueryRegistry` augmentation with concrete row/parameter types;
- a runtime `CompiledManifest` with column SQL types, nullability and parameter metadata.

Import the generated manifest and pass it when constructing XQL:

```ts
import { createXql } from "xql";
import { manifest } from "../.xql/generated.js";
import { schema } from "./xql.schema.js";

export const xql = createXql(schema, adapter, {
  manifest,
});
```

For a fully compiler-enforced service:

```ts
export const xql = createXql(schema, adapter, {
  manifest,
  compiledOnly: true,
});
```

Then an uncompiled query is a runtime construction error as well as something CI can reject during `xql compile --compiled-only`.

## Static extraction

The compiler currently extracts:

- plain literal `xql(`...`)` calls;
- static string constants;
- static template composition;
- reusable `xql.cols()`, `xql.from()` and `xql.where()` fragments;
- compile-time-constant `xql.and()` / `xql.or()` parts.

A runtime-dynamic template is **not** silently treated as safe. It produces `XQL_DYNAMIC_SOURCE`. Teams can either keep those calls on the legacy path or enable `--compiled-only` and make them build failures.

## Fail closed

Compiled XQL has a simple rule:

> If XQL cannot prove a PostgreSQL type or semantic rule, it says so.

Unknown output expressions require an explicit SQL cast or compiler support. Unknown parameter contexts require a typed comparison or explicit cast. Unsupported AST nodes return `XQL_UNSUPPORTED_SQL`; they do not degrade to `unknown` while pretending the query was fully checked.

Explicit SQL casts are the intended escape hatch because they remain real PostgreSQL and document the contract in the query itself.

## Runtime contract

A compiled runtime does not parse SQL again. It looks up the exact source literal in the manifest and constructs the row validator from compiler-emitted SQL type metadata.

Prepared artifacts are cached by exact query source. The only SQL transformations before the adapter are:

1. removing XQL's own structural fragment wrappers; and
2. replacing named `:params` with PostgreSQL `$n` placeholders.

Both operations are SQL-lexing-aware. Strings, quoted identifiers, dollar-quoted strings and comments are preserved byte-for-byte.

## Legacy mode

The type-level/runtime parser remains as a compatibility and experimentation path:

```ts
createXql(schema, adapter)
```

It now fails more conservatively than the prototype:

- JOIN references are validated;
- SUM/AVG follow PostgreSQL result-type rules;
- unresolved parameter contexts require explicit casts at normal `xql()` call sites;
- prepared schemas are cached;
- SQL is not whitespace-normalized before execution.

The long-term source of semantic truth is still the compiler. The legacy parser should not grow into a second implementation of all PostgreSQL behavior.

## Measuring the crossover point

Run:

```bash
npm run bench:types
```

The benchmark creates equivalent projects containing 100, 1,000, 5,000, 10,000 and 25,000 unique queries in three modes:

- **baseline** — return/parameter types are explicitly hardened;
- **legacy** — XQL derives every query through type-level parsing;
- **compiled** — exact query literals resolve through `GeneratedQueryRegistry`.

For each point it records:

- cold typecheck wall time;
- warm incremental typecheck;
- one-file edit/invalidation time;
- TypeScript check/total time;
- peak reported memory;
- type count;
- generic instantiation count.

Results are written to `.xql-bench/results.json`.

A quick subset can be run with:

```bash
npm run bench:types -- --counts 100,1000 --modes baseline,legacy,compiled
```

This benchmark—not intuition—should decide how aggressively large applications move from legacy inference to compiled query artifacts.
