import { describe, it, expect } from "vitest";
import { resolveInputs } from "./inputs";
import type { InputDecl } from "../ast";

describe("resolveInputs", () => {
  const decls: InputDecl[] = [
    { kind: "input", name: "length", type: "int", defaultValue: 14, min: 2, max: 200 },
    { kind: "input", name: "band_color", type: "color", defaultValue: "#2196F3" },
  ];

  it("uses defaults when no overrides given", () => {
    expect(resolveInputs(decls)).toEqual({ length: 14, band_color: "#2196F3" });
  });

  it("applies a valid override", () => {
    expect(resolveInputs(decls, { length: 9 })).toEqual({ length: 9, band_color: "#2196F3" });
  });

  it("rejects an override below min", () => {
    expect(() => resolveInputs(decls, { length: 1 })).toThrow(/min/);
  });

  it("rejects an override above max", () => {
    expect(() => resolveInputs(decls, { length: 500 })).toThrow(/max/);
  });

  it("rejects an override for a name that isn't declared", () => {
    expect(() => resolveInputs(decls, { nonexistent: 1 })).toThrow(/not declared/);
  });
});
