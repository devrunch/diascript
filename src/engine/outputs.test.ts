import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { buildOutput } from "./outputs";
import type { EvalContext, OHLCV } from "./types";

function bars(closes: number[]): OHLCV[] {
  return closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 1 }));
}

describe("buildOutput", () => {
  it("returns null for a bare (unwrapped) formula", () => {
    const [{ expr }] = parse("x = close") as any;
    expect(buildOutput("x", expr, bars([1]))).toBeNull();
  });

  it("wraps a line() output", () => {
    const [{ expr }] = parse("x = line(close)") as any;
    const b = bars([1, 2]);
    expect(buildOutput("x", expr, b)).toEqual({
      type: "line", points: [{ time: 0, value: 1 }, { time: 1, value: 2 }],
    });
  });

  it("wraps a band() output with upper and lower", () => {
    const [{ expr }] = parse("x = band(close + 1, close - 1)") as any;
    const b = bars([10]);
    expect(buildOutput("x", expr, b)).toEqual({
      type: "band", upper: [{ time: 0, value: 11 }], lower: [{ time: 0, value: 9 }],
    });
  });

  it("wraps a band() with a color, including an input.<name> color reference (not just a string literal)", () => {
    const [{ expr }] = parse('x = band(close + 1, close - 1, color=input.c)') as any;
    const b = bars([10]);
    const ctx: EvalContext = { bars: b, completed: new Map(), self: [], currentFormula: "x", inputs: { c: "#2196F3" }, externalSeries: new Map(), symbolTicker: "T", pushDiagnostic: () => {} };
    const result = buildOutput("x", expr, b, ctx);
    expect((result as any).color).toBe("#2196F3");
  });

  it("wraps a marker() output, only at points where the condition is true", () => {
    const [{ expr }] = parse('x = marker(close > 1, "triangle-up", "green")') as any;
    const b = bars([1, 2]);
    expect(buildOutput("x", expr, b)).toEqual({
      type: "marker", points: [{ time: 1, shape: "triangle-up", color: "green" }],
    });
  });

  it("wraps a histogram() output", () => {
    const [{ expr }] = parse("x = histogram(close)") as any;
    expect(buildOutput("x", expr, bars([5]))).toEqual({ type: "histogram", points: [{ time: 0, value: 5 }] });
  });

  it("wraps a barcolor() output", () => {
    const [{ expr }] = parse('x = barcolor(close > 1, "green", "red")') as any;
    const b = bars([1, 2]);
    expect(buildOutput("x", expr, b)).toEqual({
      type: "barcolor", points: [{ time: 0, color: "red" }, { time: 1, color: "green" }],
    });
  });

  it("wraps a background() output, only at points where the condition is true", () => {
    const [{ expr }] = parse('x = background(close > 1, "#eee")') as any;
    const b = bars([1, 2]);
    expect(buildOutput("x", expr, b)).toEqual({
      type: "background", points: [{ time: 1, color: "#eee" }],
    });
  });
});
