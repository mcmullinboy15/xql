//! End-to-end checker tests: compile a source string and assert on the
//! diagnostics produced. These are the Stage 1 analogue of xql's `*.type.ts`
//! assertions — a program either checks clean or reports a specific error.

use rusttsc::diagnostics::Code;
use rusttsc::Compilation;

fn codes(src: &str) -> Vec<Code> {
    Compilation::compile("test.ts", src)
        .diagnostics
        .iter()
        .map(|d| d.code)
        .collect()
}

fn messages(src: &str) -> Vec<String> {
    Compilation::compile("test.ts", src)
        .diagnostics
        .iter()
        .map(|d| d.message.clone())
        .collect()
}

fn assert_clean(src: &str) {
    let diags = Compilation::compile("test.ts", src).diagnostics;
    assert!(
        diags.is_empty(),
        "expected no diagnostics, got: {:?}",
        diags.iter().map(|d| &d.message).collect::<Vec<_>>()
    );
}

#[test]
fn clean_program_has_no_diagnostics() {
    assert_clean(
        r#"
        const x: number = 1;
        let y = "hello";
        function greet(name: string): string {
            return name + "!";
        }
        greet(y);
        "#,
    );
}

#[test]
fn annotation_mismatch_is_reported() {
    assert_eq!(
        codes(r#"const x: number = "hi";"#),
        vec![Code::NotAssignable]
    );
    assert_eq!(
        messages(r#"const x: number = "hi";"#),
        vec!["Type '\"hi\"' is not assignable to type 'number'.".to_string()]
    );
}

#[test]
fn unknown_name_is_reported() {
    assert_eq!(codes("const x = missing;"), vec![Code::CannotFindName]);
}

#[test]
fn use_before_declaration_does_not_resolve() {
    // `y` is used before its `let`, so it must not resolve.
    assert_eq!(codes("const x = y; let y = 1;"), vec![Code::CannotFindName]);
}

#[test]
fn functions_are_hoisted() {
    // Calling `f` before its declaration is fine — functions hoist.
    assert_clean(
        r#"
        const r = f(1);
        function f(n: number): number { return n + 1; }
        "#,
    );
}

#[test]
fn wrong_arity_is_reported() {
    assert_eq!(
        codes("function f(a: number): number { return a; } f();"),
        vec![Code::WrongArgCount]
    );
}

#[test]
fn argument_type_is_checked() {
    assert_eq!(
        codes(r#"function f(a: number): number { return a; } f("no");"#),
        vec![Code::ArgNotAssignable]
    );
}

#[test]
fn calling_a_non_function_is_reported() {
    assert_eq!(codes("const x = 1; x();"), vec![Code::NotCallable]);
}

#[test]
fn return_type_is_checked() {
    assert_eq!(
        codes(r#"function f(): number { return "no"; }"#),
        vec![Code::NotAssignable]
    );
}

#[test]
fn union_annotation_accepts_either_member() {
    assert_clean(
        r#"
        let a: number | string = 1;
        let b: number | string = "two";
        "#,
    );
    assert_eq!(
        codes("let a: number | string = true;"),
        vec![Code::NotAssignable]
    );
}

#[test]
fn const_keeps_literal_let_widens() {
    // A const string literal flows into a narrower literal slot...
    assert_clean(r#"const s = "x"; const t: "x" = s;"#);
    // ...but a let has been widened to `string`, so it no longer fits.
    assert_eq!(
        codes(r#"let s = "x"; const t: "x" = s;"#),
        vec![Code::NotAssignable]
    );
}

#[test]
fn redeclaration_is_reported() {
    assert_eq!(codes("let x = 1; let x = 2;"), vec![Code::Redeclaration]);
}

#[test]
fn block_scopes_are_independent() {
    // `inner` declared inside the function body is not visible at the top level.
    assert_eq!(
        codes("function f(): number { let inner = 1; return inner; } const y = inner;"),
        vec![Code::CannotFindName]
    );
}

#[test]
fn syntax_error_recovers() {
    // A malformed statement should report, and the following good statement
    // should still be checked (so the unknown name is also found).
    let cs = codes("let = ; const z = nope;");
    assert!(cs.contains(&Code::SyntaxError));
    assert!(cs.contains(&Code::CannotFindName));
}

// ---- generics, aliases, and conditional types -----------------------------

#[test]
fn generic_alias_instantiates() {
    assert_clean(r#"type Id<T> = T; const x: Id<number> = 1;"#);
    assert_eq!(
        codes(r#"type Id<T> = T; const x: Id<number> = "no";"#),
        vec![Code::NotAssignable]
    );
}

#[test]
fn conditional_type_selects_a_branch() {
    // IsNum<number> = true, so the `true` literal fits.
    assert_clean(
        r#"type IsNum<T> = T extends number ? true : false; const b: IsNum<number> = true;"#,
    );
    // IsNum<string> = false, so `true` no longer fits.
    assert_eq!(
        codes(r#"type IsNum<T> = T extends number ? true : false; const b: IsNum<string> = true;"#),
        vec![Code::NotAssignable]
    );
}

#[test]
fn wrong_type_argument_count_is_reported() {
    assert_eq!(
        codes(r#"type P<T> = T; const x: P = 1;"#),
        vec![Code::TypeArgMismatch]
    );
}

#[test]
fn unknown_type_name_is_reported() {
    assert_eq!(codes("const x: Nope = 1;"), vec![Code::CannotFindName]);
}

#[test]
fn infinitely_recursive_alias_is_bounded() {
    // `Loop<T> = Loop<T>` never reduces; the depth guard must stop it and
    // report TS2589 rather than hang.
    let cs = codes(r#"type Loop<T> = Loop<T>; const x: Loop<number> = 1;"#);
    assert!(cs.contains(&Code::ExcessiveDepth), "got: {cs:?}");
}

/// The core thesis, as an assertion: memoization turns the diamond's
/// exponential instantiation into linear work. With the cache on, each alias is
/// instantiated once (8 misses); with it off, the bottom alias alone is
/// instantiated 2^7 times.
#[test]
fn memoization_makes_diamond_linear() {
    let src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/generic-diamond.ok.ts"),
    )
    .unwrap();

    let cached = Compilation::compile_with("d.ts", &src, true);
    let uncached = Compilation::compile_with("d.ts", &src, false);

    let cached_misses = cached.resolver.stats.total_misses();
    let uncached_misses = uncached.resolver.stats.total_misses();

    // Cached: one instantiation per (alias, args) — 8 aliases, one arg each.
    assert_eq!(
        cached_misses, 8,
        "expected linear instantiation with the cache"
    );
    // Uncached: the bottom alias alone instantiates 2^7 = 128 times, so total
    // work is an order of magnitude larger.
    assert!(
        uncached_misses >= 128,
        "expected exponential instantiation without the cache, got {uncached_misses}"
    );
    assert!(
        uncached_misses > cached_misses * 10,
        "cache should cut instantiations by >10x (cached={cached_misses}, uncached={uncached_misses})"
    );
    // Every alias past the first reference is a cache hit (8 distinct
    // (alias, args) pairs → 8 unavoidable misses, 7 hits ≈ 47%).
    assert!(
        cached.resolver.stats.cache_hit_rate() > 0.4,
        "hit rate was {}",
        cached.resolver.stats.cache_hit_rate()
    );
}

/// The fixture files under `tests/fixtures/` double as runnable examples and a
/// regression corpus: `*.ok.ts` must check clean, `*.err.ts` must not.
#[test]
fn fixtures_match_their_expectation() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut checked = 0;
    for entry in std::fs::read_dir(&dir).expect("fixtures dir") {
        let path = entry.unwrap().path();
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        if !name.ends_with(".ts") {
            continue;
        }
        let src = std::fs::read_to_string(&path).unwrap();
        let comp = Compilation::compile(name.clone(), src);
        if name.ends_with(".ok.ts") {
            assert!(
                !comp.has_errors(),
                "{name} should check clean but reported:\n{}",
                comp.render_diagnostics()
            );
        } else if name.ends_with(".err.ts") {
            assert!(
                comp.has_errors(),
                "{name} should report an error but checked clean"
            );
        }
        checked += 1;
    }
    assert!(checked > 0, "no fixtures found in {}", dir.display());
}
