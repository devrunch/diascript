import { describe, it, expect } from "vitest";
import { runValidate } from "./validate";

describe("runValidate", () => {
  it("accepts a valid wrapped formula", () => {
    const result = runValidate("result = line(ema(close, 20))", "result");
    expect(result).toEqual({ valid: true, outputType: "line" });
  });

  it("rejects a syntax error with a message", () => {
    const result = runValidate("result = line(ema(close, ))", "result");
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error.message.length).toBeGreaterThan(0);
    }
  });

  it("rejects an output name that isn't a wrapped formula", () => {
    const result = runValidate("raw = ema(close, 20)", "raw");
    expect(result).toEqual({
      valid: false,
      error: { message: "'raw' is not a rendered (wrapped) formula in this diascript source" },
    });
  });

  it("rejects an output name that doesn't exist in the source", () => {
    const result = runValidate("result = line(ema(close, 20))", "missing");
    expect(result).toEqual({
      valid: false,
      error: { message: "'missing' is not a rendered (wrapped) formula in this diascript source" },
    });
  });
});
