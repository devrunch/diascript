import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { evaluateFormulaSeries } from "./evaluator";
import type { EvalContext, OHLCV } from "./types";

function bar(o: number, h: number, l: number, c: number, t: number): OHLCV {
  return { time: t, open: o, high: h, low: l, close: c, volume: 100 };
}
function ctx(bars: OHLCV[]): EvalContext {
  return { bars, completed: new Map(), self: [], currentFormula: "x", inputs: {}, externalSeries: new Map(), symbolTicker: "T", pushDiagnostic: () => {} };
}

describe("built-in derived series", () => {
  it("true_range is max(high-low, |high-prevClose|, |low-prevClose|)", () => {
    const bars = [bar(10, 12, 9, 11, 0), bar(11, 15, 10, 14, 1)];
    const [{ expr }] = parse("x = true_range()") as any;
    const result = evaluateFormulaSeries(expr, ctx(bars));
    expect(result[0]).toBe(12 - 9);
    expect(result[1]).toBeCloseTo(Math.max(15 - 10, Math.abs(15 - 11), Math.abs(10 - 11)));
  });

  it("typical_price is (h+l+c)/3", () => {
    const bars = [bar(10, 12, 9, 11, 0)];
    const [{ expr }] = parse("x = typical_price()") as any;
    expect(evaluateFormulaSeries(expr, ctx(bars))[0]).toBeCloseTo((12 + 9 + 11) / 3);
  });

  it("rsi is 100 for a series with no losses at all", () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(i, i, i, i + 1, i));
    const [{ expr }] = parse("x = rsi(close, 14)") as any;
    const result = evaluateFormulaSeries(expr, ctx(bars));
    expect(result[19]).toBeCloseTo(100, 0);
  });

  it("rsi is 0 for a series with no gains at all", () => {
    const bars = Array.from({ length: 20 }, (_, i) => bar(20 - i, 20 - i, 20 - i, 20 - i - 1, i));
    const [{ expr }] = parse("x = rsi(close, 14)") as any;
    const result = evaluateFormulaSeries(expr, ctx(bars));
    expect(result[19]).toBeCloseTo(0, 0);
  });
});
