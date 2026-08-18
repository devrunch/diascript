import { ASTNode } from "../ast";
import { EvalContext } from "./types";
import { sma, ema, wma, stdev, highest, lowest, sum } from "./windowed";
import { parse } from "../parser";

export function evaluateFormulaSeries(expr: ASTNode, ctx: EvalContext): (number | boolean)[] {
  const result: (number | boolean)[] = [];
  for (let i = 0; i < ctx.bars.length; i++) {
    ctx.self = result;
    result.push(evaluateNodeAt(expr, i, ctx));
  }
  return result;
}

export function evaluateNodeAt(node: ASTNode, i: number, ctx: EvalContext): number | boolean {
  switch (node.kind) {
    case "number": return node.value;
    case "string": throw new Error("A string literal cannot be evaluated as a series value");
    case "ident": return evaluateIdent(node.name, i, ctx);
    case "namespaced": return evaluateNamespaced(node, i, ctx);
    case "unary": return evaluateUnary(node, i, ctx);
    case "binary": return evaluateBinary(node, i, ctx);
    case "call": return evaluateCall(node, i, ctx);
  }
}

function evaluateIdent(name: string, i: number, ctx: EvalContext): number {
  const seriesFields: Record<string, "open" | "high" | "low" | "close" | "volume"> = {
    open: "open", high: "high", low: "low", close: "close", volume: "volume",
  };
  if (name in seriesFields) return ctx.bars[i][seriesFields[name]];
  const completed = ctx.completed.get(name);
  if (completed) return completed[i] as number;
  const external = ctx.externalSeries.get(name);
  if (external) return external[i];
  throw new Error(`Unresolved identifier '${name}' at evaluation time — this is a parser bug, not a user error`);
}

function evaluateNamespaced(node: Extract<ASTNode, { kind: "namespaced" }>, i: number, ctx: EvalContext): number | boolean {
  if (node.namespace === "input") {
    const v = ctx.inputs[node.member];
    if (typeof v !== "number") throw new Error(`input.${node.member} is not a numeric input`);
    return v;
  }
  if (node.namespace === "time") {
    const date = new Date(ctx.bars[i].time * 1000);
    if (node.member === "dayofweek") return date.getUTCDay();
    if (node.member === "hour") return date.getUTCHours();
    if (node.member === "minute") return date.getUTCMinutes();
  }
  if (node.namespace === "session" && node.member === "is_open") {
    return ctx.sessionOpen ? ctx.sessionOpen(ctx.bars[i].time) : true;
  }
  if (node.namespace === "symbol") {
    if (node.member === "exchange") throw new Error("symbol.exchange() returns a string; only valid as an argument, not a series value");
    if (node.member === "ticker") throw new Error("symbol.ticker() returns a string; only valid as an argument, not a series value");
  }
  throw new Error(`Unknown namespaced reference ${node.namespace}.${node.member}`);
}

function evaluateUnary(node: Extract<ASTNode, { kind: "unary" }>, i: number, ctx: EvalContext): number | boolean {
  const v = evaluateNodeAt(node.operand, i, ctx);
  if (node.op === "not") return !v;
  if (node.op === "-") return -(v as number);
  throw new Error(`Unknown unary operator '${node.op}'`);
}

function evaluateBinary(node: Extract<ASTNode, { kind: "binary" }>, i: number, ctx: EvalContext): number | boolean {
  if (node.op === "and") return !!evaluateNodeAt(node.left, i, ctx) && !!evaluateNodeAt(node.right, i, ctx);
  if (node.op === "or") return !!evaluateNodeAt(node.left, i, ctx) || !!evaluateNodeAt(node.right, i, ctx);
  const l = evaluateNodeAt(node.left, i, ctx) as number;
  const r = evaluateNodeAt(node.right, i, ctx) as number;
  switch (node.op) {
    case "+": return l + r;
    case "-": return l - r;
    case "*": return l * r;
    case "/":
      if (r === 0) { ctx.pushDiagnostic(`division by zero`, i); return NaN; }
      return l / r;
    case "<": return l < r;
    case ">": return l > r;
    case "<=": return l <= r;
    case ">=": return l >= r;
    case "==": return l === r;
    case "!=": return l !== r;
    default: throw new Error(`Unknown binary operator '${node.op}'`);
  }
}

function seriesUpTo(node: ASTNode, i: number, ctx: EvalContext): number[] {
  const out: number[] = [];
  for (let k = 0; k <= i; k++) out.push(evaluateNodeAt(node, k, ctx) as number);
  return out;
}

