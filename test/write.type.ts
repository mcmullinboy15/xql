import type { ParseWrite, StatementKind, WTokens } from "../src/type/write.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type _k1 = Expect<Equal<StatementKind<"select id from p">, "select">>;
type _k2 = Expect<Equal<StatementKind<"INSERT INTO p (a) values (1)">, "insert">>;
type _k3 = Expect<Equal<StatementKind<"update p set a = 1">, "update">>;
type _k4 = Expect<Equal<StatementKind<"delete from p where a = 1">, "delete">>;

type _t1 = Expect<Equal<WTokens<"a (b, c)">, ["a", "(", "b", ",", "c", ")"]>>;

// INSERT: table, column/value pairs, returning
type I1 = ParseWrite<"insert into product (title, price) values (:title, :price) returning id, title">;
type _i1 = Expect<Equal<I1["kind"], "insert">>;
type _i2 = Expect<Equal<I1["table"], "product">>;
type _i3 = Expect<Equal<I1["returning"], "id , title">>;
type _i4 = Expect<Equal<I1["pairs"], [["title", ":title"], ["price", ":price"]]>>;
type _i5 = Expect<Equal<I1["targets"], ["title", "price"]>>;

// INSERT with no returning
type I2 = ParseWrite<"insert into product (title) values ('x')">;
type _i6 = Expect<Equal<I2["returning"], "">>;

// INSERT with a function call in values -> commas inside parens do not split
type I3 = ParseWrite<"insert into product (title, price) values (coalesce(:t, 'x'), :p)">;
type _i7 = Expect<Equal<I3["pairs"], [["title", "coalesce ( :t , 'x' )"], ["price", ":p"]]>>;

// INSERT with alias + on conflict tail
type I4 = ParseWrite<"insert into product as p (title) values (:t) on conflict (title) do nothing returning p.id">;
type _i8 = Expect<Equal<I4["alias"], "p">>;
type _i9 = Expect<Equal<I4["returning"], "p.id">>;

// UPDATE
type U1 = ParseWrite<"update product set title = :title, price = :price where id = :id returning id">;
type _u1 = Expect<Equal<U1["kind"], "update">>;
type _u2 = Expect<Equal<U1["table"], "product">>;
type _u3 = Expect<Equal<U1["targets"], ["title", "price"]>>;
type _u4 = Expect<Equal<U1["returning"], "id">>;

// UPDATE with alias
type U2 = ParseWrite<"update product p set title = :t where p.id = :id">;
type _u5 = Expect<Equal<U2["alias"], "p">>;
type _u6 = Expect<Equal<U2["targets"], ["title"]>>;

// DELETE
type D1 = ParseWrite<"delete from product where id = :id returning id, title">;
type _d1 = Expect<Equal<D1["kind"], "delete">>;
type _d2 = Expect<Equal<D1["table"], "product">>;
type _d3 = Expect<Equal<D1["returning"], "id , title">>;

type D2 = ParseWrite<"delete from product p where p.id = :id">;
type _d4 = Expect<Equal<D2["alias"], "p">>;
type _d5 = Expect<Equal<D2["returning"], "">>;
