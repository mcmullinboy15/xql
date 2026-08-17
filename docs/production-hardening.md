# Production Hardening Invariants

This document turns XQL's production-readiness audit into invariants that code and tests can enforce.

## SQL integrity

**Invariant:** XQL must never change user SQL except for its own structural fragment wrappers and named parameter placeholders.

Execution must preserve:

- whitespace, including whitespace inside string literals;
- comments;
- quoted identifiers;
- dollar-quoted strings;
- PostgreSQL casts;
- repeated parameter placement semantics.

`test/hardening.test.ts` contains golden coverage for the parameter lexer and execution text.

## PostgreSQL semantic authority

**Invariant:** compiled queries use PostgreSQL's parser and a PostgreSQL-derived catalog.

The compiler may interpret the PostgreSQL AST to derive TypeScript/runtime metadata, but it must not replace PostgreSQL's grammar with a second grammar.

Unsupported semantic analysis must produce an explicit compiler diagnostic rather than a plausible fallback type.

## No fake type safety

**Invariant:** when XQL cannot infer a parameter type, normal `xql()` usage must require an explicit type context/cast.

The legacy exported `ParamsOfQuery` helper remains available as low-level machinery for compatibility, but the public call signature applies strict parameter inference.

Compiled mode applies the same rule while analyzing PostgreSQL `$n` AST nodes.

## Aggregate correctness

**Invariant:** aggregate results follow PostgreSQL's result-type and nullability rules, not the JavaScript type of their input column.

Examples:

- `sum(int4)` -> PostgreSQL `int8` -> XQL `bigint | null`;
- `sum(int8)` -> PostgreSQL `numeric` -> XQL `string | null`;
- `avg(int4)` -> PostgreSQL `numeric` -> XQL `string | null`;
- `avg(float8)` -> PostgreSQL `float8` -> XQL `number | null`;
- an explicit cast changes the scalar type but does not erase aggregate nullability.

## Join correctness

**Invariant:** identifiers in JOIN predicates are validated with the same seriousness as identifiers in WHERE/ORDER/GROUP clauses.

The legacy path includes an independent JOIN-reference validation pass. The compiler resolves JOIN expressions directly from PostgreSQL AST nodes and applies LEFT/RIGHT/FULL relation nullability before deriving output columns.

## Schema authority

**Invariant:** production compiler catalogs are generated from PostgreSQL, not maintained by hand.

`xql schema pull` produces `.xql/catalog.json`; `xql schema verify` makes drift detectable in CI.

A generated `defineSchema()` module is a compatibility artifact, not the source of truth.

## Runtime parsing budget

**Invariant:** an exact legacy query is prepared once per `createXql()` instance.

Compiled queries perform no runtime SQL semantic parsing. Their validators come from the compiler manifest.

## Validation policy

Strict row validation is the default. `validation: "trusted"` exists only as an explicit performance escape hatch for controlled paths.

A service should benchmark strict validation before choosing trusted mode, especially for large analytical result sets.

## Operational boundaries

XQL is not a connection pool. The adapter owns database transport and may expose:

- cancellation (`AbortSignal`);
- timeout metadata;
- prepared-statement/tracing names;
- streaming/cursors;
- transactions.

XQL forwards those capabilities and keeps row validation/query metadata consistent.

## Observability

`onQuery` emits start/success/error events with SQL, bound values, compiled/legacy mode, optional query name and measured duration.

Applications decide how to redact values and where to send traces/logs.

## Distribution

Published artifacts come from `dist/` with explicit package exports and a compiler subpath. PGlite remains development/test-only. Compiler database/parser integrations are optional peers so installing the runtime does not pull a PostgreSQL parser or driver into every service.

## Differential testing

The differential suite generates deterministic valid and invalid queries and requires XQL's construction-time behavior to agree with PostgreSQL/PGlite.

Increase the corpus for soak/nightly testing with:

```bash
XQL_DIFFERENTIAL_SEEDS=2500 npm run test:differential
```

Because each seed currently emits four variants, that setting exercises 10,000 generated cases.

## Type-performance testing

The 25k-query benchmark exists as an architectural gate. Changes to the type-level parser or generated registry should be evaluated against baseline, legacy and compiled curves rather than judged from a small repository alone.
