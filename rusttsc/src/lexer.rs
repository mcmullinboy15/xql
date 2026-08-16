//! A hand-written lexer for the supported TypeScript subset.
//!
//! Keywords are *not* distinguished here — every word becomes an `Ident` and
//! the parser decides whether a given identifier is acting as `let`, `number`,
//! a type name, or a variable. That keeps the token set tiny and avoids baking
//! TypeScript's large, context-sensitive keyword table into the lexer.

use crate::diagnostics::{Code, Diagnostic};
use crate::span::Span;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum TokKind {
    Ident,
    Number,
    Str,
    Colon,
    Semi,
    Comma,
    LParen,
    RParen,
    LBrace,
    RBrace,
    Pipe,
    Eq,
    Plus,
    Arrow, // =>
    Dot,
    Eof,
}

#[derive(Clone, Debug)]
pub struct Token {
    pub kind: TokKind,
    /// For `Ident`/`Number` the raw text; for `Str` the *decoded* value.
    pub text: String,
    pub span: Span,
}

pub struct Lexer<'a> {
    src: &'a [u8],
    pos: usize,
    diags: &'a mut Vec<Diagnostic>,
}

impl<'a> Lexer<'a> {
    pub fn new(src: &'a str, diags: &'a mut Vec<Diagnostic>) -> Lexer<'a> {
        Lexer {
            src: src.as_bytes(),
            pos: 0,
            diags,
        }
    }

    /// Tokenize the whole input, always ending with a single `Eof` token.
    pub fn tokenize(mut self) -> Vec<Token> {
        let mut out = Vec::new();
        loop {
            self.skip_trivia();
            if self.pos >= self.src.len() {
                let at = self.src.len() as u32;
                out.push(Token {
                    kind: TokKind::Eof,
                    text: String::new(),
                    span: Span::new(at, at),
                });
                return out;
            }
            let start = self.pos;
            let c = self.src[self.pos];
            let tok = match c {
                b'a'..=b'z' | b'A'..=b'Z' | b'_' | b'$' => self.ident(start),
                b'0'..=b'9' => self.number(start),
                b'"' | b'\'' => self.string(start, c),
                _ => match self.punct(start, c) {
                    Some(t) => t,
                    None => {
                        // Unknown byte: report once and skip it so lexing can
                        // continue rather than aborting the whole file.
                        self.pos += 1;
                        self.diags.push(Diagnostic::error(
                            Span::new(start as u32, self.pos as u32),
                            Code::SyntaxError,
                            format!("Unexpected character '{}'.", c as char),
                        ));
                        continue;
                    }
                },
            };
            out.push(tok);
        }
    }

    fn skip_trivia(&mut self) {
        loop {
            while self.pos < self.src.len() && self.src[self.pos].is_ascii_whitespace() {
                self.pos += 1;
            }
            if self.starts_with(b"//") {
                while self.pos < self.src.len() && self.src[self.pos] != b'\n' {
                    self.pos += 1;
                }
                continue;
            }
            if self.starts_with(b"/*") {
                self.pos += 2;
                while self.pos < self.src.len() && !self.starts_with(b"*/") {
                    self.pos += 1;
                }
                self.pos = (self.pos + 2).min(self.src.len());
                continue;
            }
            break;
        }
    }

    fn starts_with(&self, needle: &[u8]) -> bool {
        self.src[self.pos..].starts_with(needle)
    }

    fn ident(&mut self, start: usize) -> Token {
        while self.pos < self.src.len() {
            let c = self.src[self.pos];
            if c.is_ascii_alphanumeric() || c == b'_' || c == b'$' {
                self.pos += 1;
            } else {
                break;
            }
        }
        self.tok(TokKind::Ident, start)
    }

    fn number(&mut self, start: usize) -> Token {
        while self.pos < self.src.len() {
            let c = self.src[self.pos];
            // A single subset: integer and decimal literals.
            if c.is_ascii_digit() || c == b'.' {
                self.pos += 1;
            } else {
                break;
            }
        }
        self.tok(TokKind::Number, start)
    }

    fn string(&mut self, start: usize, quote: u8) -> Token {
        self.pos += 1; // opening quote
        let mut value = String::new();
        while self.pos < self.src.len() {
            let c = self.src[self.pos];
            if c == quote {
                self.pos += 1;
                return Token {
                    kind: TokKind::Str,
                    text: value,
                    span: Span::new(start as u32, self.pos as u32),
                };
            }
            if c == b'\\' && self.pos + 1 < self.src.len() {
                self.pos += 1;
                let esc = self.src[self.pos];
                value.push(match esc {
                    b'n' => '\n',
                    b't' => '\t',
                    b'r' => '\r',
                    b'\\' => '\\',
                    b'"' => '"',
                    b'\'' => '\'',
                    other => other as char,
                });
                self.pos += 1;
                continue;
            }
            if c == b'\n' {
                break; // unterminated on this line
            }
            value.push(c as char);
            self.pos += 1;
        }
        self.diags.push(Diagnostic::error(
            Span::new(start as u32, self.pos as u32),
            Code::SyntaxError,
            "Unterminated string literal.".to_string(),
        ));
        Token {
            kind: TokKind::Str,
            text: value,
            span: Span::new(start as u32, self.pos as u32),
        }
    }

    fn punct(&mut self, start: usize, c: u8) -> Option<Token> {
        // Two-char punctuation first.
        if c == b'=' && self.src.get(self.pos + 1) == Some(&b'>') {
            self.pos += 2;
            return Some(self.tok(TokKind::Arrow, start));
        }
        let kind = match c {
            b':' => TokKind::Colon,
            b';' => TokKind::Semi,
            b',' => TokKind::Comma,
            b'(' => TokKind::LParen,
            b')' => TokKind::RParen,
            b'{' => TokKind::LBrace,
            b'}' => TokKind::RBrace,
            b'|' => TokKind::Pipe,
            b'=' => TokKind::Eq,
            b'+' => TokKind::Plus,
            b'.' => TokKind::Dot,
            _ => return None,
        };
        self.pos += 1;
        Some(self.tok(kind, start))
    }

    fn tok(&self, kind: TokKind, start: usize) -> Token {
        let text = std::str::from_utf8(&self.src[start..self.pos])
            .unwrap_or("")
            .to_string();
        Token {
            kind,
            text,
            span: Span::new(start as u32, self.pos as u32),
        }
    }
}

