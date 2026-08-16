# rusttsc

A greenfield TypeScript type-checker in Rust, built on ID-addressed arenas.

This is **not** a port of `tsc`/`tsgo`. It is a from-scratch checker whose
internal representation is chosen for the things that hurt on enormous
TypeScript codebases and pathological generic types: compact memory, cheap
immutable sharing, structural interning, memoization, and — eventually —
parallel, dependency-driven checking. Microsoft chose Go for the native
compiler precisely because they were *porting* 100 person-years of graph-heavy
architecture one-to-one. A Rust project only earns its keep by taking the other
fork: redesign the representation. That is what this is.

Stage 1 (this crate) is the walking skeleton: a real lexer, parser, binder, and
checker for a subset of TypeScript, wired end-to-end through the arenas so the
harder stages have something to grow from.

## Try it

```bash
cargo run -- check path/to/file.ts
cargo run -- check path/to/file.ts --profile-types
cargo test
```

```
$ cargo run -- check tests/fixtures/mismatch.err.ts
mismatch.err.ts:2:22 - error TS2322: Type '"8080"' is not assignable to type 'number'.
2 | const port: number = "8080";
  |                      ~~~~~~
...
Found 5 errors in mismatch.err.ts.
```

## Architecture

The classic pipeline, but every phase writes into shared arenas and every edge
is an integer id rather than an owning pointer:

```
source ──▶ Lexer ──▶ Parser ──▶ Binder ──▶ Checker ──▶ diagnostics
                       │           │           │
                       ▼           ▼           ▼
                    NodeStore   SymbolStore  TypeStore
                     (ast.rs)   (symbols.rs) (types.rs)
```

| Module           | Role                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| `span.rs`        | Byte-range spans; line/column computed only when a diagnostic renders |
| `diagnostics.rs` | `TSxxxx`-coded diagnostics + caret rendering                          |
| `lexer.rs`       | Hand-written tokenizer; keywords stay identifiers until the parser    |
| `ast.rs`         | `NodeStore` — a flat `Vec<Node>`, edges are `NodeId`                   |
| `parser.rs`      | Recursive descent with error recovery                                 |
| `types.rs`       | `TypeStore` — interned/structural types, assignability, profiling     |
| `symbols.rs`     | `SymbolStore` — arena of symbols and scopes                           |
| `binder.rs`      | Builds the scope tree, hoists functions, resolves type annotations    |
| `checker.rs`     | Infers expression types, runs the relation, emits diagnostics         |
| `program.rs`     | Ties the phases together into a `Compilation`                         |

### Why ID-arenas

The historical TypeScript checker is a heap of independently allocated objects
that point all over each other. The same information here is:

```rust
struct TypeId(u32);           // an index, not a pointer
enum Type { Number, String, Union(Vec<TypeId>), Function { .. }, .. }
struct TypeStore { types: Vec<Type>, intern: HashMap<Type, TypeId>, .. }
```

Consequences that matter at scale:

- **Interning.** Constructing the same structural type twice returns the same
  `TypeId`. Type equality is then a `u32` compare, and there is exactly one
  allocation per distinct type in the whole program. `A | B` and `B | A` are the
  same id because the union constructor canonicalizes (flatten, drop `never`,
  dedupe, sort) before interning.
- **Memoization.** The assignability relation caches `(source, target) →
  bool`. This is the checker's hottest path and the natural place to make
  type-checking *observable*.
- **One drop.** The whole type graph frees when the `TypeStore` does; no
  reference counting, no cycles to chase.

### `--profile-types`

Because construction and the relation both funnel through the store, we can
count them for free:

```
Type-system profile
──────────────────────────────
Distinct types:                 14
Type constructions:             15
  from cache (interned):         1  (6.7%)
  newly allocated:              14
Assignability checks:            7
  served from cache:             0
```

This is the seed of the feature that makes the project worth doing: once
generics and instantiation exist (Stage 2), this table becomes a per-alias
breakdown — *which* type alias cost the most instantiations, how deep recursion
went, the cache hit rate — exactly the visibility a type-level library like the
`xql` query builder in the parent repo needs when it collides with TypeScript's
instantiation budget.

## Supported subset (Stage 1)

- `let` / `const` / `var` with optional annotations and initializers
- `function` declarations with typed params and return types (hoisted)
- Blocks and lexical scoping; `return`; expression statements
- Expressions: number / string / boolean / `null` literals, identifiers, `+`,
  and calls
- Types: `number`, `string`, `boolean`, `any`, `unknown`, `never`, `void`,
  `null`, `undefined`, literal types (`"x"`, `42`, `true`), and unions
- Inference: literal types, `const` keeps literals while `let`/`var` widen,
  string-vs-number result of `+`
- Assignability: literal→base, into/out of unions, function
  variance (contravariant params, covariant return, arity)

Diagnostics implemented: TS2322, TS2345, TS2349, TS2451, TS2554, TS2304, plus
syntax errors.

## Deliberate non-goals for Stage 1

No emit, no language server, no JSX, no modules, no objects/interfaces, no
generics, no control-flow narrowing, no incremental cache. These are the
substance of the later stages, not oversights. In particular there is no
control-flow analysis, so a missing `return` is not yet reported.

## Roadmap

1. **`rusttsc check` skeleton — done.** Parse → bind → check a subset, real
   diagnostics, arena representation, profiling counters.
2. **Type-system depth.** Objects/interfaces, generics + instantiation,
   conditional / mapped / template-literal types, narrowing, overloads. This is
   where a serious checker succeeds or dies — and where `--profile-types` turns
   into a per-alias instantiation report.
3. **Differential tester.** Run generated programs through both `tsc`/`tsgo`
   and `rusttsc`, diff the diagnostics, and minimize every discrepancy into a
   regression case. TypeScript itself is the oracle; the north star is
   `rusttsc check` matching `tsc --noEmit` on a shared corpus.
4. **Optimize.** Only after compatibility is high: parallel parse/bind,
   dependency-driven checking, incremental invalidation. A checker that is 30×
   faster and 99.4% compatible is unusable; 1.2× faster and 99.999% compatible
   is something you can iterate on.
