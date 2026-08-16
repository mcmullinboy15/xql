// A diamond of generic aliases: each level references the level below it twice.
// Resolving `Collapse<number>` therefore *would* instantiate the bottom alias
// 2^7 = 128 times without memoization — but with the instantiation cache it is
// linear (one instantiation per (alias, args) pair). Run:
//
//   rusttsc check generic-diamond.ok.ts --profile-types
//   rusttsc check generic-diamond.ok.ts --profile-types --no-instantiation-cache
//
// and compare the instantiation counts. This is the exponential-vs-linear win
// the whole ID-arena + interning + memoization design exists to capture.

type Leaf<T> = T extends number ? string : boolean;
type L1<T> = Leaf<T> | Leaf<T>;
type L2<T> = L1<T> | L1<T>;
type L3<T> = L2<T> | L2<T>;
type L4<T> = L3<T> | L3<T>;
type L5<T> = L4<T> | L4<T>;
type L6<T> = L5<T> | L5<T>;
type Collapse<T> = L6<T> | L6<T>;

// Collapse<number> reduces to `string` (Leaf<number> = string, unions dedupe).
const ok: Collapse<number> = "resolved";
