import { describe, it, expect } from "vitest";
import { evaluate } from "./engine";
import { InMemoryDataAdapter } from "../adapters/data/in-memory";
import type { OHLCV } from "./types";

function bars(closes: number[]): OHLCV[] {
  return closes.map((c, i) => ({ time: i, open: c, high: c, low: c, close: c, volume: 1 }));
}

describe("evaluate", () => {
  it("populates values for every formula, wrapped or not", async () => {
    const result = await evaluate("helper = close * 2\nout = line(helper)", bars([1, 2]), new InMemoryDataAdapter(), "T");
    expect(result.values.helper).toEqual([2, 4]);
    expect(result.values.out).toBeDefined();
  });

  it("populates outputs only for wrapped formulas", async () => {
    const result = await evaluate("helper = close * 2\nout = line(helper)", bars([1, 2]), new InMemoryDataAdapter(), "T");
    expect(Object.keys(result.outputs)).toEqual(["out"]);
  });

  it("resolves inputs, applying overrides", async () => {
    const result = await evaluate(
      "input length = int(14, min=2, max=200)\nout = line(sma(close, input.length))",
      bars([1, 2, 3]), new InMemoryDataAdapter(), "T", { length: 2 },
    );
    expect(result.values.out).toBeDefined();
  });

  it("aggregates diagnostics per (formula, message), not one per bar", async () => {
    const result = await evaluate("out = line(1 / (close - close))", bars([1, 1, 1, 1, 1]), new InMemoryDataAdapter(), "T");
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0].count).toBe(5);
    expect(result.diagnostics[0].firstBarIndex).toBe(0);
    expect(result.diagnostics[0].lastBarIndex).toBe(4);
  });

  it("resolves a fill() output's referenced names against the already-built outputs", async () => {
    const result = await evaluate(
      "a = line(close)\nb = line(close + 1)\nc = fill(a, b, \"blue\")",
      bars([1]), new InMemoryDataAdapter(), "T",
    );
    expect(result.outputs.c).toEqual({ type: "fill", between: ["a", "b"], color: "blue" });
  });
});
