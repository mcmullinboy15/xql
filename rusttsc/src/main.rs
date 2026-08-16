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
         rusttsc check <file.ts> [--profile-types]\n\n\
         OPTIONS:\n    \
         --profile-types    print type-system work (instantiations, cache hits)\n    \
         -h, --help         show this help"
    );
}

fn run_check(rest: &[String]) -> ExitCode {
    let mut profile = false;
    let mut path: Option<&str> = None;
    for arg in rest {
        match arg.as_str() {
            "--profile-types" => profile = true,
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
    let compilation = Compilation::compile(path, source);
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
        print_profile(&compilation.types, elapsed);
    }

    if errors == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

/// The `--profile-types` report. In Stage 1 the "expensive types" table is not
/// yet per-alias (there are no generics to instantiate), so we report the
/// aggregate type-system work: how many distinct types the program produced,
/// how much of that construction was served from the intern table, and how the
/// assignability relation cache performed.
fn print_profile(types: &TypeStore, elapsed: std::time::Duration) {
    let s = &types.stats;
    println!("\nType-system profile");
    println!("──────────────────────────────");
    println!("Wall time:              {:>10.3?}", elapsed);
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
