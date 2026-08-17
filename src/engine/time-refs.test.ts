import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { evaluateFormulaSeries } from "./evaluator";
import type { EvalContext, OHLCV } from "./types";

function bars(closes: number[]): OHLCV[] {
  return closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 100 }));
}
function ctx(overrides: Partial<EvalContext> = {}): EvalContext {
  return {
    bars: bars([10, 20, 30, 40]), completed: new Map(), self: [], currentFormula: "x",
    inputs: {}, externalSeries: new Map(), symbolTicker: "TEST", pushDiagnostic: () => {},
    ...overrides,
  };
}

describe("ref() and prev()", () => {
  it("ref(x, n) reads n bars back", () => {
    const [{ expr }] = parse("x = ref(close, 1)") as any;
    expect(evaluateFormulaSeries(expr, ctx())).toEqual([NaN, 10, 20, 30]);
  });

  it("ref(x, 0) is the current bar", () => {
    const [{ expr }] = parse("x = ref(close, 0)") as any;
    expect(evaluateFormulaSeries(expr, ctx())).toEqual([10, 20, 30, 40]);
  });

  it("prev(n) reads this formula's own value n bars back, enabling recursion", () => {
    // a running total: this_bar_close + previous_running_total
    const [{ expr }] = parse("x = close + prev(1)") as any;
    const result = evaluateFormulaSeries(expr, ctx());
    expect(result[0]).toBe(10); // prev(1) at bar 0 has no history -> treated as 0
    expect(result[1]).toBe(30); // 20 + 10
    expect(result[2]).toBe(60); // 30 + 30
    expect(result[3]).toBe(100); // 40 + 60
  });

  it("prev(n) before enough history defaults to 0, not NaN, so recursive formulas can bootstrap", () => {
    const [{ expr }] = parse("x = prev(1) * 0.9 + close * 0.1") as any;
    const result = evaluateFormulaSeries(expr, ctx());
    expect(result[0]).toBeCloseTo(1); // prev(1)=0 -> 0*0.9 + 10*0.1 = 1
  });
});
