import { describe, it, expect } from "vitest";
import { parse } from "../parser";
import { prefetchExternalSeries } from "./prefetch";
import { InMemoryDataAdapter } from "../adapters/data/in-memory";
import type { OHLCV } from "./types";

function bars(times: number[]): OHLCV[] {
  return times.map(t => ({ time: t, open: t, high: t, low: t, close: t, volume: 1 }));
}

describe("prefetchExternalSeries", () => {
  it("forward-fills a lower-resolution series to align with the primary bars", async () => {
    const adapter = new InMemoryDataAdapter();
    adapter.register("TEST", "1d", bars([0, 100]).map((b, idx) => ({ ...b, close: idx === 0 ? 10 : 20 })));
    const primary = bars([0, 30, 60, 90, 120, 150]);
    const program = parse('x = series("TEST", "1d", "close")');

    const { externalSeries } = await prefetchExternalSeries(program, primary, adapter, "TEST");

    const key = [...externalSeries.keys()][0];
    expect(externalSeries.get(key)).toEqual([10, 10, 10, 10, 20, 20]);
  });

  it("resolves session/exchange meta once via getSymbolMeta", async () => {
    const adapter = new InMemoryDataAdapter();
    adapter.registerMeta("TEST", "NSE", (t) => t >= 50);
    const primary = bars([0, 100]);
    const program = parse("x = session.is_open()");

    const { sessionOpen, exchange } = await prefetchExternalSeries(program, primary, adapter, "TEST");

    expect(exchange).toBe("NSE");
    expect(sessionOpen!(0)).toBe(false);
    expect(sessionOpen!(100)).toBe(true);
  });

  it("does nothing if the program uses no external series or context", async () => {
    const adapter = new InMemoryDataAdapter();
    const program = parse("x = close");
    const { externalSeries } = await prefetchExternalSeries(program, bars([0]), adapter, "TEST");
    expect(externalSeries.size).toBe(0);
  });
});
