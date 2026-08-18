import { describe, it, expect } from "vitest";
import { InMemoryDataAdapter } from "./in-memory";

describe("InMemoryDataAdapter", () => {
  it("returns the series registered for a symbol/timeframe pair", async () => {
    const bars = [{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }];
    const adapter = new InMemoryDataAdapter();
    adapter.register("NIFTY 50", "1d", bars);
    expect(await adapter.getSeries("NIFTY 50", "1d")).toEqual(bars);
  });

  it("throws for an unregistered symbol/timeframe pair", async () => {
    const adapter = new InMemoryDataAdapter();
    await expect(adapter.getSeries("NOPE", "1d")).rejects.toThrow();
  });

  it("returns registered symbol meta, or undefined behavior if none registered", async () => {
    const adapter = new InMemoryDataAdapter();
    adapter.registerMeta("RELIANCE", "NSE", (t) => t > 100);
    const meta = await adapter.getSymbolMeta!("RELIANCE");
    expect(meta.exchange).toBe("NSE");
    expect(meta.sessionOpen(50)).toBe(false);
    expect(meta.sessionOpen(150)).toBe(true);
  });
});
