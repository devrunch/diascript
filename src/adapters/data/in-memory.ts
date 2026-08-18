import { DataAdapter, OHLCV } from "../../engine/types";

/** A reference DataAdapter for tests and examples — not meant for production
 * use, just proves the interface and gives every other task something real
 * to test against without a network call. */
export class InMemoryDataAdapter implements DataAdapter {
  private series = new Map<string, OHLCV[]>();
  private meta = new Map<string, { exchange: string; sessionOpen(time: number): boolean }>();

  register(symbol: string, timeframe: string, bars: OHLCV[]): void {
    this.series.set(`${symbol}:${timeframe}`, bars);
  }

  registerMeta(symbol: string, exchange: string, sessionOpen: (time: number) => boolean): void {
    this.meta.set(symbol, { exchange, sessionOpen });
  }

  async getSeries(symbol: string, timeframe: string): Promise<OHLCV[]> {
    const key = `${symbol}:${timeframe}`;
    const bars = this.series.get(key);
    if (!bars) throw new Error(`No series registered for ${key}`);
    return bars;
  }

  async getSymbolMeta(symbol: string) {
    const meta = this.meta.get(symbol);
    if (!meta) throw new Error(`No symbol meta registered for ${symbol}`);
    return meta;
  }
}
