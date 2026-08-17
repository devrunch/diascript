import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { evaluateFormulaSeries } from "./evaluator";
import type { EvalContext, OHLCV } from "./types";

function bars(closes: number[]): OHLCV[] {
  return closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 100 }));
}

describe("held()", () => {
  it("updates on the condition and carries forward indefinitely otherwise", () => {
    const [{ expr }] = parse("x = held(close > ref(close, 1), close)") as any;
    const ctx: EvalContext = { bars: bars([1, 5, 5, 5, 9, 9]), completed: new Map(), self: [], currentFormula: "x", inputs: {}, externalSeries: new Map(), symbolTicker: "T", pushDiagnostic: () => {} };
    const result = evaluateFormulaSeries(expr, ctx);
    expect(result).toEqual([0, 5, 5, 5, 9, 9]);
  });

  it("persists across many bars, not just a fixed lookback", () => {
    const [{ expr }] = parse("x = held(close > ref(close, 1), close)") as any;
    const ctx: EvalContext = { bars: bars([10, 1, 1, 1, 1, 1, 1, 1, 1, 1]), completed: new Map(), self: [], currentFormula: "x", inputs: {}, externalSeries: new Map(), symbolTicker: "T", pushDiagnostic: () => {} };
    const result = evaluateFormulaSeries(expr, ctx);
    expect(result[9]).toBe(0);
  });
});