const TYPICAL_PRICE_EXPR = (parse("x = (high + low + close) / 3") as any)[0].expr;

function trueRangeAt(i: number, ctx: EvalContext): number {
  // Implemented directly rather than composed from ref(close, 1) — on bar 0
  // there's no previous close, and routing through ref() there returns NaN,
  // which poisons every max()/abs() built from it (JS's Math.max/NaN
  // semantics), when the real convention is just high-low on the first bar.
  const bar = ctx.bars[i];
  if (i === 0) return bar.high - bar.low;
  const prevClose = ctx.bars[i - 1].close;
  return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

function rsiAt(n: number, i: number, ctx: EvalContext, sourceNode: ASTNode): number {
  // Two independent recursive accumulators — each needs its own running
  // series, so this runs its own tiny bar-by-bar loop rather than reusing
  // ctx.self (which belongs to the OUTER formula calling rsi(), not to rsi's
  // own internal state).
  const gains: number[] = [], losses: number[] = [], avgGain: number[] = [], avgLoss: number[] = [];
  for (let k = 0; k <= i; k++) {
    const cur = evaluateNodeAt(sourceNode, k, ctx) as number;
    const prevVal = k === 0 ? cur : (evaluateNodeAt(sourceNode, k - 1, ctx) as number);
    const change = cur - prevVal;
    gains.push(Math.max(change, 0));
    losses.push(Math.max(-change, 0));
    const prevAvgGain = k === 0 ? 0 : avgGain[k - 1];
    const prevAvgLoss = k === 0 ? 0 : avgLoss[k - 1];
    avgGain.push(prevAvgGain * (n - 1) / n + gains[k] / n);
    avgLoss.push(prevAvgLoss * (n - 1) / n + losses[k] / n);
  }
  const ag = avgGain[i], al = avgLoss[i];
  if (al === 0) return ag === 0 ? 50 : 100;
  return 100 - 100 / (1 + ag / al);
}

function evaluateCall(node: Extract<ASTNode, { kind: "call" }>, i: number, ctx: EvalContext): number | boolean {
  const arg = (n: number) => evaluateNodeAt(node.args[n], i, ctx) as number;
  switch (node.name) {
    case "abs": return Math.abs(arg(0));
    case "min": return Math.min(arg(0), arg(1));
    case "max": return Math.max(arg(0), arg(1));

    case "sma": case "ema": case "wma": case "stdev": case "highest": case "lowest": case "sum": {
      const windowFns = { sma, ema, wma, stdev, highest, lowest, sum };
      const result = windowFns[node.name](seriesUpTo(node.args[0], i, ctx), arg(1), i);
      if (Number.isNaN(result)) ctx.pushDiagnostic(`${node.name}(): insufficient history`, i);
      return result;
    }

    case "ref": {
      const n = arg(1);
      const idx = i - n;
      if (idx < 0) { ctx.pushDiagnostic(`ref(): insufficient history`, i); return NaN; }
      return evaluateNodeAt(node.args[0], idx, ctx) as number;
    }
    case "prev": {
      const n = arg(0);
      const idx = i - n;
      return idx < 0 ? 0 : (ctx.self[idx] as number);
    }
    case "held": {
      const condition = evaluateNodeAt(node.args[0], i, ctx);
      if (condition) return evaluateNodeAt(node.args[1], i, ctx) as number;
      return i === 0 ? 0 : (ctx.self[i - 1] as number);
    }

    case "true_range": return trueRangeAt(i, ctx);
    case "typical_price": return evaluateNodeAt(TYPICAL_PRICE_EXPR, i, ctx) as number;
    case "rsi": return rsiAt(arg(1), i, ctx, node.args[0]);

    case "series": {
      const symbolArg = node.args[0].kind === "namespaced" && node.args[0].namespace === "symbol" && node.args[0].member === "ticker"
        ? ctx.symbolTicker
        : (node.args[0] as any).value;
      const timeframe = (node.args[1] as any).value;
      const field = (node.args[2] as any).value;
      const key = `series(${symbolArg},${timeframe},${field})`;
      const series = ctx.externalSeries.get(key);
      if (!series) { ctx.pushDiagnostic(`series(${symbolArg}, ${timeframe}, ${field}) was not prefetched`, i); return NaN; }
      return series[i];
    }

    default:
      throw new Error(`'${node.name}' is not handled by the core evaluator — implemented in a later task`);
  }
}
