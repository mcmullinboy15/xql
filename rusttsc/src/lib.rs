//! rusttsc — a greenfield TypeScript checker built on ID-addressed arenas.
//!
//! This is the Stage 1 foundation described in the project README: parse, bind,
//! and check a subset of TypeScript, emitting diagnostics, with the internal
//! representation (NodeStore / SymbolStore / TypeStore) deliberately shaped for
//! the later stages — interned immutable types, structural hashing, and the
//! profiling counters that back `rusttsc --profile-types`.
//!
//! The public surface is small on purpose: everything flows through
//! [`program::Compilation::compile`].

pub mod ast;
pub mod binder;
pub mod checker;
pub mod diagnostics;
pub mod lexer;
pub mod parser;
pub mod program;
pub mod span;
pub mod symbols;
pub mod types;

pub use program::Compilation;
