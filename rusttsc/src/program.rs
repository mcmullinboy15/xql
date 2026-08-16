//! The compilation pipeline: source → tokens → AST → bound scopes → checked.
//!
//! This mirrors the classic `Parser → Binder → Program → TypeChecker` shape,
//! with every phase writing into the shared arenas rather than handing off
//! freshly allocated object graphs.

use crate::ast::Ast;
use crate::diagnostics::Diagnostic;
use crate::symbols::SymbolStore;
use crate::types::TypeStore;
use crate::{binder, checker, lexer, parser};

/// One compiled source file and everything the pipeline produced for it.
pub struct Compilation {
    pub file: String,
    pub source: String,
    pub ast: Ast,
    pub symbols: SymbolStore,
    pub types: TypeStore,
    pub diagnostics: Vec<Diagnostic>,
}

impl Compilation {
    /// Run the whole pipeline over one source string.
    pub fn compile(file: impl Into<String>, source: impl Into<String>) -> Compilation {
        let file = file.into();
        let source = source.into();

        let mut ast = Ast::new();
        let mut symbols = SymbolStore::new();
        let mut types = TypeStore::new();
        let mut diagnostics = Vec::new();

        let tokens = lexer::tokenize(&source, &mut diagnostics);
        parser::parse(tokens, &mut ast, &mut diagnostics);
        let bind = binder::bind(&ast, &mut symbols, &mut types, &mut diagnostics);
        checker::check(&ast, &bind, &mut symbols, &mut types, &mut diagnostics);

        Compilation {
            file,
            source,
            ast,
            symbols,
            types,
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
