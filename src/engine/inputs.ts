import { InputDecl } from "../ast";

export function resolveInputs(
  decls: InputDecl[],
  overrides: Record<string, number | string> = {},
): Record<string, number | string> {
  const declared = new Set(decls.map(d => d.name));
  for (const key of Object.keys(overrides)) {
    if (!declared.has(key)) throw new Error(`Input '${key}' is not declared in this script`);
  }
  const resolved: Record<string, number | string> = {};
  for (const decl of decls) {
    const value = decl.name in overrides ? overrides[decl.name] : decl.defaultValue;
    if ((decl.type === "int" || decl.type === "float") && typeof value === "number") {
      if (decl.min !== undefined && value < decl.min) throw new Error(`Input '${decl.name}' below min (${decl.min})`);
      if (decl.max !== undefined && value > decl.max) throw new Error(`Input '${decl.name}' above max (${decl.max})`);
    }
    resolved[decl.name] = value;
  }
  return resolved;
}
