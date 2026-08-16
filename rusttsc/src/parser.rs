//! A recursive-descent parser for the supported subset, producing node ids into
//! an [`Ast`] arena.
//!
//! Supported grammar (informally):
//!
//! ```text
//! program    := stmt*
//! stmt       := varDecl | funcDecl | typeAlias | block | return | exprStmt
//! varDecl    := ('let'|'const'|'var') ident (':' type)? ('=' expr)? ';'?
//! funcDecl   := 'function' ident '(' params? ')' (':' type)? block
//! typeAlias  := 'type' ident ('<' ident (',' ident)* '>')? '=' type ';'?
//! block      := '{' stmt* '}'
//! return     := 'return' expr? ';'?
//! exprStmt   := expr ';'?
//! expr       := additive
//! additive   := call ('+' call)*
//! call       := primary ('(' args? ')')*
//! primary    := number | string | 'true' | 'false' | 'null'
//!             | ident | '(' expr ')'
//! type       := union ('extends' union '?' type ':' type)?   // conditional
//! union      := '|'? typePrimary ('|' typePrimary)*
//! typePrimary:= number | string | 'true' | 'false'           // literal types
//!             | ident ('<' type (',' type)* '>')?            // ref + type args
//!             | '(' type ')'
//! ```
//!
//! On a syntax error the parser records a diagnostic, drops an [`Node::Error`]
//! placeholder, and resynchronizes to the next `;` or `}` so one mistake does
//! not cascade into a wall of noise.

use crate::ast::{Ast, BinOp, LitType, Node, NodeId, Param, VarKind};
use crate::diagnostics::{Code, Diagnostic};
use crate::lexer::{TokKind, Token};
use crate::span::Span;

pub struct Parser<'a> {
    toks: Vec<Token>,
    pos: usize,
    ast: &'a mut Ast,
    diags: &'a mut Vec<Diagnostic>,
}

