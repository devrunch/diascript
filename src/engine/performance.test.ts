import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { evaluateFormulaSeries } from "./evaluator";
import type { EvalContext, OHLCV } from "./types";

function bars(n: number): OHLCV[] {
  const out: OHLCV[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += Math.sin(i / 7);
    out.push({ time: i, open: price, high: price + 1, low: price - 1, close: price, volume: 1000 });
  }
  return out;
}

function ctx(b: OHLCV[]): EvalContext {
  return { bars: b, completed: new Map(), self: [], currentFormula: "x", inputs: {}, externalSeries: new Map(), symbolTicker: "T", pushDiagnostic: () => {} };
}

function timeEval(n: number): number {
  const [{ expr }] = parse("x = ema(close, 20) + sma(close, 50) + rsi(close, 14)") as any;
  const start = performance.now();
  evaluateFormulaSeries(expr, ctx(bars(n)));
  return performance.now() - start;
}

describe("windowed/rsi evaluation scales linearly with bar count, not quadratically", () => {
  it("4x the bars takes nowhere near 16x the time", () => {
    // Warm up the JIT once before measuring, so a cold-start doesn't skew
    // the smaller sample.
    timeEval(500);

    const small = timeEval(1000);
    const large = timeEval(4000);

    // A true O(n^2) implementation would show ~16x here (this was the real,
    // measured regression before seriesUpTo/rsiAt were memoized). A
    // generous 8x threshold gives a robust regression signal without being
    // flaky on a slow CI box, while still catching a real quadratic blowup.
    expect(large).toBeLessThan(Math.max(small * 8, 50));
  });
});
