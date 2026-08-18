// @vitest-environment happy-dom
// klinecharts checks `window` at import time (not just at render time) — a
// plain Node environment can't even load the module, real browser-charting
// library, real constraint. Scoped to this one file so every other test
// keeps the faster default Node environment.
import { describe, it, expect, vi } from "vitest";
import { registerDiascriptIndicator, attachDiascriptIndicator, buildCalc } from "./adapter";
import { InMemoryDataAdapter } from "../../data/in-memory";
import type { Chart } from "klinecharts";

/** attachDiascriptIndicator needs a live Chart instance (real klinecharts
 * init() needs a DOM/canvas, unavailable in this Node test env) — mocked
 * here. registerDiascriptIndicator itself calls the REAL klinecharts
 * registerIndicator function, genuinely exercised: these tests fail if the
 * template this adapter builds doesn't match what klinecharts actually
 * accepts, not just what a hand-written mock was told to accept. */
function fakeChart(): Chart {
  return { createIndicator: vi.fn() } as unknown as Chart;
}

describe("registerDiascriptIndicator / attachDiascriptIndicator", () => {
  it("registers a real klinecharts indicator backed by a line-wrapped diascript formula", () => {
    expect(() => registerDiascriptIndicator("myline", {
      source: "x = line(close)",
      outputName: "x",
      adapter: new InMemoryDataAdapter(),
      symbolTicker: "T",
    })).not.toThrow();
  });

  it("registers a band-wrapped formula with two figures", () => {
    expect(() => registerDiascriptIndicator("myband", {
      source: "x = band(close + 1, close - 1)",
      outputName: "x",
      adapter: new InMemoryDataAdapter(),
      symbolTicker: "T",
    })).not.toThrow();
  });

  it("registers a marker-wrapped formula", () => {
    expect(() => registerDiascriptIndicator("mymarker", {
      source: 'x = marker(close > 1, "triangle-up", "green")',
      outputName: "x",
      adapter: new InMemoryDataAdapter(),
      symbolTicker: "T",
    })).not.toThrow();
  });

  it("throws immediately (synchronously, before any calc runs) for an unknown output name", () => {
    expect(() => registerDiascriptIndicator("bad", {
      source: "x = line(close)",
      outputName: "does_not_exist",
      adapter: new InMemoryDataAdapter(),
      symbolTicker: "T",
    })).toThrow(/not a rendered/);
  });

  it("throws for an output type klinecharts has no confirmed built-in figure for", () => {
    expect(() => registerDiascriptIndicator("bad2", {
      source: 'x = barcolor(close > 1, "green", "red")',
      outputName: "x",
      adapter: new InMemoryDataAdapter(),
      symbolTicker: "T",
    })).toThrow(/not yet supported/);
  });

  it("attaches a registered indicator to a chart instance", () => {
    registerDiascriptIndicator("attachtest", {
      source: "x = line(close)",
      outputName: "x",
      adapter: new InMemoryDataAdapter(),
      symbolTicker: "T",
    });
    const chart = fakeChart();

    attachDiascriptIndicator(chart, "attachtest");

    expect(chart.createIndicator).toHaveBeenCalledWith("attachtest");
  });

  it("calc actually recomputes from the dataList it's given, not a frozen snapshot — the real bug the old adapter had", async () => {
    const calc = buildCalc({
      source: "x = line(close)",
      outputName: "x",
      adapter: new InMemoryDataAdapter(),
      symbolTicker: "T",
    });

    const short = await calc([{ timestamp: 0, open: 1, high: 1, low: 1, close: 1 }]);
    const longer = await calc([
      { timestamp: 0, open: 1, high: 1, low: 1, close: 1 },
      { timestamp: 60_000, open: 2, high: 2, low: 2, close: 2 },
      { timestamp: 120_000, open: 3, high: 3, low: 3, close: 3 },
    ]);

    expect(short).toHaveLength(1);
    expect(longer).toHaveLength(3);
    expect((longer[2] as any).value).toBe(3);
  });
});
