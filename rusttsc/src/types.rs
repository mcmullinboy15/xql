//! The type arena — the "TypeStore" from the design sketch.
//!
//! Every type is a [`TypeId`] index into a flat `Vec<Type>`. Types are
//! *interned*: constructing the same structural type twice returns the same id,
//! so equality is an integer compare and there is exactly one allocation per
//! distinct type in the whole program. The intern table is where the design's
//! "structural hashing + aggressive memoization" lives, and it is also the
//! natural place to hang the profiling counters that `--profile-types` reports.
//!
//! Number literals are stored as their *source text* rather than an `f64`:
//! `f64` is neither `Eq` nor `Hash`, and the text is what we want to display
//! anyway (`1.0` and `1` are distinct literal types in TypeScript).

use std::cell::Cell;
use std::collections::HashMap;

/// An index into [`TypeStore::types`].
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub struct TypeId(pub u32);

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum Type {
    /// The top/escape-hatch type: assignable to and from everything.
    Any,
    /// Assignable *from* everything but not *to* anything without narrowing.
    Unknown,
    /// The bottom type: assignable to everything, nothing assignable to it.
    Never,
    Void,
    Null,
    Undefined,
    Boolean,
    Number,
    String,
    BooleanLiteral(bool),
    NumberLiteral(String),
    StringLiteral(String),
    /// A canonicalized union: members are sorted by id and deduplicated, and a
    /// union is never nested or of length < 2 (the constructor collapses those).
    Union(Vec<TypeId>),
    Function {
        params: Vec<TypeId>,
        ret: TypeId,
    },
}

/// Counters exposed by `--profile-types`. Everything is interior-mutable so the
/// store can be shared immutably by the checker while still tracking work.
#[derive(Default)]
pub struct Stats {
    /// Times an intern lookup found an existing type (memoization payoff).
    pub intern_hits: Cell<u64>,
    /// Times an intern lookup allocated a fresh type.
    pub intern_misses: Cell<u64>,
    /// Total `is_assignable` calls (the checker's inner loop).
    pub relation_checks: Cell<u64>,
    /// `is_assignable` calls answered from the relation cache.
    pub relation_cache_hits: Cell<u64>,
}

impl Stats {
    pub fn intern_total(&self) -> u64 {
        self.intern_hits.get() + self.intern_misses.get()
    }

    /// Fraction of intern lookups served from the table, in `[0, 1]`.
    pub fn intern_hit_rate(&self) -> f64 {
        let total = self.intern_total();
        if total == 0 {
            0.0
        } else {
            self.intern_hits.get() as f64 / total as f64
        }
    }
}

pub struct TypeStore {
    types: Vec<Type>,
    intern: HashMap<Type, TypeId>,
    /// Memoized `(source, target) -> assignable?` results.
    relation_cache: std::cell::RefCell<HashMap<(TypeId, TypeId), bool>>,
    pub stats: Stats,

    // Well-known interned types, cached for cheap access.
    pub any: TypeId,
    pub unknown: TypeId,
    pub never: TypeId,
    pub void: TypeId,
    pub null: TypeId,
    pub undefined: TypeId,
    pub boolean: TypeId,
    pub number: TypeId,
    pub string: TypeId,
}

impl TypeStore {
    pub fn new() -> TypeStore {
        let mut store = TypeStore {
            types: Vec::new(),
            intern: HashMap::new(),
            relation_cache: std::cell::RefCell::new(HashMap::new()),
            stats: Stats::default(),
            any: TypeId(0),
            unknown: TypeId(0),
            never: TypeId(0),
            void: TypeId(0),
            null: TypeId(0),
            undefined: TypeId(0),
            boolean: TypeId(0),
            number: TypeId(0),
            string: TypeId(0),
        };
        store.any = store.intern(Type::Any);
        store.unknown = store.intern(Type::Unknown);
        store.never = store.intern(Type::Never);
        store.void = store.intern(Type::Void);
        store.null = store.intern(Type::Null);
        store.undefined = store.intern(Type::Undefined);
        store.boolean = store.intern(Type::Boolean);
        store.number = store.intern(Type::Number);
        store.string = store.intern(Type::String);
        store
    }

