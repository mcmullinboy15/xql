//! Source positions.
//!
//! A [`Span`] is a half-open byte range `[lo, hi)` into the source string. We
//! deliberately keep spans as two `u32`s rather than storing line/column on
//! every node — the arena stays compact, and line/column are computed on demand
//! only when a diagnostic is actually rendered (see [`LineIndex`]).

/// A half-open byte range into a single source file.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub struct Span {
    pub lo: u32,
    pub hi: u32,
}

impl Span {
    pub fn new(lo: u32, hi: u32) -> Span {
        debug_assert!(lo <= hi, "span lo must not exceed hi");
        Span { lo, hi }
    }

    /// The span covering both `self` and `other` (and everything between).
    pub fn to(self, other: Span) -> Span {
        Span {
            lo: self.lo.min(other.lo),
            hi: self.hi.max(other.hi),
        }
    }

    pub fn len(self) -> u32 {
        self.hi - self.lo
    }

    pub fn is_empty(self) -> bool {
        self.lo == self.hi
    }
}

/// One-based line and column, plus the byte range of the containing line —
/// everything a renderer needs to draw a caret under a span.
#[derive(Clone, Copy, Debug)]
pub struct Location {
    pub line: u32,
    pub column: u32,
    pub line_start: u32,
    pub line_end: u32,
}

/// Precomputed line-start offsets so any byte offset resolves to line/column in
/// O(log n) rather than rescanning the source per diagnostic.
pub struct LineIndex {
    /// Byte offset of the start of each line. `line_starts[0]` is always 0.
    line_starts: Vec<u32>,
    len: u32,
}

impl LineIndex {
    pub fn new(source: &str) -> LineIndex {
        let mut line_starts = vec![0u32];
        for (i, b) in source.bytes().enumerate() {
            if b == b'\n' {
                line_starts.push(i as u32 + 1);
            }
        }
        LineIndex {
            line_starts,
            len: source.len() as u32,
        }
    }

    /// Resolve a byte offset to a 1-based line/column and the line's byte range.
    pub fn locate(&self, offset: u32) -> Location {
        let offset = offset.min(self.len);
        // Largest line index whose start is <= offset.
        let line = match self.line_starts.binary_search(&offset) {
            Ok(exact) => exact,
            Err(next) => next - 1,
        };
        let line_start = self.line_starts[line];
        let line_end = self
            .line_starts
            .get(line + 1)
            .map(|&s| s.saturating_sub(1)) // drop the trailing '\n'
            .unwrap_or(self.len);
        Location {
            line: line as u32 + 1,
            column: offset - line_start + 1,
            line_start,
            line_end,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locate_across_lines() {
        let src = "let x = 1;\nlet yy = 2;\n";
        let idx = LineIndex::new(src);
        let first = idx.locate(4); // the 'x'
        assert_eq!((first.line, first.column), (1, 5));
        let second = idx.locate(15); // the first 'y'
        assert_eq!((second.line, second.column), (2, 5));
    }

    #[test]
    fn span_merge() {
        assert_eq!(Span::new(2, 5).to(Span::new(8, 9)), Span::new(2, 9));
    }
}
