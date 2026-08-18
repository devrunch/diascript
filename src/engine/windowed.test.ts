import { describe, it, expect } from "vitest";
import { sma, ema, wma, stdev, highest, lowest, sum, highestbars, lowestbars } from "./windowed";

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

  it("highestbars returns 0 when the most recent bar in the window is the highest", () => {
    // window [3,4,5] at index 4, n=3 — index 4 (value 5) is highest, 0 bars back
    expect(highestbars(series, 3, 4)).toBe(0);
  });

  it("highestbars returns the offset of an earlier bar when it's the highest", () => {
    const s = [1, 10, 2, 3, 4];
    // window at index 4, n=5: [1,10,2,3,4] — value 10 is at index 1, which is
    // 3 bars back from index 4 (4-1=3)
    expect(highestbars(s, 5, 4)).toBe(3);
  });

  it("lowestbars returns the offset of the lowest bar in the window", () => {
    const s = [5, 1, 4, 3, 2];
    // window at index 4, n=5: [5,1,4,3,2] — value 1 is at index 1, 3 bars back
    expect(lowestbars(s, 5, 4)).toBe(3);
  });

  it("highestbars favors the most recent bar on a tie", () => {
    const s = [1, 5, 2, 5, 3];
    // window at index 4, n=5: [1,5,2,5,3] — value 5 ties at index 1 and 3;
    // index 3 is more recent (1 bar back) than index 1 (3 bars back)
    expect(highestbars(s, 5, 4)).toBe(1);
  });

  it("highestbars/lowestbars return NaN before enough history exists", () => {
    expect(highestbars(series, 3, 0)).toBeNaN();
    expect(lowestbars(series, 3, 0)).toBeNaN();
  });
});
