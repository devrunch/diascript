import { ASTNode, Program } from "../ast";
import { DataAdapter, OHLCV } from "./types";

interface SeriesCall { symbol: string; timeframe: string; field: string }

function walk(node: ASTNode, found: { series: SeriesCall[]; needsSessionOrExchange: boolean }): void {
  if (node.kind === "call" && node.name === "series") {
    const [symbolNode, tfNode, fieldNode] = node.args;
    if (symbolNode.kind === "string" && tfNode.kind === "string" && fieldNode.kind === "string") {
      found.series.push({ symbol: symbolNode.value, timeframe: tfNode.value, field: fieldNode.value });
    }
  }
  if (node.kind === "namespaced" && (node.namespace === "session" || (node.namespace === "symbol" && node.member === "exchange"))) {
    found.needsSessionOrExchange = true;
  }
  if (node.kind === "binary") { walk(node.left, found); walk(node.right, found); }
  if (node.kind === "unary") walk(node.operand, found);
  if (node.kind === "call") for (const a of node.args) walk(a, found);
}

function forwardFill(source: OHLCV[], field: string, primary: OHLCV[]): number[] {
  const result: number[] = [];
  let ptr = 0;
  for (const bar of primary) {
    while (ptr + 1 < source.length && source[ptr + 1].time <= bar.time) ptr++;
    result.push((source[ptr] as any)[field]);
  }
  return result;
}

export async function prefetchExternalSeries(
  program: Program,
  primaryBars: OHLCV[],
  adapter: DataAdapter,
  symbolTicker: string,
): Promise<{ externalSeries: Map<string, number[]>; sessionOpen?: (t: number) => boolean; exchange?: string }> {
  const found = { series: [] as SeriesCall[], needsSessionOrExchange: false };
  for (const stmt of program) if (stmt.kind === "formula") walk(stmt.expr, found);

  const externalSeries = new Map<string, number[]>();
  for (const call of found.series) {
    const symbol = call.symbol === symbolTicker ? symbolTicker : call.symbol;
    const source = await adapter.getSeries(symbol, call.timeframe);
    const key = `series(${call.symbol},${call.timeframe},${call.field})`;
    externalSeries.set(key, forwardFill(source, call.field, primaryBars));
  }

  let sessionOpen: ((t: number) => boolean) | undefined;
  let exchange: string | undefined;
  if (found.needsSessionOrExchange && adapter.getSymbolMeta) {
    const meta = await adapter.getSymbolMeta(symbolTicker);
    sessionOpen = meta.sessionOpen;
    exchange = meta.exchange;
  }

  return { externalSeries, sessionOpen, exchange };
}
