import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { evaluate } from "./engine/engine";
import { InMemoryDataAdapter } from "./adapters/data/in-memory";
import type { OHLCV } from "./engine/types";

function syntheticBars(n: number, startTime: number, stepSeconds: number): OHLCV[] {
  const bars: OHLCV[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += Math.sin(i / 10) * 2;
    bars.push({ time: startTime + i * stepSeconds, open: price, high: price + 1, low: price - 1, close: price, volume: 1000 });
  }
  return bars;
}

describe("end-to-end: trend-regime.dia", () => {
  it("evaluates the full worked example against synthetic data without throwing", async () => {
    const source = readFileSync(new URL("../spec/examples/trend-regime.dia", import.meta.url), "utf-8");
    const fiveMin = syntheticBars(200, 0, 300);
    const daily = syntheticBars(30, 0, 86400);

    const adapter = new InMemoryDataAdapter();
    adapter.register("TESTSYM", "1d", daily);
    adapter.registerMeta("TESTSYM", "NSE", () => true);

    const result = await evaluate(source, fiveMin, adapter, "TESTSYM");

    expect(result.outputs.fast_line).toBeDefined();
    expect(result.outputs.slow_line).toBeDefined();
    expect(result.outputs.band_out).toBeDefined();
    expect(result.outputs.entry_marker).toBeDefined();
    expect(result.outputs.regime_bg).toBeDefined();
    expect(result.outputs.trend_fill).toEqual({ type: "fill", between: ["fast_line", "slow_line"], color: "#90caf9" });

    expect(result.values.swing_high).toHaveLength(200);
    expect(result.values.entry_long).toHaveLength(200);
  });
});
