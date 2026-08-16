//! The AST arena — the "NodeStore" from the design sketch.
//!
//! Nodes never point at each other with owning pointers; every edge is a
//! [`NodeId`] index into one flat `Vec<Node>`. Traversal is index-chasing, the
//! whole tree frees in one drop, and a node is a plain value we can copy an id
//! to without touching lifetimes or reference counts.

use crate::span::Span;

/// An index into [`Ast::nodes`]. Newtyped so a node id can't be confused with a
/// type id or a symbol id.
#[derive(Clone, Copy, PartialEq, Eq, Debug, Hash)]
pub struct NodeId(pub u32);

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum VarKind {
    Let,
    Const,
    Var,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum BinOp {
    /// `+` is the only binary operator in the subset; it is enough to exercise
    /// the string-vs-number result rules in the checker.
    Add,
}

/// A function parameter: a name, its span, and an optional type annotation node.
#[derive(Clone, Debug)]
pub struct Param {
    pub name: String,
    pub name_span: Span,
    pub type_ann: Option<NodeId>,
}

#[derive(Clone, Debug)]
pub enum Node {
    /// A recovery placeholder inserted by the parser so a syntax error doesn't
    /// unwind the whole parse. The checker treats its type as `any`.
    Error {
        span: Span,
    },

    // ---- top level ------------------------------------------------------
    Program {
        stmts: Vec<NodeId>,
    },

    // ---- statements -----------------------------------------------------
    VarDecl {
        kind: VarKind,
        name: String,
        name_span: Span,
        type_ann: Option<NodeId>,
        init: Option<NodeId>,
        span: Span,
    },
    FuncDecl {
        name: String,
        name_span: Span,
        params: Vec<Param>,
        ret_ann: Option<NodeId>,
        body: NodeId,
        span: Span,
    },
    Block {
        stmts: Vec<NodeId>,
        span: Span,
    },
    ExprStmt {
        expr: NodeId,
        span: Span,
    },
    Return {
        arg: Option<NodeId>,
        span: Span,
    },

    // ---- expressions ----------------------------------------------------
    NumberLit {
        text: String,
        span: Span,
    },
    StringLit {
        value: String,
        span: Span,
    },
    BoolLit {
        value: bool,
        span: Span,
    },
    NullLit {
        span: Span,
    },
    Ident {
        name: String,
        span: Span,
    },
    Binary {
        op: BinOp,
        lhs: NodeId,
        rhs: NodeId,
        span: Span,
    },
    Call {
        callee: NodeId,
        args: Vec<NodeId>,
        span: Span,
    },

    // ---- type annotations ----------------------------------------------
    /// A named type in type position: `number`, `string`, or a custom name.
    TypeRef {
        name: String,
        span: Span,
    },
    /// `A | B | C`.
    TypeUnion {
        members: Vec<NodeId>,
        span: Span,
    },
    /// A literal type: `"x"`, `42`, `true`.
    LiteralType {
        value: LitType,
        span: Span,
    },
}

/// The payload of a [`Node::LiteralType`].
#[derive(Clone, Debug)]
pub enum LitType {
    Str(String),
    Num(String),
    Bool(bool),
}

impl Node {
    pub fn span(&self) -> Span {
        match self {
            Node::Error { span }
            | Node::VarDecl { span, .. }
            | Node::FuncDecl { span, .. }
            | Node::Block { span, .. }
            | Node::ExprStmt { span, .. }
            | Node::Return { span, .. }
            | Node::NumberLit { span, .. }
            | Node::StringLit { span, .. }
            | Node::BoolLit { span, .. }
            | Node::NullLit { span }
            | Node::Ident { span, .. }
            | Node::Binary { span, .. }
            | Node::Call { span, .. }
            | Node::TypeRef { span, .. }
            | Node::TypeUnion { span, .. }
            | Node::LiteralType { span, .. } => *span,
            // Program has no single span; use an empty one at the origin.
            Node::Program { .. } => Span::new(0, 0),
        }
    }
}

/// The flat node arena plus a handle to the root `Program` node.
pub struct Ast {
    nodes: Vec<Node>,
    pub root: NodeId,
}

impl Ast {
    /// Start an arena with a placeholder root; the parser overwrites the root
    /// once it has collected the program's statements.
    pub fn new() -> Ast {
        // Node 0 is always the root `Program`; the parser overwrites its
        // statement list once parsing finishes.
        let nodes = vec![Node::Program { stmts: Vec::new() }];
        Ast {
            nodes,
            root: NodeId(0),
        }
    }

    pub fn alloc(&mut self, node: Node) -> NodeId {
        let id = NodeId(self.nodes.len() as u32);
        self.nodes.push(node);
        id
    }

    pub fn get(&self, id: NodeId) -> &Node {
        &self.nodes[id.0 as usize]
    }

    pub fn set_root(&mut self, stmts: Vec<NodeId>) {
        self.nodes[0] = Node::Program { stmts };
    }

    /// Number of nodes in the arena (always ≥ 1 — the root `Program`).
    pub fn node_count(&self) -> usize {
        self.nodes.len()
    }
}

impl Default for Ast {
    fn default() -> Self {
        Ast::new()
    }
}
