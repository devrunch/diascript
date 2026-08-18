import { ASTNode } from "../ast";
import { evaluateNodeAt } from "./evaluator";
import { EvalContext, IndicatorOutput, OHLCV } from "./types";

const OUTPUT_WRAPPERS = new Set(["line", "band", "marker", "histogram", "barcolor", "background", "fill"]);

export function isOutputWrapper(expr: ASTNode): expr is Extract<ASTNode, { kind: "call" }> {
  return expr.kind === "call" && OUTPUT_WRAPPERS.has(expr.name);
}

export function buildOutput(name: string, expr: ASTNode, bars: OHLCV[], ctx?: EvalContext): IndicatorOutput | null {
  if (!isOutputWrapper(expr)) return null;
  const context = ctx ?? { bars, completed: new Map(), self: [], currentFormula: name, inputs: {}, externalSeries: new Map(), symbolTicker: "", pushDiagnostic: () => {} };

  switch (expr.name) {
    case "line": {
      const series = evalArgSeries(expr.args[0], bars, context);
      return { type: "line", points: bars.map((b, i) => ({ time: b.time, value: series[i] as number })) };
    }
    case "histogram": {
      const series = evalArgSeries(expr.args[0], bars, context);
      return { type: "histogram", points: bars.map((b, i) => ({ time: b.time, value: series[i] as number })) };
    }
    case "band": {
      const upper = evalArgSeries(expr.args[0], bars, context);
      const lower = evalArgSeries(expr.args[1], bars, context);
      const colorNode = expr.namedArgs.color;
      const color = colorNode ? evaluateStringArg(colorNode, context) : undefined;
      return {
        type: "band",
        upper: bars.map((b, i) => ({ time: b.time, value: upper[i] as number })),
        lower: bars.map((b, i) => ({ time: b.time, value: lower[i] as number })),
        ...(color !== undefined ? { color } : {}),
      };
    }
    case "marker": {
      const condition = evalArgSeries(expr.args[0], bars, context) as unknown as boolean[];
      const shape = evaluateStringArg(expr.args[1], context);
      const color = evaluateStringArg(expr.args[2], context);
      return {
        type: "marker",
        points: bars.filter((_, i) => condition[i]).map(b => ({ time: b.time, shape, color })),
      };
    }
    case "barcolor": {
      const condition = evalArgSeries(expr.args[0], bars, context) as unknown as boolean[];
      const colorTrue = evaluateStringArg(expr.args[1], context);
      const colorFalse = evaluateStringArg(expr.args[2], context);
      return {
        type: "barcolor",
        points: bars.map((b, i) => ({ time: b.time, color: condition[i] ? colorTrue : colorFalse })),
      };
    }
    case "background": {
      const condition = evalArgSeries(expr.args[0], bars, context) as unknown as boolean[];
      const color = evaluateStringArg(expr.args[1], context);
      return {
        type: "background",
        points: bars.filter((_, i) => condition[i]).map(b => ({ time: b.time, color })),
      };
    }
    case "fill": {
      const a = (expr.args[0] as any).name as string;
      const b = (expr.args[1] as any).name as string;
      const color = evaluateStringArg(expr.args[2], context);
      return { type: "fill", between: [a, b], color };
    }
  }
  return null;
}

function evalArgSeries(node: ASTNode, bars: OHLCV[], ctx: EvalContext): (number | boolean)[] {
  const result: (number | boolean)[] = [];
  // Mutate ctx.self directly (not a spread copy) — the caller (engine.ts)
  // reads ctx.self afterward to populate `values` for wrapped formulas, so
  // a disconnected copy here would silently leave that permanently empty.
  ctx.self = result;
  for (let i = 0; i < bars.length; i++) result.push(evaluateNodeAt(node, i, ctx));
  return result;
}

/** Colors and shapes are string-valued — outside evaluateNodeAt's number|boolean
 * return type on purpose, since the per-bar numeric evaluator never needs a
 * string. This handles the two places a string CAN legally appear: a plain
 * literal ("red"), or an input.<name> reference to a color-type input. */
function evaluateStringArg(node: ASTNode, ctx: EvalContext): string {
  if (node.kind === "string") return node.value;
  if (node.kind === "namespaced" && node.namespace === "input") {
    const v = ctx.inputs[node.member];
    if (typeof v !== "string") throw new Error(`input.${node.member} is not a color/string input`);
    return v;
  }
  throw new Error("Expected a string literal or an input.<name> color reference");
}
