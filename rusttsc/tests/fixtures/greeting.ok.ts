// A small program that checks clean: hoisted function, union annotation,
// literal widening, and a well-typed call.
const version: number = 1;

function label(name: string, suffix: string): string {
    return name + suffix;
}

let title = "release";
let tag: string = label(title, " candidate");

let count: number | string = version + 1;
