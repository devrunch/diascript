function windowSlice(series: number[], n: number, i: number): number[] | null {
  if (i - n + 1 < 0) return null;
  return series.slice(i - n + 1, i + 1);
}

export function sma(series: number[], n: number, i: number): number {
  const w = windowSlice(series, n, i);
  if (!w) return NaN;
  return w.reduce((a, b) => a + b, 0) / n;
}

export function ema(series: number[], n: number, i: number): number {
  if (i < n - 1) return NaN;
  const alpha = 2 / (n + 1);
  let value = sma(series, n, n - 1);
  for (let k = n; k <= i; k++) value = alpha * series[k] + (1 - alpha) * value;
  return value;
}

export function wma(series: number[], n: number, i: number): number {
  const w = windowSlice(series, n, i);
  if (!w) return NaN;
  let weightedSum = 0, weightTotal = 0;
  for (let k = 0; k < n; k++) { const weight = k + 1; weightedSum += w[k] * weight; weightTotal += weight; }
  return weightedSum / weightTotal;
}

export function stdev(series: number[], n: number, i: number): number {
  const w = windowSlice(series, n, i);
  if (!w) return NaN;
  const mean = w.reduce((a, b) => a + b, 0) / n;
  return Math.sqrt(w.reduce((s, v) => s + (v - mean) ** 2, 0) / n);
}

export function highest(series: number[], n: number, i: number): number {
  const w = windowSlice(series, n, i);
  return w ? Math.max(...w) : NaN;
}

export function lowest(series: number[], n: number, i: number): number {
  const w = windowSlice(series, n, i);
  return w ? Math.min(...w) : NaN;
}

export function sum(series: number[], n: number, i: number): number {
  const w = windowSlice(series, n, i);
  return w ? w.reduce((a, b) => a + b, 0) : NaN;
}
