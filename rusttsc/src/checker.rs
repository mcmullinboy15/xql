//! The type checker — the pass that resolves uses, infers expression types, and
//! runs the assignability relation to produce diagnostics.
//!
//! It walks the bound AST carrying the *current* scope explicitly. Variable
//! symbols are introduced here, at their declaration site (functions were
//! already hoisted by the binder), so a use that textually precedes a `let`
//! resolves to nothing and reports "Cannot find name". Expression types are
//! inferred bottom-up; the interesting checks are:
//!
//! * an initializer must be assignable to its declared annotation,
//! * a `return` value must be assignable to the function's declared return type,
//! * a call must target a function, with the right arity and assignable args.

use crate::ast::{BinOp, Node, NodeId};
use crate::binder::{resolve_type_ann, BindResult};
use crate::diagnostics::{Code, Diagnostic};
use crate::span::Span;
use crate::symbols::{ScopeId, Symbol, SymbolKind, SymbolStore};
use crate::types::{Type, TypeId, TypeStore};

pub struct Checker<'a> {
    ast: &'a crate::ast::Ast,
    bind: &'a BindResult,
    symbols: &'a mut SymbolStore,
    types: &'a mut TypeStore,
    diags: &'a mut Vec<Diagnostic>,
    /// Expected return type per enclosing function; `None` means "don't check"
    /// (an unannotated function whose return type we treat as `any`).
    return_stack: Vec<Option<TypeId>>,
}

