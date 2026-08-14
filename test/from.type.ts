import type { ParseFrom } from "../src/type/from.ts";
import type { Words, SplitTopLevel, Trim, AfterLast, BeforeLast } from "../src/type/string.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

// string utils
type _w1 = Expect<Equal<Words<"  a\n  b\tc ">, ["a","b","c"]>>;
type _w2 = Expect<Equal<Trim<"  hi  ">, "hi">>;
type _w3 = Expect<Equal<SplitTopLevel<"a, b, c">, ["a"," b"," c"]>>;
type _w4 = Expect<Equal<SplitTopLevel<"count(a, b) as n, x">, ["count(a, b) as n"," x"]>>;
type _w5 = Expect<Equal<AfterLast<"a::b::c", "::">, "c">>;
type _w6 = Expect<Equal<BeforeLast<"a::b::c", "::">, "a::b">>;

// simple
type _f1 = Expect<Equal<ParseFrom<"product">, [{table:"product";alias:"product";nullable:false}]>>;
type _f2 = Expect<Equal<ParseFrom<"product p">, [{table:"product";alias:"p";nullable:false}]>>;
type _f3 = Expect<Equal<ParseFrom<"product as p">, [{table:"product";alias:"p";nullable:false}]>>;

// inner join -> nothing nullable
type _f4 = Expect<Equal<
  ParseFrom<"product p join variant v on v.product_id = p.id">,
  [{table:"product";alias:"p";nullable:false},{table:"variant";alias:"v";nullable:false}]
>>;

// LEFT JOIN -> right side nullable
type _f5 = Expect<Equal<
  ParseFrom<"product p left join variant v on v.product_id = p.id">,
  [{table:"product";alias:"p";nullable:false},{table:"variant";alias:"v";nullable:true}]
>>;

// LEFT OUTER JOIN, uppercase
type _f6 = Expect<Equal<
  ParseFrom<"product P LEFT OUTER JOIN variant V ON V.product_id = P.id">,
  [{table:"product";alias:"P";nullable:false},{table:"variant";alias:"V";nullable:true}]
>>;

// RIGHT JOIN -> prior side nullable
type _f7 = Expect<Equal<
  ParseFrom<"product p right join variant v on v.product_id = p.id">,
  [{table:"product";alias:"p";nullable:true},{table:"variant";alias:"v";nullable:false}]
>>;

// FULL JOIN -> both nullable
type _f8 = Expect<Equal<
  ParseFrom<"product p full outer join variant v on v.product_id = p.id">,
  [{table:"product";alias:"p";nullable:true},{table:"variant";alias:"v";nullable:true}]
>>;

// three-way chain, left join then inner join
type _f9 = Expect<Equal<
  ParseFrom<"product p left join variant v on v.product_id = p.id join supplier s on s.id = p.supplier_id">,
  [{table:"product";alias:"p";nullable:false},{table:"variant";alias:"v";nullable:true},{table:"supplier";alias:"s";nullable:false}]
>>;

// comma join
type _f10 = Expect<Equal<
  ParseFrom<"product p, variant v">,
  [{table:"product";alias:"p";nullable:false},{table:"variant";alias:"v";nullable:false}]
>>;

// multiline
type _f11 = Expect<Equal<
  ParseFrom<"\n  product p\n  left join variant v on v.product_id = p.id\n">,
  [{table:"product";alias:"p";nullable:false},{table:"variant";alias:"v";nullable:true}]
>>;
