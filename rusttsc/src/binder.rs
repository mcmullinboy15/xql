//! The binder — the "Node → Symbols" pass from the design sketch.
//!
//! It walks the AST once and builds the scope tree: one scope for the program
//! and one per block. Function *declarations* are hoisted (their name and full
//! function type are visible before the declaration textually appears, matching
//! TypeScript), and their parameters are declared into the function body's
//! scope. Variable bindings are intentionally *not* bound here — the checker
//! introduces them progressively at their declaration site so that using a name
//! before it is declared is a "Cannot find name" error rather than resolving.
//!
//! The binder also resolves type *annotations* to `TypeId`s (through the shared
//! [`TypeResolver`], so aliases and conditional types work in signatures), since
//! a function's hoisted type needs its parameter and return annotations up front.

use crate::ast::{Ast, Node, NodeId, Param};
use crate::diagnostics::{Code, Diagnostic};
use crate::symbols::{ScopeId, Symbol, SymbolKind, SymbolStore};
use crate::typeres::{AliasStore, TypeResolver};
use crate::types::{TypeId, TypeStore};
use std::collections::HashMap;

/// Output of binding: a map from each container node (Program / Block) to the
/// scope it introduces, so the checker can re-enter the same scopes as it walks.
pub struct BindResult {
    pub container_scope: HashMap<NodeId, ScopeId>,
    pub root_scope: ScopeId,
}

pub struct Binder<'a> {
    ast: &'a Ast,
    symbols: &'a mut SymbolStore,
    types: &'a mut TypeStore,
    aliases: &'a AliasStore,
    resolver: &'a mut TypeResolver,
    diags: &'a mut Vec<Diagnostic>,
    container_scope: HashMap<NodeId, ScopeId>,
}

impl<'a> Binder<'a> {
    pub fn new(
        ast: &'a Ast,
        symbols: &'a mut SymbolStore,
        types: &'a mut TypeStore,
        aliases: &'a AliasStore,
        resolver: &'a mut TypeResolver,
        diags: &'a mut Vec<Diagnostic>,
    ) -> Binder<'a> {
        Binder {
            ast,
            symbols,
            types,
            aliases,
            resolver,
            diags,
            container_scope: HashMap::new(),
        }
    }

    pub fn bind(mut self) -> BindResult {
        let root_scope = self.symbols.new_scope(None);
        self.container_scope.insert(self.ast.root, root_scope);
        if let Node::Program { stmts } = self.ast.get(self.ast.root) {
            let stmts = stmts.clone();
            self.hoist_functions(&stmts, root_scope);
            for &s in &stmts {
                self.bind_stmt(s, root_scope);
            }
        }
        BindResult {
            container_scope: self.container_scope,
            root_scope,
        }
    }

    /// Pre-declare every function in a statement list so calls can precede the
    /// textual declaration.
    fn hoist_functions(&mut self, stmts: &[NodeId], scope: ScopeId) {
        for &s in stmts {
            if let Node::FuncDecl {
                name,
                name_span,
                params,
                ret_ann,
                ..
            } = self.ast.get(s)
            {
                let (name, name_span, params, ret_ann) =
                    (name.clone(), *name_span, params.clone(), *ret_ann);
                let ty = self.function_type(&params, ret_ann);
                let sym = Symbol {
                    name: name.clone(),
                    kind: SymbolKind::Function,
                    ty: Some(ty),
                    decl_span: name_span,
                };
                if self.symbols.declare(scope, sym).is_err() {
                    self.diags.push(Diagnostic::error(
                        name_span,
                        Code::Redeclaration,
                        format!("Cannot redeclare block-scoped variable '{}'.", name),
                    ));
                }
            }
        }
    }

    fn bind_stmt(&mut self, id: NodeId, scope: ScopeId) {
        match self.ast.get(id) {
            Node::FuncDecl { params, body, .. } => {
                // The body block gets its own scope, seeded with the parameters.
                let params = params.clone();
                let body = *body;
                let body_scope = self.enter_block_scope(body, scope);
                for p in &params {
                    self.declare_param(p, body_scope);
                }
                self.bind_block_contents(body, body_scope);
            }
            Node::Block { .. } => {
                let inner = self.enter_block_scope(id, scope);
                self.bind_block_contents(id, inner);
            }
            // Other statements introduce no scopes and no hoisted symbols.
            _ => {}
        }
    }

    /// Create (once) the scope for a block node and record the mapping.
    fn enter_block_scope(&mut self, block: NodeId, parent: ScopeId) -> ScopeId {
        let scope = self.symbols.new_scope(Some(parent));
        self.container_scope.insert(block, scope);
        scope
    }

    fn bind_block_contents(&mut self, block: NodeId, scope: ScopeId) {
        if let Node::Block { stmts, .. } = self.ast.get(block) {
            let stmts = stmts.clone();
            self.hoist_functions(&stmts, scope);
            for &s in &stmts {
                self.bind_stmt(s, scope);
            }
        }
    }

    fn declare_param(&mut self, p: &Param, scope: ScopeId) {
        let ty = p
            .type_ann
            .map(|a| self.resolve_type(a))
            .unwrap_or(self.types.any);
        let sym = Symbol {
            name: p.name.clone(),
            kind: SymbolKind::Parameter,
            ty: Some(ty),
            decl_span: p.name_span,
        };
        if self.symbols.declare(scope, sym).is_err() {
            self.diags.push(Diagnostic::error(
                p.name_span,
                Code::Redeclaration,
                format!("Duplicate identifier '{}'.", p.name),
            ));
        }
    }

    // ---- type resolution -----------------------------------------------

    fn function_type(&mut self, params: &[Param], ret_ann: Option<NodeId>) -> TypeId {
        let param_types: Vec<TypeId> = params
            .iter()
            .map(|p| {
                p.type_ann
                    .map(|a| self.resolve_type(a))
                    .unwrap_or(self.types.any)
            })
            .collect();
        let ret = ret_ann
            .map(|a| self.resolve_type(a))
            .unwrap_or(self.types.any);
        self.types.function(param_types, ret)
    }

    fn resolve_type(&mut self, id: NodeId) -> TypeId {
        self.resolver
            .resolve(self.ast, self.types, self.aliases, self.diags, id)
    }
}

pub fn bind(
    ast: &Ast,
    symbols: &mut SymbolStore,
    types: &mut TypeStore,
    aliases: &AliasStore,
    resolver: &mut TypeResolver,
    diags: &mut Vec<Diagnostic>,
) -> BindResult {
    Binder::new(ast, symbols, types, aliases, resolver, diags).bind()
}
