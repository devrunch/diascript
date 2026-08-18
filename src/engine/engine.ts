import { parse } from "../parser.js";
import { InputDecl } from "../ast.js";
import { evaluateFormulaSeries } from "./evaluator.js";
import { resolveInputs } from "./inputs.js";
import { prefetchExternalSeries } from "./prefetch.js";
import { buildOutput, isOutputWrapper } from "./outputs.js";
import { DataAdapter, Diagnostic, EvalContext, EvaluationResult, OHLCV } from "./types.js";

export async function evaluate(
  source: string,
  bars: OHLCV[],
  adapter: DataAdapter,
  symbolTicker: string,
  inputOverrides: Record<string, number | string> = {},
): Promise<EvaluationResult> {
  const program = parse(source);
  const inputDecls = program.filter((s): s is InputDecl => s.kind === "input");
  const inputs = resolveInputs(inputDecls, inputOverrides);
  const { externalSeries, sessionOpen, exchange } = await prefetchExternalSeries(program, bars, adapter, symbolTicker);

  const values: Record<string, (number | boolean)[]> = {};
  const outputs: EvaluationResult["outputs"] = {};
  const diagCounts = new Map<string, Diagnostic>();

  const completed = new Map<string, (number | boolean)[]>();

  for (const stmt of program) {
    if (stmt.kind !== "formula") continue;
    const ctx: EvalContext = {
      bars, completed, self: [], currentFormula: stmt.name, inputs, externalSeries,
      sessionOpen, exchange, symbolTicker,
      pushDiagnostic: (message: string, barIndex: number) => {
        const key = `${stmt.name}::${message}`;
        const existing = diagCounts.get(key);
        if (existing) { existing.count++; existing.lastBarIndex = barIndex; }
        else diagCounts.set(key, { formula: stmt.name, message, severity: "warning", count: 1, firstBarIndex: barIndex, lastBarIndex: barIndex });
      },
    };

    if (isOutputWrapper(stmt.expr)) {
      // Output wrappers are evaluated ONCE via buildOutput, which computes
      // and populates `values` for the wrapped argument too — evaluating
      // the same expression tree a second time via evaluateFormulaSeries
      // would double-count diagnostics (and double the work) for no reason.
      const output = buildOutput(stmt.name, stmt.expr, bars, ctx);
      if (output) outputs[stmt.name] = output;
      values[stmt.name] = ctx.self;
      completed.set(stmt.name, ctx.self);
    } else {
      const series = evaluateFormulaSeries(stmt.expr, ctx);
      values[stmt.name] = series;
      completed.set(stmt.name, series);
    }
  }

  return { outputs, values, diagnostics: [...diagCounts.values()] };
}
