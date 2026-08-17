import { describe, it, expect } from "vitest";
import { sma, ema, wma, stdev, highest, lowest, sum } from "./windowed";

describe("windowed functions", () => {
  const series = [1, 2, 3, 4, 5];

  it("sma averages the last n values", () => {
    expect(sma(series, 3, 4)).toBeCloseTo((3 + 4 + 5) / 3);
    expect(sma(series, 3, 1)).toBeNaN(); // not enough history yet (needs index >= n-1)
  });

  it("ema weights recent values more heavily and matches a known reference value", () => {
    // 3-period EMA over [1,2,3,4,5], alpha = 2/(3+1) = 0.5
    // seed = sma(indices 0..2) = 2; then at k=3: 0.5*4 + 0.5*2 = 3; at k=4: 0.5*5 + 0.5*3 = 4
    expect(ema(series, 3, 4)).toBeCloseTo(4);
  });

  it("wma weights linearly by recency", () => {
    // weights 1,2,3 over [3,4,5] (index 4, n=3): (3*1+4*2+5*3)/(1+2+3) = 26/6
    expect(wma(series, 3, 4)).toBeCloseTo(26 / 6);
  });

  it("stdev computes population stdev over the window", () => {
    const window = [3, 4, 5];
    const mean = 4;
    const expected = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / 3);
    expect(stdev(series, 3, 4)).toBeCloseTo(expected);
  });

  it("highest/lowest find the max/min over the window", () => {
    expect(highest(series, 3, 4)).toBe(5);
    expect(lowest(series, 3, 4)).toBe(3);
  });

  it("sum totals the window", () => {
    expect(sum(series, 3, 4)).toBe(3 + 4 + 5);
  });

  it("all windowed functions return NaN before enough history exists", () => {
    expect(sma(series, 3, 0)).toBeNaN();
    expect(highest(series, 3, 0)).toBeNaN();
  });
});
