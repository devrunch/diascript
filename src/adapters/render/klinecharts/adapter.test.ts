// @vitest-environment happy-dom
// klinecharts checks `window` at import time (not just at render time) — a
// plain Node environment can't even load the module, real browser-charting
// library, real constraint. Scoped to this one file so every other test
// keeps the faster default Node environment.
import { describe, it, expect, vi } from "vitest";
import { renderToKlinecharts } from "./adapter";
import type { Chart } from "klinecharts";
import type { IndicatorOutput } from "../../../engine/types";

/** createIndicator needs a live Chart instance (real klinecharts init()
 * needs a DOM/canvas, unavailable in this Node test env) — mocked here.
 * registerIndicator itself is the REAL klinecharts function, genuinely
 * exercised: these tests fail if the template shape this adapter builds
 * doesn't match what klinecharts actually accepts, not just what a
 * hand-written mock was told to accept. */
function fakeChart(): Chart {
  return { createIndicator: vi.fn() } as unknown as Chart;
}

describe("renderToKlinecharts", () => {
  it("registers a real klinecharts line-type indicator and attaches it to the chart", () => {
    const chart = fakeChart();
    const output: IndicatorOutput = { type: "line", points: [{ time: 0, value: 1 }] };

    expect(() => renderToKlinecharts(chart, "myline", output)).not.toThrow();

    expect(chart.createIndicator).toHaveBeenCalledWith("myline");
  });

  it("registers a real band indicator with two figures", () => {
    const chart = fakeChart();
    const output: IndicatorOutput = {
      type: "band",
      upper: [{ time: 0, value: 2 }],
      lower: [{ time: 0, value: 1 }],
    };

    expect(() => renderToKlinecharts(chart, "myband", output)).not.toThrow();
  });

  it("registers a real marker indicator", () => {
    const chart = fakeChart();
    const output: IndicatorOutput = { type: "marker", points: [{ time: 0, shape: "triangle-up", color: "green" }] };

    expect(() => renderToKlinecharts(chart, "mymarker", output)).not.toThrow();
  });

  it("registers a real histogram indicator", () => {
    const chart = fakeChart();
    const output: IndicatorOutput = { type: "histogram", points: [{ time: 0, value: 3 }] };

    expect(() => renderToKlinecharts(chart, "myhist", output)).not.toThrow();
  });

  it("registers a real background indicator", () => {
    const chart = fakeChart();
    const output: IndicatorOutput = { type: "background", points: [{ time: 0, color: "#eee" }] };

    expect(() => renderToKlinecharts(chart, "mybg", output)).not.toThrow();
  });

  it("throws for an output type klinecharts has no confirmed built-in figure for, rather than silently dropping it", () => {
    const chart = fakeChart();
    const output: IndicatorOutput = { type: "barcolor", points: [{ time: 0, color: "red" }] };
    expect(() => renderToKlinecharts(chart, "x", output)).toThrow(/not yet supported/);
  });
});
