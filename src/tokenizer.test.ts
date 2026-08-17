import { describe, it, expect } from "vitest";
import { tokenize } from "./tokenizer";

describe("tokenize", () => {
  it("tokenizes numbers, identifiers, and operators", () => {
    const tokens = tokenize("fast_ema = ema(close, 20) - 2.5");
    expect(tokens.map(t => t.kind)).toEqual([
      "ident", "eq", "ident", "lparen", "ident", "comma", "number", "rparen",
      "minus", "number", "eof",
    ]);
  });

  it("tokenizes strings", () => {
    const tokens = tokenize('color("#2196F3")');
    expect(tokens[2]).toMatchObject({ kind: "string", value: "#2196F3" });
  });

  it("tokenizes dotted namespace access", () => {
    const tokens = tokenize("input.length");
    expect(tokens.map(t => t.kind)).toEqual(["ident", "dot", "ident", "eof"]);
  });

  it("tokenizes keywords distinctly from identifiers", () => {
    const tokens = tokenize("a and b or not c");
    expect(tokens.map(t => t.kind)).toEqual([
      "ident", "and", "ident", "or", "not", "ident", "eof",
    ]);
  });

  it("tokenizes all comparison and arithmetic operators", () => {
    const tokens = tokenize("a >= b <= c == d != e");
    expect(tokens.map(t => t.kind)).toEqual([
      "ident", "gte", "ident", "lte", "ident", "eq2", "ident", "neq", "ident", "eof",
    ]);
  });

  it("strips comments to end of line", () => {
    const tokens = tokenize("a = 1 # this is a comment\nb = 2");
    expect(tokens.map(t => t.kind)).toEqual(["ident", "eq", "number", "ident", "eq", "number", "eof"]);
  });

  it("reports the line and column of each token", () => {
    const tokens = tokenize("a = 1\nb = 2");
    expect(tokens[3]).toMatchObject({ kind: "ident", value: "b", line: 2, col: 1 });
  });

  it("throws with position info on an unrecognized character", () => {
    expect(() => tokenize("a = @")).toThrow(/line 1/);
  });
});
