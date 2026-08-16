//! The `rusttsc` command-line entry point.
//!
//! ```text
//! rusttsc check <file.ts> [--profile-types]
//! ```
//!
//! `check` runs the pipeline and prints diagnostics, exiting non-zero if any
//! were produced (so it drops straight into a CI gate). `--profile-types`
//! additionally prints the type-system work report — the observability angle
//! that motivated a greenfield representation in the first place.

use rusttsc::typeres::InstantiationStats;
use rusttsc::types::TypeStore;
use rusttsc::Compilation;
use std::process::ExitCode;
use std::time::Instant;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("check") => run_check(&args[1..]),
        Some("--help") | Some("-h") | None => {
            print_usage();
            ExitCode::SUCCESS
        }
        Some(other) => {
            eprintln!("rusttsc: unknown command '{other}'\n");
            print_usage();
            ExitCode::FAILURE
        }
    }
}

fn print_usage() {
    eprintln!(
        "rusttsc — a greenfield TypeScript checker (Stage 1)\n\n\
         USAGE:\n    \
         rusttsc check <file.ts> [--profile-types] [--no-instantiation-cache]\n\n\
         OPTIONS:\n    \
         --profile-types              print type-system work (instantiations, cache hits)\n    \
         --no-instantiation-cache     disable the instantiation memo (shows the\n    \
         \x20                            exponential work memoization avoids)\n    \
         -h, --help                   show this help"
    );
}

fn run_check(rest: &[String]) -> ExitCode {
    let mut profile = false;
    let mut cache_enabled = true;
    let mut path: Option<&str> = None;
    for arg in rest {
        match arg.as_str() {
            "--profile-types" => profile = true,
            "--no-instantiation-cache" => cache_enabled = false,
            other if other.starts_with('-') => {
                eprintln!("rusttsc: unknown option '{other}'");
                return ExitCode::FAILURE;
            }
            other => path = Some(other),
        }
    }

    let Some(path) = path else {
        eprintln!("rusttsc: expected a file to check, e.g. `rusttsc check foo.ts`");
        return ExitCode::FAILURE;
    };

    let source = match std::fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("rusttsc: cannot read '{path}': {e}");
            return ExitCode::FAILURE;
        }
    };

    let start = Instant::now();
    let compilation = Compilation::compile_with(path, source, cache_enabled);
    let elapsed = start.elapsed();

    let text = compilation.render_diagnostics();
    if !text.is_empty() {
        print!("{text}");
    }

    let errors = compilation.diagnostics.len();
    if errors == 0 {
        println!("Checked {path} — no errors.");
    } else {
        let noun = if errors == 1 { "error" } else { "errors" };
        println!("Found {errors} {noun} in {path}.");
    }

    if profile {
        print_profile(&compilation.types, &compilation.resolver.stats, elapsed);
    }

    if errors == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// The `--profile-types` report: a per-alias "top expensive types" table
/// (ranked by instantiation count), the instantiation cache hit rate, the
/// maximum instantiation depth, and the underlying type-store work. This is the
/// observability the greenfield representation was chosen to make cheap.
fn print_profile(types: &TypeStore, inst: &InstantiationStats, elapsed: std::time::Duration) {
    let ranked = inst.ranked();

    println!("\nType Checking: {:.3?}", elapsed);

    if !ranked.is_empty() {
        println!("\nType Instantiations");
        println!("──────────────────────────────");
        let width = ranked
            .iter()
            .map(|(n, _)| n.len())
            .max()
            .unwrap_or(0)
            .max(4);
        for (name, count) in &ranked {
            println!("{:<width$}  {:>8}", name, count, width = width);
        }
        println!("\nMaximum instantiation depth: {}", inst.max_depth);
        println!("Conditional-type evaluations: {}", inst.conditional_evals);
        if inst.cache_disabled {
            println!("Instantiation cache: DISABLED (--no-instantiation-cache)");
            println!(
                "  {} instantiations performed with no memoization",
                inst.total_misses()
            );
        } else {
            println!(
                "Cache hit rate: {:.1}%  ({} hits, {} misses)",
                inst.cache_hit_rate() * 100.0,
                inst.total_hits(),
                inst.total_misses()
            );
        }
    }

    let s = &types.stats;
    println!("\nType store");
    println!("──────────────────────────────");
    println!("Distinct types:         {:>10}", types.unique_count());
    println!("Type constructions:     {:>10}", s.intern_total());
    println!(
        "  from cache (interned):{:>10}  ({:.1}%)",
        s.intern_hits.get(),
        s.intern_hit_rate() * 100.0
    );
    println!("  newly allocated:      {:>10}", s.intern_misses.get());
    println!("Assignability checks:   {:>10}", s.relation_checks.get());
    println!(
        "  served from cache:    {:>10}",
        s.relation_cache_hits.get()
    );
}
