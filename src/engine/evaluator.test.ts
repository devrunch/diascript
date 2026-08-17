import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { evaluateFormulaSeries } from "./evaluator";
import type { EvalContext, OHLCV } from "./types";

function bars(closes: number[]): OHLCV[] {
  return closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 100 }));
}

function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    bars: bars([1, 2, 3]),
    completed: new Map(),
    self: [],
    currentFormula: "x",
    inputs: {},
    externalSeries: new Map(),
    symbolTicker: "TEST",
    pushDiagnostic: () => {},
    ...overrides,
  };
}

describe("evaluateFormulaSeries — point-wise math and comparisons", () => {
  it("evaluates raw series references", () => {
    const [{ expr }] = parse("x = close") as any;
    expect(evaluateFormulaSeries(expr, ctx())).toEqual([1, 2, 3]);
  });

  it("evaluates arithmetic", () => {
    const [{ expr }] = parse("x = close * 2 + 1") as any;
    expect(evaluateFormulaSeries(expr, ctx())).toEqual([3, 5, 7]);
  });

  it("evaluates abs/min/max", () => {
    expect(evaluateFormulaSeries((parse("x = abs(close - 2)") as any)[0].expr, ctx())).toEqual([1, 0, 1]);
    expect(evaluateFormulaSeries((parse("x = min(close, 2)") as any)[0].expr, ctx())).toEqual([1, 2, 2]);
    expect(evaluateFormulaSeries((parse("x = max(close, 2)") as any)[0].expr, ctx())).toEqual([2, 2, 3]);
  });

  it("evaluates comparisons to booleans", () => {
    expect(evaluateFormulaSeries((parse("x = close > 1") as any)[0].expr, ctx())).toEqual([false, true, true]);
  });

  it("evaluates and/or/not", () => {
    const c = ctx();
    expect(evaluateFormulaSeries((parse("x = close > 1 and close < 3") as any)[0].expr, c)).toEqual([false, true, false]);
    expect(evaluateFormulaSeries((parse("x = close > 1 or close < 1") as any)[0].expr, c)).toEqual([false, true, true]);
    expect(evaluateFormulaSeries((parse("x = not (close > 1)") as any)[0].expr, c)).toEqual([true, false, false]);
  });

  it("resolves a reference to an earlier, already-completed formula", () => {
    const c = ctx({ completed: new Map([["y", [10, 20, 30]]]) });
    const [decl1, decl2] = parse("y = close\nx = y + 1") as any;
    expect(evaluateFormulaSeries(decl2.expr, c)).toEqual([11, 21, 31]);
  });

  it("divide-by-zero degrades to NaN and pushes a diagnostic", () => {
    const diagnostics: string[] = [];
    const c = ctx({ bars: bars([0, 1, 2]), pushDiagnostic: (m) => diagnostics.push(m) });
    const result = evaluateFormulaSeries((parse("x = 1 / close") as any)[0].expr, c);
    expect(result[0]).toBeNaN();
    expect(diagnostics.length).toBeGreaterThan(0);
  });
});
