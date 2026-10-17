// Exact rational seconds: no float epsilon, FPS, or rounded pts_time comparisons.
export type Q = readonly [bigint, bigint];
export function seconds(text: string): Q {
  if (typeof text !== 'string' || text.length > 32 || !/^-?\d+(\.\d{1,9})?$/.test(text)) throw new Error('INVALID_TIME: finite decimal seconds, <=9 places');
  const scale = 10n ** BigInt(text.split('.')[1]?.length ?? 0);
  return [BigInt(text.replace('.', '')), scale];
}
export function ticks(pts: string, timeBase: string): Q {
  const [n, d] = timeBase.split('/').map(BigInt);
  return [BigInt(pts) * n, d];
}
export function compare(a: Q, b: Q): number { const delta = a[0] * b[1] - b[0] * a[1]; return delta < 0n ? -1 : delta > 0n ? 1 : 0; }
export function add(a: Q, b: Q): Q { return [a[0] * b[1] + b[0] * a[1], a[1] * b[1]]; }
export function subtract(a: Q, b: Q): Q { return add(a, [-b[0], b[1]]); }
export function multiply(a: Q, b: Q): Q { return [a[0] * b[0], a[1] * b[1]]; }
export function fraction(q: Q): string {
  let a = q[0] < 0n ? -q[0] : q[0]; let b = q[1];
  while (b) [a, b] = [b, a % b];
  return `${q[0] / a}/${q[1] / a}`;
}
