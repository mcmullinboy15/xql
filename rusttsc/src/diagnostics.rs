//! Diagnostics and their rendering.
//!
//! The codes intentionally mirror TypeScript's own `TSxxxx` numbering where a
//! direct analogue exists — the north star (see the crate README) is that
//! `rusttsc check` eventually produces the same diagnostics as `tsc --noEmit`
//! for a shared corpus, and reusing the codes makes differential testing a
//! straight string comparison rather than a translation table.

use crate::span::{LineIndex, Span};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Severity {
    Error,
    Warning,
}

impl Severity {
    fn label(self) -> &'static str {
        match self {
            Severity::Error => "error",
            Severity::Warning => "warning",
        }
    }
}

/// A subset of TypeScript's diagnostic codes, plus a `Parse` bucket for
/// syntax errors that don't map cleanly onto a single TS code yet.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Code {
    /// TS1005 "'x' expected." and friends — generic syntax error.
    SyntaxError,
    /// TS2304 "Cannot find name 'x'."
    CannotFindName,
    /// TS2322 "Type 'X' is not assignable to type 'Y'."
    NotAssignable,
    /// TS2345 "Argument of type 'A' is not assignable to parameter of type 'P'."
    ArgNotAssignable,
    /// TS2349 "This expression is not callable."
    NotCallable,
    /// TS2554 "Expected N arguments, but got M."
    WrongArgCount,
    /// TS2451 "Cannot redeclare block-scoped variable 'x'."
    Redeclaration,
    /// TS2355 "A function whose declared type is neither 'void' nor 'any' must
    /// return a value." — used here for a missing return where one is required.
    MissingReturn,
}

impl Code {
    /// The numeric `TSxxxx` value we print.
    pub fn number(self) -> u32 {
        match self {
            Code::SyntaxError => 1005,
            Code::CannotFindName => 2304,
            Code::NotAssignable => 2322,
            Code::ArgNotAssignable => 2345,
            Code::NotCallable => 2349,
            Code::WrongArgCount => 2554,
            Code::Redeclaration => 2451,
            Code::MissingReturn => 2355,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Diagnostic {
    pub span: Span,
    pub code: Code,
    pub severity: Severity,
    pub message: String,
}

impl Diagnostic {
    pub fn error(span: Span, code: Code, message: impl Into<String>) -> Diagnostic {
        Diagnostic {
            span,
            code,
            severity: Severity::Error,
            message: message.into(),
        }
    }
}

/// Render diagnostics in a `tsc`-flavored, human-readable form with a caret
/// under the offending span. Sorted by position so output is deterministic.
pub fn render(source: &str, file: &str, diags: &[Diagnostic]) -> String {
    let index = LineIndex::new(source);
    let mut ordered: Vec<&Diagnostic> = diags.iter().collect();
    ordered.sort_by_key(|d| (d.span.lo, d.span.hi));

    let mut out = String::new();
    for d in ordered {
        let loc = index.locate(d.span.lo);
        out.push_str(&format!(
            "{file}:{line}:{col} - {sev} TS{code}: {msg}\n",
            file = file,
            line = loc.line,
            col = loc.column,
            sev = d.severity.label(),
            code = d.code.number(),
            msg = d.message,
        ));

        // Source line with a caret underline, tsc-style.
        let line_text = &source[loc.line_start as usize..loc.line_end as usize];
        let gutter = format!("{} ", loc.line);
        out.push_str(&format!("{gutter}| {line_text}\n"));

        let pad = " ".repeat(gutter.len());
        let lead = " ".repeat((d.span.lo - loc.line_start) as usize);
        // Underline stays within the line even for multi-line spans.
        let visible = (loc.line_end - d.span.lo).min(d.span.len()).max(1);
        let carets = "~".repeat(visible as usize);
        out.push_str(&format!("{pad}| {lead}{carets}\n\n"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn renders_with_caret() {
        let src = "const x: number = \"hi\";\n";
        let span = Span::new(18, 22); // the "hi"
        let d = Diagnostic::error(
            span,
            Code::NotAssignable,
            "Type 'string' is not assignable to type 'number'.",
        );
        let text = render(src, "a.ts", &[d]);
        assert!(text.contains("a.ts:1:19 - error TS2322"));
        assert!(text.contains("~~~~"));
    }
}
