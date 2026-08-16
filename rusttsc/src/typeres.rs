//! The type-level evaluator: resolving type annotations to concrete `TypeId`s,
//! including generic aliases, type-argument application, and conditional types.
//!
//! This is where the project's central bet lives. A generic alias like
//! `type F<T> = T extends number ? string : boolean` is not stored as a lazy
//! graph that the checker walks repeatedly — instead each *use* is instantiated
//! by substitution into a concrete interned type, and every instantiation is
//! **memoized** on `(alias, argument ids)`. On the pathological type-level code
//! that motivates this whole design (deeply nested / diamond-shaped generic
//! instantiations), memoization is the difference between linear and exponential
//! work — and because construction funnels through here, that work is directly
//! *observable* (`--profile-types`).
//!
//! Conditional types "execute" by running the existing assignability relation:
//! `Check extends Extends ? T : F` resolves `T` when `Check` is assignable to
//! `Extends`, else `F`. Recursive aliases are bounded by [`MAX_DEPTH`].

use crate::ast::{Ast, LitType, Node, NodeId};
use crate::diagnostics::{Code, Diagnostic};
use crate::span::Span;
use crate::types::{TypeId, TypeStore};
use std::collections::HashMap;

/// Instantiation-depth ceiling before we declare a type "excessively deep",
/// mirroring the guard TypeScript raises as TS2589.
pub const MAX_DEPTH: u32 = 100;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub struct AliasId(pub u32);

/// A declared type alias: its parameters (by name) and the body node to
/// instantiate. Un-parameterized aliases simply have an empty `params`.
#[derive(Clone, Debug)]
pub struct AliasDef {
    pub name: String,
    pub params: Vec<String>,
    pub body: NodeId,
    pub decl_span: Span,
}

/// The alias namespace, populated once up front so aliases may be mutually
/// recursive and referenced before their textual declaration.
pub struct AliasStore {
    defs: Vec<AliasDef>,
    by_name: HashMap<String, AliasId>,
}

impl AliasStore {
    pub fn new() -> AliasStore {
        AliasStore {
            defs: Vec::new(),
            by_name: HashMap::new(),
        }
    }

    /// Scan the whole node arena for `type` alias declarations. Aliases share a
    /// single global namespace here (a simplification versus TypeScript's
    /// per-scope type namespaces); a duplicate name is reported and ignored.
    pub fn collect(ast: &Ast, diags: &mut Vec<Diagnostic>) -> AliasStore {
        let mut store = AliasStore::new();
        for node in ast.nodes() {
            if let Node::TypeAliasDecl {
                name,
                name_span,
                params,
                body,
                ..
            } = node
            {
                let id = AliasId(store.defs.len() as u32);
                if store.by_name.contains_key(name) {
                    diags.push(Diagnostic::error(
                        *name_span,
                        Code::Redeclaration,
                        format!("Duplicate identifier '{}'.", name),
                    ));
                    continue;
                }
                store.defs.push(AliasDef {
                    name: name.clone(),
                    params: params.clone(),
                    body: *body,
                    decl_span: *name_span,
                });
                store.by_name.insert(name.clone(), id);
            }
        }
        store
    }

    pub fn lookup(&self, name: &str) -> Option<AliasId> {
        self.by_name.get(name).copied()
    }

    pub fn get(&self, id: AliasId) -> &AliasDef {
        &self.defs[id.0 as usize]
    }
}

impl Default for AliasStore {
    fn default() -> Self {
        AliasStore::new()
    }
}

/// Per-alias and aggregate instantiation profiling — the data behind the
/// `--profile-types` report.
#[derive(Default)]
pub struct InstantiationStats {
    /// Actual instantiations performed (cache misses), per alias name.
    pub per_alias_miss: HashMap<String, u64>,
    /// Instantiations served from the memo cache (avoided work), per alias name.
    pub per_alias_hit: HashMap<String, u64>,
    /// Deepest instantiation nesting reached.
    pub max_depth: u32,
    /// Number of conditional-type `extends` evaluations.
    pub conditional_evals: u64,
    /// Whether the instantiation memo was disabled (for the exponential-vs-
    /// linear demonstration).
    pub cache_disabled: bool,
}