/// Convenience wrapper used by the pipeline and tests.
pub fn tokenize(src: &str, diags: &mut Vec<Diagnostic>) -> Vec<Token> {
    Lexer::new(src, diags).tokenize()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(src: &str) -> Vec<TokKind> {
        let mut diags = Vec::new();
        tokenize(src, &mut diags)
            .into_iter()
            .map(|t| t.kind)
            .collect()
    }

    #[test]
    fn lexes_a_declaration() {
        use TokKind::*;
        assert_eq!(
            kinds("const x: number = 1;"),
            vec![Ident, Ident, Colon, Ident, Eq, Number, Semi, Eof]
        );
    }

    #[test]
    fn strings_are_decoded() {
        let mut diags = Vec::new();
        let toks = tokenize(r#" "a\nb" "#, &mut diags);
        assert!(diags.is_empty());
        assert_eq!(toks[0].kind, TokKind::Str);
        assert_eq!(toks[0].text, "a\nb");
    }

    #[test]
    fn comments_and_arrows() {
        use TokKind::*;
        assert_eq!(kinds("// hi\n=> /* x */ ("), vec![Arrow, LParen, Eof]);
    }

    #[test]
    fn unterminated_string_reports() {
        let mut diags = Vec::new();
        let _ = tokenize("\"oops", &mut diags);
        assert_eq!(diags.len(), 1);
    }
}