impl<'a> Checker<'a> {
    pub fn new(
        ast: &'a crate::ast::Ast,
        bind: &'a BindResult,
        symbols: &'a mut SymbolStore,
        types: &'a mut TypeStore,
        diags: &'a mut Vec<Diagnostic>,
    ) -> Checker<'a> {
        Checker {
            ast,
            bind,
            symbols,
            types,
            diags,
            return_stack: Vec::new(),
        }
    }

    pub fn check(&mut self) {
        let scope = self.bind.root_scope;
        if let Node::Program { stmts } = self.ast.get(self.ast.root) {
            let stmts = stmts.clone();
            for s in stmts {
                self.check_stmt(s, scope);
            }
        }
    }

    fn scope_of(&self, container: NodeId, fallback: ScopeId) -> ScopeId {
        *self
            .bind
            .container_scope
            .get(&container)
            .unwrap_or(&fallback)
    }

    // ---- statements -----------------------------------------------------

    fn check_stmt(&mut self, id: NodeId, scope: ScopeId) {
        match self.ast.get(id).clone() {
            Node::VarDecl {
                kind,
                name,
                name_span,
                type_ann,
                init,
                ..
            } => {
                self.check_var_decl(scope, kind, &name, name_span, type_ann, init);
            }
            Node::FuncDecl {
                name,
                ret_ann,
                body,
                ..
            } => {
                self.check_func_decl(scope, &name, ret_ann, body);
            }
            Node::Block { stmts, .. } => {
                let inner = self.scope_of(id, scope);
                for s in stmts {
                    self.check_stmt(s, inner);
                }
            }
            Node::ExprStmt { expr, .. } => {
                self.type_of(expr, scope);
            }
            Node::Return { arg, .. } => {
                self.check_return(scope, arg);
            }
            _ => {}
        }
    }

    fn check_var_decl(
        &mut self,
        scope: ScopeId,
        kind: crate::ast::VarKind,
        name: &str,
        name_span: Span,
        type_ann: Option<NodeId>,
        init: Option<NodeId>,
    ) {
        let declared = type_ann.map(|a| resolve_type_ann(self.ast, self.types, self.diags, a));
        // Infer the initializer type *before* the name is in scope, so
        // `const x = x` is a "cannot find name", not a self-reference.
        let init_ty = init.map(|e| self.type_of(e, scope));

        let effective = match (declared, init_ty) {
            (Some(decl), Some(it)) => {
                let init_node = init.unwrap();
                if !self.types.is_assignable(it, decl) {
                    self.diags.push(Diagnostic::error(
                        self.ast.get(init_node).span(),
                        Code::NotAssignable,
                        format!(
                            "Type '{}' is not assignable to type '{}'.",
                            self.types.display(it),
                            self.types.display(decl),
                        ),
                    ));
                }
                decl
            }
            (Some(decl), None) => decl,
            (None, Some(it)) => {
                // `const` keeps the literal; `let`/`var` widen it.
                if matches!(kind, crate::ast::VarKind::Const) {
                    it
                } else {
                    self.types.widen(it)
                }
            }
            (None, None) => self.types.any,
        };

        let sym = Symbol {
            name: name.to_string(),
            kind: SymbolKind::Variable,
            ty: Some(effective),
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

    fn check_func_decl(
        &mut self,
        scope: ScopeId,
        name: &str,
        ret_ann: Option<NodeId>,
        body: NodeId,
    ) {
        // The declared return type only *checks* returns when it was written
        // explicitly; an unannotated function accepts any return.
        let expected = ret_ann.map(|a| resolve_type_ann(self.ast, self.types, self.diags, a));
        let expected = match expected {
            Some(t) if t != self.types.any => Some(t),
            _ => None,
        };
        let _ = name; // resolution happens through the body's own scope

        self.return_stack.push(expected);
        let body_scope = self.scope_of(body, scope);
        if let Node::Block { stmts, .. } = self.ast.get(body).clone() {
            for s in stmts {
                self.check_stmt(s, body_scope);
            }
        }
        self.return_stack.pop();
    }

    fn check_return(&mut self, scope: ScopeId, arg: Option<NodeId>) {
        let expected = self.return_stack.last().copied().flatten();
        if let (Some(expected), Some(arg)) = (expected, arg) {
            let actual = self.type_of(arg, scope);
            if !self.types.is_assignable(actual, expected) {
                self.diags.push(Diagnostic::error(
                    self.ast.get(arg).span(),
                    Code::NotAssignable,
                    format!(
                        "Type '{}' is not assignable to type '{}'.",
                        self.types.display(actual),
                        self.types.display(expected),
                    ),
                ));
            }
        }
    }

    // ---- expressions ----------------------------------------------------

    /// Infer the type of an expression, emitting diagnostics for bad references
    /// and calls along the way. Returns `any` for anything unresolved so a
    /// single mistake doesn't cascade into a storm of downstream errors.
    fn type_of(&mut self, id: NodeId, scope: ScopeId) -> TypeId {
        match self.ast.get(id).clone() {
            Node::NumberLit { text, .. } => self.types.number_literal(text),
            Node::StringLit { value, .. } => self.types.string_literal(value),
            Node::BoolLit { value, .. } => self.types.boolean_literal(value),
            Node::NullLit { .. } => self.types.null,
            Node::Ident { name, span } => self.type_of_ident(scope, &name, span),
            Node::Binary { op, lhs, rhs, .. } => self.type_of_binary(scope, op, lhs, rhs),
            Node::Call { callee, args, span } => self.type_of_call(scope, callee, &args, span),
            Node::Error { .. } => self.types.any,
            // Type nodes never appear in value position given the grammar.
            _ => self.types.any,
        }
    }

    fn type_of_ident(&mut self, scope: ScopeId, name: &str, span: Span) -> TypeId {
        match self.symbols.resolve(scope, name) {
            Some(sym) => self.symbols.get(sym).ty.unwrap_or(self.types.any),
            None => {
                self.diags.push(Diagnostic::error(
                    span,
                    Code::CannotFindName,
                    format!("Cannot find name '{}'.", name),
                ));
                self.types.any
            }
        }
    }

    fn type_of_binary(&mut self, scope: ScopeId, op: BinOp, lhs: NodeId, rhs: NodeId) -> TypeId {
        let l = self.type_of(lhs, scope);
        let r = self.type_of(rhs, scope);
        match op {
            // `+`: string if either side is string-ish, else number. `any`
            // propagates. Note the result is the *widened* base type, never a
            // literal — `1 + 1` is `number`, not `2`.
            BinOp::Add => {
                if l == self.types.any || r == self.types.any {
                    self.types.any
                } else if self.is_string_ish(l) || self.is_string_ish(r) {
                    self.types.string
                } else {
                    self.types.number
                }
            }
        }
    }

    fn is_string_ish(&self, id: TypeId) -> bool {
        matches!(self.types.get(id), Type::String | Type::StringLiteral(_))
    }

    fn type_of_call(
        &mut self,
        scope: ScopeId,
        callee: NodeId,
        args: &[NodeId],
        span: Span,
    ) -> TypeId {
        let callee_ty = self.type_of(callee, scope);
        // Clone the signature out so we can re-borrow the store mutably while
        // inferring argument types.
        match self.types.get(callee_ty).clone() {
            Type::Any => {
                for &a in args {
                    self.type_of(a, scope);
                }
                self.types.any
            }
            Type::Function { params, ret } => {
                if args.len() != params.len() {
                    self.diags.push(Diagnostic::error(
                        span,
                        Code::WrongArgCount,
                        format!(
                            "Expected {} arguments, but got {}.",
                            params.len(),
                            args.len()
                        ),
                    ));
                }
                for (i, &a) in args.iter().enumerate() {
                    let at = self.type_of(a, scope);
                    if let Some(&pt) = params.get(i) {
                        if !self.types.is_assignable(at, pt) {
                            self.diags.push(Diagnostic::error(
                                self.ast.get(a).span(),
                                Code::ArgNotAssignable,
                                format!(
                                    "Argument of type '{}' is not assignable to parameter of type '{}'.",
                                    self.types.display(at),
                                    self.types.display(pt),
                                ),
                            ));
                        }
                    }
                }
                ret
            }
            _ => {
                for &a in args {
                    self.type_of(a, scope);
                }
                self.diags.push(Diagnostic::error(
                    self.ast.get(callee).span(),
                    Code::NotCallable,
                    format!(
                        "This expression is not callable. Type '{}' has no call signatures.",
                        self.types.display(callee_ty),
                    ),
                ));
                self.types.any
            }
        }
    }
}

pub fn check(
    ast: &crate::ast::Ast,
    bind: &BindResult,
    symbols: &mut SymbolStore,
    types: &mut TypeStore,
    diags: &mut Vec<Diagnostic>,
) {
    Checker::new(ast, bind, symbols, types, diags).check();
}