impl InstantiationStats {
    pub fn total_misses(&self) -> u64 {
        self.per_alias_miss.values().sum()
    }

    pub fn total_hits(&self) -> u64 {
        self.per_alias_hit.values().sum()
    }

    /// Fraction of instantiations served from the memo cache, in `[0, 1]`.
    pub fn cache_hit_rate(&self) -> f64 {
        let total = self.total_hits() + self.total_misses();
        if total == 0 {
            0.0
        } else {
            self.total_hits() as f64 / total as f64
        }
    }

    /// Aliases sorted by instantiation count, descending — the "top expensive
    /// types" table.
    pub fn ranked(&self) -> Vec<(String, u64)> {
        let mut v: Vec<(String, u64)> = self
            .per_alias_miss
            .iter()
            .map(|(k, &n)| (k.clone(), n))
            .collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        v
    }
}

/// The evaluator. It holds only the accumulating state (memo cache + stats);
/// the arenas it reads and writes are passed in per call so nothing is borrowed
/// for longer than a single resolution.
pub struct TypeResolver {
    /// Memo: `(alias, argument type ids) -> instantiated type`.
    cache: HashMap<(u32, Vec<u32>), TypeId>,
    depth: u32,
    pub stats: InstantiationStats,
}

impl TypeResolver {
    pub fn new(cache_enabled: bool) -> TypeResolver {
        let stats = InstantiationStats {
            cache_disabled: !cache_enabled,
            ..Default::default()
        };
        TypeResolver {
            cache: HashMap::new(),
            depth: 0,
            stats,
        }
    }

    /// Resolve a type-annotation node to a concrete type in the empty
    /// environment (no type parameters in scope).
    pub fn resolve(
        &mut self,
        ast: &Ast,
        types: &mut TypeStore,
        aliases: &AliasStore,
        diags: &mut Vec<Diagnostic>,
        node: NodeId,
    ) -> TypeId {
        let env = HashMap::new();
        self.resolve_in(ast, types, aliases, diags, node, &env)
    }

