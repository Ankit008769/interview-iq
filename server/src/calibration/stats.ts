// Agreement statistics for rater calibration. Rows are rated units (an answer × criterion), columns are raters.
// Every function returns null when the data cannot support the statistic (too few units or no variance).

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function shape(rows: number[][]) {
  const n = rows.length;
  const k = rows[0]?.length ?? 0;
  if (n < 2 || k < 2 || rows.some(r => r.length !== k)) return null;
  const grand = mean(rows.flat());
  const rowMeans = rows.map(mean);
  const colMeans = Array.from({ length: k }, (_, j) => mean(rows.map(r => r[j])));
  return { n, k, grand, rowMeans, colMeans };
}

// ICC(1,1), one-way random, absolute agreement: raters may differ from unit to unit (Shrout & Fleiss 1979).
export function icc1(rows: number[][]): number | null {
  const s = shape(rows);
  if (!s) return null;
  const msb = s.k * s.rowMeans.reduce((a, m) => a + (m - s.grand) ** 2, 0) / (s.n - 1);
  const msw = rows.reduce((a, r, i) => a + r.reduce((b, x) => b + (x - s.rowMeans[i]) ** 2, 0), 0) / (s.n * (s.k - 1));
  const denominator = msb + (s.k - 1) * msw;
  return denominator === 0 ? null : (msb - msw) / denominator;
}

// ICC(A,1) = Shrout & Fleiss ICC(2,1), two-way random, absolute agreement: the same raters score every unit
// (used for the AI judge against the human consensus).
export function iccA1(rows: number[][]): number | null {
  const s = shape(rows);
  if (!s) return null;
  const msr = s.k * s.rowMeans.reduce((a, m) => a + (m - s.grand) ** 2, 0) / (s.n - 1);
  const msc = s.n * s.colMeans.reduce((a, m) => a + (m - s.grand) ** 2, 0) / (s.k - 1);
  const sse = rows.reduce((a, r, i) => a + r.reduce((b, x, j) => b + (x - s.rowMeans[i] - s.colMeans[j] + s.grand) ** 2, 0), 0);
  const mse = sse / ((s.n - 1) * (s.k - 1));
  const denominator = msr + (s.k - 1) * mse + (s.k * (msc - mse)) / s.n;
  return denominator === 0 ? null : (msr - mse) / denominator;
}

// Quadratic-weighted Cohen's kappa for paired ratings on the integer scale min..max.
export function weightedKappa(pairs: [number, number][], min = 0, max = 5): number | null {
  const size = max - min + 1;
  if (pairs.length < 2 || size < 2) return null;
  const observed = Array.from({ length: size }, () => new Array<number>(size).fill(0));
  const a = new Array<number>(size).fill(0);
  const b = new Array<number>(size).fill(0);
  for (const [x, y] of pairs) {
    const i = Math.round(x) - min, j = Math.round(y) - min;
    if (i < 0 || j < 0 || i >= size || j >= size) throw new Error(`Rating outside ${min}–${max}.`);
    observed[i][j]++; a[i]++; b[j]++;
  }
  let disagreeObserved = 0, disagreeExpected = 0;
  for (let i = 0; i < size; i++) for (let j = 0; j < size; j++) {
    const weight = (i - j) ** 2 / (size - 1) ** 2;
    disagreeObserved += weight * observed[i][j];
    disagreeExpected += weight * a[i] * b[j] / pairs.length;
  }
  return disagreeExpected === 0 ? null : 1 - disagreeObserved / disagreeExpected;
}

export function agreementRates(pairs: [number, number][]) {
  if (!pairs.length) return { exact: null, withinOne: null, meanDifference: null };
  return {
    exact: pairs.filter(([x, y]) => x === y).length / pairs.length,
    withinOne: pairs.filter(([x, y]) => Math.abs(x - y) <= 1).length / pairs.length,
    // Positive means the second rater (e.g. the AI judge) scores higher on average.
    meanDifference: mean(pairs.map(([x, y]) => y - x)),
  };
}