    /// Intern a type, returning its stable id. This is the single choke point
    /// for allocation, so it is also where the intern hit/miss counters live.
    pub fn intern(&mut self, ty: Type) -> TypeId {
        if let Some(&id) = self.intern.get(&ty) {
            self.stats.intern_hits.set(self.stats.intern_hits.get() + 1);
            return id;
        }
        self.stats
            .intern_misses
            .set(self.stats.intern_misses.get() + 1);
        let id = TypeId(self.types.len() as u32);
        self.types.push(ty.clone());
        self.intern.insert(ty, id);
        id
    }

    pub fn get(&self, id: TypeId) -> &Type {
        &self.types[id.0 as usize]
    }

    /// Number of distinct interned types (a proxy for type-graph size).
    pub fn unique_count(&self) -> usize {
        self.types.len()
    }

    // ---- constructors that canonicalize --------------------------------

    pub fn number_literal(&mut self, text: impl Into<String>) -> TypeId {
        self.intern(Type::NumberLiteral(text.into()))
    }

    pub fn string_literal(&mut self, value: impl Into<String>) -> TypeId {
        self.intern(Type::StringLiteral(value.into()))
    }

    pub fn boolean_literal(&mut self, value: bool) -> TypeId {
        self.intern(Type::BooleanLiteral(value))
    }

    pub fn function(&mut self, params: Vec<TypeId>, ret: TypeId) -> TypeId {
        self.intern(Type::Function { params, ret })
    }

    /// Build a union, applying TypeScript's canonicalization: flatten nested
    /// unions, drop `never`, dedupe, sort by id, and collapse a singleton to the
    /// member itself (an empty union is `never`). Interning the sorted member
    /// list is what makes `A | B` and `B | A` the same id.
    pub fn union(&mut self, members: impl IntoIterator<Item = TypeId>) -> TypeId {
        let mut flat: Vec<TypeId> = Vec::new();
        let push = |flat: &mut Vec<TypeId>, id: TypeId| {
            if !flat.contains(&id) {
                flat.push(id);
            }
        };
        for id in members {
            if id == self.never {
                continue;
            }
            match self.get(id) {
                Type::Union(inner) => {
                    for &m in &inner.clone() {
                        push(&mut flat, m);
                    }
                }
                _ => push(&mut flat, id),
            }
        }
        flat.sort_by_key(|t| t.0);
        match flat.len() {
            0 => self.never,
            1 => flat[0],
            _ => self.intern(Type::Union(flat)),
        }
    }

    /// Widen a fresh literal type to its base — the inference applied to a
    /// `let`/`var` binding (`let x = 1` is `number`, not `1`).
    pub fn widen(&self, id: TypeId) -> TypeId {
        match self.get(id) {
            Type::NumberLiteral(_) => self.number,
            Type::StringLiteral(_) => self.string,
            Type::BooleanLiteral(_) => self.boolean,
            _ => id,
        }
    }

    // ---- the relation --------------------------------------------------

    /// Is a value of type `source` assignable to a slot of type `target`?
    ///
    /// This is the checker's hottest path, so results are memoized and every
    /// call bumps the profiling counters.
    pub fn is_assignable(&self, source: TypeId, target: TypeId) -> bool {
        self.stats
            .relation_checks
            .set(self.stats.relation_checks.get() + 1);

        if source == target {
            return true;
        }
        if let Some(&cached) = self.relation_cache.borrow().get(&(source, target)) {
            self.stats
                .relation_cache_hits
                .set(self.stats.relation_cache_hits.get() + 1);
            return cached;
        }

        let result = self.compute_assignable(source, target);
        self.relation_cache
            .borrow_mut()
            .insert((source, target), result);
        result
    }

