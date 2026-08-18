import { describe, it, expect } from "vitest";
import { parse, ParseError } from "./parser";

describe("parse", () => {
  it("parses a simple formula", () => {
    const program = parse("x = close");
    expect(program).toEqual([{ kind: "formula", name: "x", expr: { kind: "ident", name: "close" } }]);
  });

  it("parses arithmetic with correct precedence", () => {
    const program = parse("x = 2 + 3 * 4");
    const [{ expr }] = program as any;
    expect(expr).toEqual({
      kind: "binary", op: "+",
      left: { kind: "number", value: 2 },
      right: { kind: "binary", op: "*", left: { kind: "number", value: 3 }, right: { kind: "number", value: 4 } },
    });
  });

  it("parses a function call", () => {
    const program = parse("x = sma(close, 20)");
    const [{ expr }] = program as any;
    expect(expr).toEqual({
      kind: "call", name: "sma",
      args: [{ kind: "ident", name: "close" }, { kind: "number", value: 20 }],
      namedArgs: {},
    });
  });

  it("parses a named argument", () => {
    const program = parse('x = band(1, 2, color=input.c)');
    const [{ expr }] = program as any;
    expect(expr.namedArgs).toEqual({ color: { kind: "namespaced", namespace: "input", member: "c" } });
  });

  it("parses an input declaration", () => {
    const program = parse("input length = int(14, min=2, max=200)");
    expect(program).toEqual([{ kind: "input", name: "length", type: "int", defaultValue: 14, min: 2, max: 200 }]);
  });

  it("allows a later formula to reference an earlier one", () => {
    const program = parse("a = close\nb = a + 1");
    expect(program).toHaveLength(2);
  });

  it("rejects a forward reference", () => {
    expect(() => parse("a = b\nb = close")).toThrow(ParseError);
  });

  it("rejects redeclaring a reserved word as a formula name", () => {
    expect(() => parse("sma = close")).toThrow(ParseError);
  });

  it("rejects an unknown function name", () => {
    expect(() => parse("x = notarealfunction(close)")).toThrow(ParseError);
  });

  it("rejects a function called with the wrong number of arguments", () => {
    expect(() => parse("x = sma(close)")).toThrow(ParseError);
  });

  it("accepts highestbars/lowestbars/log/sqrt/exp with correct arity and rejects wrong arity", () => {
    expect(() => parse("x = highestbars(high, 14)")).not.toThrow();
    expect(() => parse("x = lowestbars(low, 14)")).not.toThrow();
    expect(() => parse("x = log(close)")).not.toThrow();
    expect(() => parse("x = sqrt(close)")).not.toThrow();
    expect(() => parse("x = exp(close)")).not.toThrow();
    expect(() => parse("x = highestbars(high)")).toThrow(ParseError);
    expect(() => parse("x = log(close, 2)")).toThrow(ParseError);
    expect(() => parse("x = exp(close, 2)")).toThrow(ParseError);
  });

  it("parses and/or/not with correct precedence (and binds tighter than or)", () => {
    const program = parse("x = open and high or low");
    const [{ expr }] = program as any;
    expect(expr).toEqual({
      kind: "binary", op: "or",
      left: { kind: "binary", op: "and", left: { kind: "ident", name: "open" }, right: { kind: "ident", name: "high" } },
      right: { kind: "ident", name: "low" },
    });
  });

  it("parses a comparison", () => {
    const program = parse("x = close > 100");
    const [{ expr }] = program as any;
    expect(expr).toEqual({ kind: "binary", op: ">", left: { kind: "ident", name: "close" }, right: { kind: "number", value: 100 } });
  });

  it("parses parenthesized expressions", () => {
    const program = parse("x = (2 + 3) * 4");
    const [{ expr }] = program as any;
    expect((expr as any).left).toEqual({ kind: "binary", op: "+", left: { kind: "number", value: 2 }, right: { kind: "number", value: 3 } });
  });

  it("throws ParseError with line/col on a syntax error", () => {
    try {
      parse("x = +");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ParseError);
      expect((e as ParseError).line).toBe(1);
    }
  });
});
