//! A recursive-descent parser for the supported subset, producing node ids into
//! an [`Ast`] arena.
//!
//! Supported grammar (informally):
//!
//! ```text
//! program    := stmt*
//! stmt       := varDecl | funcDecl | block | return | exprStmt
//! varDecl    := ('let'|'const'|'var') ident (':' type)? ('=' expr)? ';'?
//! funcDecl   := 'function' ident '(' params? ')' (':' type)? block
//! block      := '{' stmt* '}'
//! return     := 'return' expr? ';'?
//! exprStmt   := expr ';'?
//! expr       := additive
//! additive   := call ('+' call)*
//! call       := primary ('(' args? ')')*
//! primary    := number | string | 'true' | 'false' | 'null'
//!             | ident | '(' expr ')'
//! type       := typePrimary ('|' typePrimary)*
//! typePrimary:= ident
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

    // ---- types ----------------------------------------------------------

    fn parse_type(&mut self) -> NodeId {
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
            TokKind::Ident => {
                self.bump();
                match t.text.as_str() {
                    "true" | "false" => self.ast.alloc(Node::LiteralType {
                        value: LitType::Bool(t.text == "true"),
                        span: t.span,
                    }),
                    _ => self.ast.alloc(Node::TypeRef {
                        name: t.text,
                        span: t.span,
                    }),
                }
            }
            _ => {
                let span = t.span;
                self.error_node(span, "Type expected.")
            }
        }
    }
}

/// Parse tokens into `ast`, appending any syntax diagnostics to `diags`.
pub fn parse(toks: Vec<Token>, ast: &mut Ast, diags: &mut Vec<Diagnostic>) {
    Parser::new(toks, ast, diags).parse_program();
}