    fn compute_assignable(&self, source: TypeId, target: TypeId) -> bool {
        let s = self.get(source);
        let t = self.get(target);

        // any / unknown absorb everything on the appropriate side.
        if matches!(s, Type::Any) || matches!(t, Type::Any | Type::Unknown) {
            return true;
        }
        // never is assignable to anything.
        if matches!(s, Type::Never) {
            return true;
        }

        // A union source is assignable only if *every* member is.
        if let Type::Union(members) = s {
            return members.iter().all(|&m| self.is_assignable(m, target));
        }
        // Into a union target it suffices to match *some* member.
        if let Type::Union(members) = t {
            return members.iter().any(|&m| self.is_assignable(source, m));
        }

        // A literal is assignable to its widened base.
        match (s, t) {
            (Type::NumberLiteral(_), Type::Number) => true,
            (Type::StringLiteral(_), Type::String) => true,
            (Type::BooleanLiteral(_), Type::Boolean) => true,
            // Functions: contravariant params, covariant return, same arity.
            (
                Type::Function {
                    params: sp,
                    ret: sr,
                },
                Type::Function {
                    params: tp,
                    ret: tr,
                },
            ) => {
                sp.len() == tp.len()
                    && self.is_assignable(*sr, *tr)
                    && sp
                        .iter()
                        .zip(tp.iter())
                        .all(|(&ps, &pt)| self.is_assignable(pt, ps))
            }
            _ => false,
        }
    }

    // ---- display -------------------------------------------------------

    /// A TypeScript-style display string for a type, e.g. `string | 1`.
    pub fn display(&self, id: TypeId) -> String {
        match self.get(id) {
            Type::Any => "any".into(),
            Type::Unknown => "unknown".into(),
            Type::Never => "never".into(),
            Type::Void => "void".into(),
            Type::Null => "null".into(),
            Type::Undefined => "undefined".into(),
            Type::Boolean => "boolean".into(),
            Type::Number => "number".into(),
            Type::String => "string".into(),
            Type::BooleanLiteral(b) => b.to_string(),
            Type::NumberLiteral(n) => n.clone(),
            Type::StringLiteral(s) => format!("\"{}\"", s),
            Type::Union(members) => members
                .iter()
                .map(|&m| self.display(m))
                .collect::<Vec<_>>()
                .join(" | "),
            Type::Function { params, ret } => {
                let ps = params
                    .iter()
                    .enumerate()
                    .map(|(i, &p)| format!("arg{}: {}", i, self.display(p)))
                    .collect::<Vec<_>>()
                    .join(", ");
                format!("({}) => {}", ps, self.display(*ret))
            }
        }
    }
}

impl Default for TypeStore {
    fn default() -> Self {
        TypeStore::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interning_dedupes() {
        let mut s = TypeStore::new();
        let a = s.string_literal("hi");
        let b = s.string_literal("hi");
        assert_eq!(a, b);
        // "hi" was allocated once; the second lookup was a hit.
        assert!(s.stats.intern_hits.get() >= 1);
    }

    #[test]
    fn union_is_order_independent() {
        let mut s = TypeStore::new();
        let u1 = s.union([s.string, s.number]);
        let u2 = s.union([s.number, s.string]);
        assert_eq!(u1, u2);
    }

    #[test]
    fn union_collapses_and_drops_never() {
        let mut s = TypeStore::new();
        let just_string = s.union([s.string, s.never, s.string]);
        assert_eq!(just_string, s.string);
    }

    #[test]
    fn literal_assignable_to_base_but_not_reverse() {
        let mut s = TypeStore::new();
        let one = s.number_literal("1");
        assert!(s.is_assignable(one, s.number));
        assert!(!s.is_assignable(s.number, one));
    }

    #[test]
    fn assignable_into_union() {
        let mut s = TypeStore::new();
        let u = s.union([s.string, s.number]);
        assert!(s.is_assignable(s.number, u));
        assert!(!s.is_assignable(s.boolean, u));
    }

    #[test]
    fn relation_cache_counts_hits() {
        let mut s = TypeStore::new();
        let one = s.number_literal("1");
        s.is_assignable(one, s.number);
        s.is_assignable(one, s.number);
        assert!(s.stats.relation_cache_hits.get() >= 1);
    }
}