    fn resolve_in(
        &mut self,
        ast: &Ast,
        types: &mut TypeStore,
        aliases: &AliasStore,
        diags: &mut Vec<Diagnostic>,
        node: NodeId,
        env: &HashMap<String, TypeId>,
    ) -> TypeId {
        match ast.get(node) {
            Node::TypeRef { name, args, span } => {
                let name = name.clone();
                let args = args.clone();
                let span = *span;
                self.resolve_ref(ast, types, aliases, diags, &name, &args, span, env)
            }
            Node::TypeUnion { members, .. } => {
                let members = members.clone();
                let resolved: Vec<TypeId> = members
                    .iter()
                    .map(|&m| self.resolve_in(ast, types, aliases, diags, m, env))
                    .collect();
                types.union(resolved)
            }
            Node::LiteralType { value, .. } => match value.clone() {
                LitType::Str(s) => types.string_literal(s),
                LitType::Num(n) => types.number_literal(n),
                LitType::Bool(b) => types.boolean_literal(b),
            },
            Node::ConditionalType {
                check,
                extends_ty,
                true_ty,
                false_ty,
                ..
            } => {
                let (check, extends_ty, true_ty, false_ty) =
                    (*check, *extends_ty, *true_ty, *false_ty);
                let c = self.resolve_in(ast, types, aliases, diags, check, env);
                let e = self.resolve_in(ast, types, aliases, diags, extends_ty, env);
                self.stats.conditional_evals += 1;
                if types.is_assignable(c, e) {
                    self.resolve_in(ast, types, aliases, diags, true_ty, env)
                } else {
                    self.resolve_in(ast, types, aliases, diags, false_ty, env)
                }
            }
            // An error node in type position degrades to `any`.
            _ => types.any,
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn resolve_ref(
        &mut self,
        ast: &Ast,
        types: &mut TypeStore,
        aliases: &AliasStore,
        diags: &mut Vec<Diagnostic>,
        name: &str,
        args: &[NodeId],
        span: Span,
        env: &HashMap<String, TypeId>,
    ) -> TypeId {
        // A bare name in scope as a type parameter wins (and takes no args).
        if args.is_empty() {
            if let Some(&bound) = env.get(name) {
                return bound;
            }
            if let Some(prim) = primitive(types, name) {
                return prim;
            }
        }

        // Otherwise it must be an alias.
        if let Some(alias) = aliases.lookup(name) {
            let arg_types: Vec<TypeId> = args
                .iter()
                .map(|&a| self.resolve_in(ast, types, aliases, diags, a, env))
                .collect();
            return self.instantiate(ast, types, aliases, diags, alias, arg_types, span);
        }

        // A primitive used with type arguments, or an unknown name.
        if primitive(types, name).is_some() {
            diags.push(Diagnostic::error(
                span,
                Code::TypeArgMismatch,
                format!("Type '{}' is not generic.", name),
            ));
            return primitive(types, name).unwrap();
        }
        diags.push(Diagnostic::error(
            span,
            Code::CannotFindName,
            format!("Cannot find name '{}'.", name),
        ));
        types.any
    }

    #[allow(clippy::too_many_arguments)]
    fn instantiate(
        &mut self,
        ast: &Ast,
        types: &mut TypeStore,
        aliases: &AliasStore,
        diags: &mut Vec<Diagnostic>,
        alias: AliasId,
        arg_types: Vec<TypeId>,
        span: Span,
    ) -> TypeId {
        let def = aliases.get(alias).clone();

        if arg_types.len() != def.params.len() {
            diags.push(Diagnostic::error(
                span,
                Code::TypeArgMismatch,
                format!(
                    "Generic type '{}' requires {} type argument(s).",
                    def.name,
                    def.params.len()
                ),
            ));
            return types.any;
        }

        // Memo lookup — the payoff. `A<number>` resolved twice is one
        // instantiation and one cache hit, and a diamond of aliases collapses
        // from exponential to linear.
        let key = (alias.0, arg_types.iter().map(|t| t.0).collect::<Vec<u32>>());
        if !self.stats.cache_disabled {
            if let Some(&cached) = self.cache.get(&key) {
                *self
                    .stats
                    .per_alias_hit
                    .entry(def.name.clone())
                    .or_insert(0) += 1;
                return cached;
            }
        }

        if self.depth >= MAX_DEPTH {
            diags.push(Diagnostic::error(
                span,
                Code::ExcessiveDepth,
                "Type instantiation is excessively deep and possibly infinite.".to_string(),
            ));
            return types.any;
        }

        *self
            .stats
            .per_alias_miss
            .entry(def.name.clone())
            .or_insert(0) += 1;

        let mut env = HashMap::new();
        for (p, &a) in def.params.iter().zip(arg_types.iter()) {
            env.insert(p.clone(), a);
        }

        self.depth += 1;
        self.stats.max_depth = self.stats.max_depth.max(self.depth);
        let result = self.resolve_in(ast, types, aliases, diags, def.body, &env);
        self.depth -= 1;

        if !self.stats.cache_disabled {
            self.cache.insert(key, result);
        }
        result
    }
}

/// Map a primitive/keyword type name to its interned `TypeId`, or `None` if the
/// name is not a built-in type keyword.
fn primitive(types: &mut TypeStore, name: &str) -> Option<TypeId> {
    Some(match name {
        "number" => types.number,
        "string" => types.string,
        "boolean" => types.boolean,
        "any" => types.any,
        "unknown" => types.unknown,
        "never" => types.never,
        "void" => types.void,
        "null" => types.null,
        "undefined" => types.undefined,
        "true" => types.boolean_literal(true),
        "false" => types.boolean_literal(false),
        _ => return None,
    })
}
