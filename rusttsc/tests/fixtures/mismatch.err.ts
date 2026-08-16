// Every statement below is a distinct error the checker should catch.
const port: number = "8080";        // TS2322: string literal into number
let missing = notDeclared;          // TS2304: cannot find name

function add(a: number, b: number): number {
    return a + b;
}

add(1);                             // TS2554: wrong arity
add(1, "two");                      // TS2345: bad argument type

const n = 5;
n();                                // TS2349: not callable