impl<'a> Parser<'a> {
    pub fn new(toks: Vec<Token>, ast: &'a mut Ast, diags: &'a mut Vec<Diagnostic>) -> Parser<'a> {
        Parser {
            toks,
            pos: 0,
            ast,
            diags,
        }
    }

    pub fn parse_program(mut self) {
        let mut stmts = Vec::new();
        while !self.at_eof() {
            let before = self.pos;
            stmts.push(self.parse_stmt());
            // Guarantee forward progress even if a sub-parser got stuck.
            if self.pos == before {
                self.pos += 1;
            }
        }
        self.ast.set_root(stmts);
    }

    // ---- token helpers --------------------------------------------------

    fn peek(&self) -> &Token {
        &self.toks[self.pos]
    }

    fn peek_kind(&self) -> TokKind {
        self.toks[self.pos].kind
    }

    /// Kind of the token `n` positions ahead, saturating at `Eof`.
    fn nth_kind(&self, n: usize) -> TokKind {
        self.toks
            .get(self.pos + n)
            .map(|t| t.kind)
            .unwrap_or(TokKind::Eof)
    }

    fn at_eof(&self) -> bool {
        self.peek_kind() == TokKind::Eof
    }

    /// True when the current token is an identifier with exactly `kw` as text —
    /// how the parser recognizes the contextual keywords the lexer left as
    /// plain identifiers.
    fn at_keyword(&self, kw: &str) -> bool {
        let t = self.peek();
        t.kind == TokKind::Ident && t.text == kw
    }

    fn bump(&mut self) -> Token {
        let t = self.toks[self.pos].clone();
        if self.pos + 1 < self.toks.len() {
            self.pos += 1;
        }
        t
    }

    fn eat(&mut self, kind: TokKind) -> bool {
        if self.peek_kind() == kind {
            self.bump();
            true
        } else {
            false
        }
    }

    /// Consume a token of `kind` or record a "'x' expected." diagnostic. Returns
    /// the span consumed (or the current position's span on failure).
    fn expect(&mut self, kind: TokKind, what: &str) -> Span {
        if self.peek_kind() == kind {
            self.bump().span
        } else {
            let span = self.peek().span;
            self.diags.push(Diagnostic::error(
                span,
                Code::SyntaxError,
                format!("'{}' expected.", what),
            ));
            span
        }
    }

    fn error_node(&mut self, span: Span, message: impl Into<String>) -> NodeId {
        self.diags
            .push(Diagnostic::error(span, Code::SyntaxError, message));
        self.ast.alloc(Node::Error { span })
    }

    /// Skip forward to the next statement boundary after an error.
    fn recover(&mut self) {
        while !self.at_eof() {
            match self.peek_kind() {
                TokKind::Semi => {
                    self.bump();
                    return;
                }
                TokKind::RBrace => return,
                _ => {
                    self.bump();
                }
            }
        }
    }

    // ---- statements -----------------------------------------------------

    fn parse_stmt(&mut self) -> NodeId {
        if self.at_keyword("let") || self.at_keyword("const") || self.at_keyword("var") {
            return self.parse_var_decl();
        }
        if self.at_keyword("function") {
            return self.parse_func_decl();
        }
        if self.at_keyword("return") {
            return self.parse_return();
        }
        // `type` is only a keyword when a name follows it; `type` on its own is
        // an ordinary identifier expression.
        if self.at_keyword("type") && self.nth_kind(1) == TokKind::Ident {
            return self.parse_type_alias();
        }
        if self.peek_kind() == TokKind::LBrace {
            return self.parse_block();
        }
        self.parse_expr_stmt()
    }

    fn parse_var_decl(&mut self) -> NodeId {
        let kw = self.bump();
        let kind = match kw.text.as_str() {
            "const" => VarKind::Const,
            "var" => VarKind::Var,
            _ => VarKind::Let,
        };
        let start = kw.span;

        if self.peek_kind() != TokKind::Ident {
            let span = self.peek().span;
            self.recover();
            return self.error_node(start.to(span), "Variable declaration name expected.");
        }
        let name_tok = self.bump();

        let type_ann = if self.eat(TokKind::Colon) {
            Some(self.parse_type())
        } else {
            None
        };
        let init = if self.eat(TokKind::Eq) {
            Some(self.parse_expr())
        } else {
            None
        };
        let end = self.peek().span;
        self.eat(TokKind::Semi);
        self.ast.alloc(Node::VarDecl {
            kind,
            name: name_tok.text,
            name_span: name_tok.span,
            type_ann,
            init,
            span: start.to(end),
        })
    }

    fn parse_func_decl(&mut self) -> NodeId {
        let kw = self.bump(); // 'function'
        let name_tok = if self.peek_kind() == TokKind::Ident {
            self.bump()
        } else {
            let span = self.peek().span;
            self.diags.push(Diagnostic::error(
                span,
                Code::SyntaxError,
                "Function name expected.".to_string(),
            ));
            Token {
                kind: TokKind::Ident,
                text: String::new(),
                span,
            }
        };

        self.expect(TokKind::LParen, "(");
        let mut params = Vec::new();
        while self.peek_kind() != TokKind::RParen && !self.at_eof() {
            if self.peek_kind() != TokKind::Ident {
                break;
            }
            let p_name = self.bump();
            let p_ann = if self.eat(TokKind::Colon) {
                Some(self.parse_type())
            } else {
                None
            };
            params.push(Param {
                name: p_name.text,
                name_span: p_name.span,
                type_ann: p_ann,
            });
            if !self.eat(TokKind::Comma) {
                break;
            }
        }
        self.expect(TokKind::RParen, ")");

        let ret_ann = if self.eat(TokKind::Colon) {
            Some(self.parse_type())
        } else {
            None
        };
        let body = self.parse_block();
        let span = kw.span.to(self.ast.get(body).span());
        self.ast.alloc(Node::FuncDecl {
            name: name_tok.text,
            name_span: name_tok.span,
            params,
            ret_ann,
            body,
            span,
        })
    }

    fn parse_block(&mut self) -> NodeId {
        let open = self.expect(TokKind::LBrace, "{");
        let mut stmts = Vec::new();
        while self.peek_kind() != TokKind::RBrace && !self.at_eof() {
            let before = self.pos;
            stmts.push(self.parse_stmt());
            if self.pos == before {
                self.pos += 1;
            }
        }
        let close = self.expect(TokKind::RBrace, "}");
        self.ast.alloc(Node::Block {
            stmts,
            span: open.to(close),
        })
    }

    fn parse_return(&mut self) -> NodeId {
        let kw = self.bump();
        let arg = if matches!(
            self.peek_kind(),
            TokKind::Semi | TokKind::RBrace | TokKind::Eof
        ) {
            None
        } else {
            Some(self.parse_expr())
        };
        let end = self.peek().span;
        self.eat(TokKind::Semi);
        self.ast.alloc(Node::Return {
            arg,
            span: kw.span.to(end),
        })
    }

    fn parse_expr_stmt(&mut self) -> NodeId {
        let expr = self.parse_expr();
        let end = self.peek().span;
        self.eat(TokKind::Semi);
        let span = self.ast.get(expr).span().to(end);
        self.ast.alloc(Node::ExprStmt { expr, span })
    }

    // ---- expressions ----------------------------------------------------

    fn parse_expr(&mut self) -> NodeId {
        self.parse_additive()
    }

    fn parse_additive(&mut self) -> NodeId {
        let mut lhs = self.parse_call();
        while self.peek_kind() == TokKind::Plus {
            self.bump();
            let rhs = self.parse_call();
            let span = self.ast.get(lhs).span().to(self.ast.get(rhs).span());
            lhs = self.ast.alloc(Node::Binary {
                op: BinOp::Add,
                lhs,
                rhs,
                span,
            });
        }
        lhs
    }

    fn parse_call(&mut self) -> NodeId {
        let mut callee = self.parse_primary();
        while self.peek_kind() == TokKind::LParen {
            self.bump();
            let mut args = Vec::new();
            while self.peek_kind() != TokKind::RParen && !self.at_eof() {
                args.push(self.parse_expr());
                if !self.eat(TokKind::Comma) {
                    break;
                }
            }
            let close = self.expect(TokKind::RParen, ")");
            let span = self.ast.get(callee).span().to(close);
            callee = self.ast.alloc(Node::Call { callee, args, span });
        }
        callee
    }

    fn parse_primary(&mut self) -> NodeId {
        let t = self.peek().clone();
        match t.kind {
            TokKind::Number => {
                self.bump();
                self.ast.alloc(Node::NumberLit {
                    text: t.text,
                    span: t.span,
                })
            }
            TokKind::Str => {
                self.bump();
                self.ast.alloc(Node::StringLit {
                    value: t.text,
                    span: t.span,
                })
            }
            TokKind::LParen => {
                self.bump();
                let inner = self.parse_expr();
                self.expect(TokKind::RParen, ")");
                inner
            }
            TokKind::Ident => match t.text.as_str() {
                "true" | "false" => {
                    self.bump();
                    self.ast.alloc(Node::BoolLit {
                        value: t.text == "true",
                        span: t.span,
                    })
                }
                "null" => {
                    self.bump();
                    self.ast.alloc(Node::NullLit { span: t.span })
                }
                _ => {
                    self.bump();
                    self.ast.alloc(Node::Ident {
                        name: t.text,
                        span: t.span,
                    })
                }
            },
            _ => {
                let span = t.span;
                self.error_node(span, "Expression expected.")
            }
        }
    }

    // ---- type declarations ----------------------------------------------

    fn parse_type_alias(&mut self) -> NodeId {
        let kw = self.bump(); // 'type'
        let name_tok = self.bump(); // the name (guaranteed Ident by the caller)

        let params = self.parse_type_params();
        self.expect(TokKind::Eq, "=");
        let body = self.parse_type();
        let end = self.peek().span;
        self.eat(TokKind::Semi);
        self.ast.alloc(Node::TypeAliasDecl {
            name: name_tok.text,
            name_span: name_tok.span,
            params,
            body,
            span: kw.span.to(end),
        })
    }

    /// Parse an optional `<P1, P2, ...>` declaration parameter list.
    fn parse_type_params(&mut self) -> Vec<String> {
        let mut params = Vec::new();
        if !self.eat(TokKind::Lt) {
            return params;
        }
        while self.peek_kind() != TokKind::Gt && !self.at_eof() {
            if self.peek_kind() == TokKind::Ident {
                params.push(self.bump().text);
            } else {
                break;
            }
            if !self.eat(TokKind::Comma) {
                break;
            }
        }
        self.expect(TokKind::Gt, ">");
        params
    }

    // ---- types ----------------------------------------------------------

    /// The lowest-precedence type production is the conditional; its check type
    /// is a union (or tighter), matching TypeScript's grammar.
    fn parse_type(&mut self) -> NodeId {
        let check = self.parse_union_type();
        if !self.at_keyword("extends") {
            return check;
        }
        self.bump(); // 'extends'
        let extends_ty = self.parse_union_type();
        self.expect(TokKind::Question, "?");
        let true_ty = self.parse_type();
        self.expect(TokKind::Colon, ":");
        // Right-associative: `A extends B ? C : D extends E ? F : G` nests on
        // the false branch.
        let false_ty = self.parse_type();
        let span = self.ast.get(check).span().to(self.ast.get(false_ty).span());
        self.ast.alloc(Node::ConditionalType {
            check,
            extends_ty,
            true_ty,
            false_ty,
            span,
        })
    }

    fn parse_union_type(&mut self) -> NodeId {
        // A leading `|` is allowed and ignored, as in TypeScript.
        self.eat(TokKind::Pipe);
        let first = self.parse_type_primary();
        if self.peek_kind() != TokKind::Pipe {
            return first;
        }
        let mut members = vec![first];
        while self.eat(TokKind::Pipe) {
            members.push(self.parse_type_primary());
        }
        let span = self
            .ast
            .get(members[0])
            .span()
            .to(self.ast.get(*members.last().unwrap()).span());
        self.ast.alloc(Node::TypeUnion { members, span })
    }

    fn parse_type_primary(&mut self) -> NodeId {
        let t = self.peek().clone();
        match t.kind {
            TokKind::Number => {
                self.bump();
                self.ast.alloc(Node::LiteralType {
                    value: LitType::Num(t.text),
                    span: t.span,
                })
            }
            TokKind::Str => {
                self.bump();
                self.ast.alloc(Node::LiteralType {
                    value: LitType::Str(t.text),
                    span: t.span,
                })
            }
            // A parenthesized type, so `(A | B) extends C ? ...` groups.
            TokKind::LParen => {
                self.bump();
                let inner = self.parse_type();
                self.expect(TokKind::RParen, ")");
                inner
            }
            TokKind::Ident => {
                self.bump();
                match t.text.as_str() {
                    "true" | "false" => self.ast.alloc(Node::LiteralType {
                        value: LitType::Bool(t.text == "true"),
                        span: t.span,
                    }),
                    _ => {
                        let args = self.parse_type_args();
                        let span = args
                            .last()
                            .map(|&a| t.span.to(self.ast.get(a).span()))
                            .unwrap_or(t.span);
                        self.ast.alloc(Node::TypeRef {
                            name: t.text,
                            args,
                            span,
                        })
                    }
                }
            }
            _ => {
                let span = t.span;
                self.error_node(span, "Type expected.")
            }
        }
    }

    /// Parse an optional `<Arg1, Arg2, ...>` type-argument list at a use site.
    fn parse_type_args(&mut self) -> Vec<NodeId> {
        let mut args = Vec::new();
        if self.peek_kind() != TokKind::Lt {
            return args;
        }
        self.bump(); // '<'
        while self.peek_kind() != TokKind::Gt && !self.at_eof() {
            args.push(self.parse_type());
            if !self.eat(TokKind::Comma) {
                break;
            }
        }
        self.expect(TokKind::Gt, ">");
        args
    }
}

/// Parse tokens into `ast`, appending any syntax diagnostics to `diags`.
pub fn parse(toks: Vec<Token>, ast: &mut Ast, diags: &mut Vec<Diagnostic>) {
    Parser::new(toks, ast, diags).parse_program();
}
