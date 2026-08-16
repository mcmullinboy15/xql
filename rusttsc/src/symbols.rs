//! Symbols and lexical scopes — the "SymbolStore" from the design sketch.
//!
//! Both symbols and scopes live in flat arenas addressed by id. A scope holds a
//! name→symbol map and a parent id; name resolution walks the parent chain.
//! Nothing owns anything by pointer, so the whole table is one contiguous block
//! that a parallel checker could share behind an `&`.

use crate::span::Span;
use crate::types::TypeId;
use std::collections::HashMap;

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub struct SymbolId(pub u32);

#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub struct ScopeId(pub u32);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum SymbolKind {
    Variable,
    Function,
    Parameter,
}

#[derive(Clone, Debug)]
pub struct Symbol {
    pub name: String,
    pub kind: SymbolKind,
    /// The symbol's declared/inferred type. `None` until the checker finalizes
    /// an un-annotated binding at its declaration site.
    pub ty: Option<TypeId>,
    pub decl_span: Span,
}

pub struct Scope {
    pub parent: Option<ScopeId>,
    names: HashMap<String, SymbolId>,
}

pub struct SymbolStore {
    symbols: Vec<Symbol>,
    scopes: Vec<Scope>,
}

impl SymbolStore {
    pub fn new() -> SymbolStore {
        SymbolStore {
            symbols: Vec::new(),
            scopes: Vec::new(),
        }
    }

    pub fn new_scope(&mut self, parent: Option<ScopeId>) -> ScopeId {
        let id = ScopeId(self.scopes.len() as u32);
        self.scopes.push(Scope {
            parent,
            names: HashMap::new(),
        });
        id
    }

    pub fn scope(&self, id: ScopeId) -> &Scope {
        &self.scopes[id.0 as usize]
    }

    /// Declare `symbol` in `scope`. Returns `Err` with the existing symbol id if
    /// the name is already bound *in this scope* (the caller reports the
    /// redeclaration); shadowing an outer scope is allowed and returns `Ok`.
    pub fn declare(&mut self, scope: ScopeId, symbol: Symbol) -> Result<SymbolId, SymbolId> {
        if let Some(&existing) = self.scopes[scope.0 as usize].names.get(&symbol.name) {
            return Err(existing);
        }
        let id = SymbolId(self.symbols.len() as u32);
        let name = symbol.name.clone();
        self.symbols.push(symbol);
        self.scopes[scope.0 as usize].names.insert(name, id);
        Ok(id)
    }

    /// Resolve `name` starting at `scope` and walking outward through parents.
    pub fn resolve(&self, scope: ScopeId, name: &str) -> Option<SymbolId> {
        let mut current = Some(scope);
        while let Some(s) = current {
            if let Some(&id) = self.scopes[s.0 as usize].names.get(name) {
                return Some(id);
            }
            current = self.scopes[s.0 as usize].parent;
        }
        None
    }

    pub fn get(&self, id: SymbolId) -> &Symbol {
        &self.symbols[id.0 as usize]
    }

    pub fn set_type(&mut self, id: SymbolId, ty: TypeId) {
        self.symbols[id.0 as usize].ty = Some(ty);
    }
}

impl Default for SymbolStore {
    fn default() -> Self {
        SymbolStore::new()
    }
}
