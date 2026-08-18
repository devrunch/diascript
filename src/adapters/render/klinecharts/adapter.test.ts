import { describe, it, expect, vi } from "vitest";
import { renderToKlinecharts } from "./adapter";
import type { IndicatorOutput } from "../../../engine/types";

describe("renderToKlinecharts", () => {
  it("registers a line output as a klinecharts line-type indicator", () => {
    const registerIndicator = vi.fn();
    const chart = { registerIndicator };
    const output: IndicatorOutput = { type: "line", points: [{ time: 0, value: 1 }] };

    renderToKlinecharts(chart as any, "myline", output);

    expect(registerIndicator).toHaveBeenCalledWith(expect.objectContaining({ name: "myline" }));
  });

  it("registers a band output with two figures", () => {
    const registerIndicator = vi.fn();
    const chart = { registerIndicator };
    const output: IndicatorOutput = {
      type: "band",
      upper: [{ time: 0, value: 2 }],
      lower: [{ time: 0, value: 1 }],
    };

    renderToKlinecharts(chart as any, "myband", output);

    const call = registerIndicator.mock.calls[0][0];
    expect(call.figures).toHaveLength(2);
  });

  it("registers a marker output as shape-type figures", () => {
    const registerIndicator = vi.fn();
    const chart = { registerIndicator };
    const output: IndicatorOutput = { type: "marker", points: [{ time: 0, shape: "triangle-up", color: "green" }] };

    renderToKlinecharts(chart as any, "mymarker", output);

    expect(registerIndicator).toHaveBeenCalled();
  });

  it("throws for an output type klinecharts has no direct primitive for, rather than silently dropping it", () => {
    const chart = { registerIndicator: vi.fn() };
    const output: IndicatorOutput = { type: "barcolor", points: [{ time: 0, color: "red" }] };
    expect(() => renderToKlinecharts(chart as any, "x", output)).toThrow(/not yet supported/);
  });
});
