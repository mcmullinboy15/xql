//! The compilation pipeline: source → tokens → AST → bound scopes → checked.
//!
//! This mirrors the classic `Parser → Binder → Program → TypeChecker` shape,
//! with every phase writing into the shared arenas rather than handing off
//! freshly allocated object graphs.

use crate::ast::Ast;
use crate::diagnostics::Diagnostic;
use crate::symbols::SymbolStore;
use crate::typeres::{AliasStore, TypeResolver};
use crate::types::TypeStore;
use crate::{binder, checker, lexer, parser};

/// One compiled source file and everything the pipeline produced for it.
pub struct Compilation {
    pub file: String,
    pub source: String,
    pub ast: Ast,
    pub symbols: SymbolStore,
    pub types: TypeStore,
    pub aliases: AliasStore,
    pub resolver: TypeResolver,
    pub diagnostics: Vec<Diagnostic>,
}

impl Compilation {
    /// Run the whole pipeline over one source string, with the instantiation
    /// memo enabled.
    pub fn compile(file: impl Into<String>, source: impl Into<String>) -> Compilation {
        Compilation::compile_with(file, source, true)
    }

    /// Run the pipeline, optionally disabling the instantiation memo cache — the
    /// switch behind `--no-instantiation-cache`, which turns the memoized
    /// (linear) instantiation of diamond-shaped generics back into the
    /// exponential work it would otherwise be, so the difference is measurable.
    pub fn compile_with(
        file: impl Into<String>,
        source: impl Into<String>,
        cache_enabled: bool,
    ) -> Compilation {
        let file = file.into();
        let source = source.into();

        let mut ast = Ast::new();
        let mut symbols = SymbolStore::new();
        let mut types = TypeStore::new();
        let mut diagnostics = Vec::new();

        let tokens = lexer::tokenize(&source, &mut diagnostics);
        parser::parse(tokens, &mut ast, &mut diagnostics);

        // Aliases are collected up front so they can be mutually recursive and
        // referenced before their textual declaration.
        let aliases = AliasStore::collect(&ast, &mut diagnostics);
        let mut resolver = TypeResolver::new(cache_enabled);

        let bind = binder::bind(
            &ast,
            &mut symbols,
            &mut types,
            &aliases,
            &mut resolver,
            &mut diagnostics,
        );
        checker::check(
            &ast,
            &bind,
            &mut symbols,
            &mut types,
            &aliases,
            &mut resolver,
            &mut diagnostics,
        );

        Compilation {
            file,
            source,
            ast,
            symbols,
            types,
            aliases,
            resolver,
            diagnostics,
        }
    }

    pub fn has_errors(&self) -> bool {
        !self.diagnostics.is_empty()
    }

    /// Human-readable, `tsc`-flavored diagnostic output.
    pub fn render_diagnostics(&self) -> String {
        crate::diagnostics::render(&self.source, &self.file, &self.diagnostics)
    }
}
