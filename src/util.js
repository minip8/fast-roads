// ============================================================================
// Small helpers
// ============================================================================
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrapI = (i, n) => ((i % n) + n) % n;

export function smoothClosed(arr, r, passes = 1) {
  const n = arr.length;
  let src = Float64Array.from(arr);
  for (let p = 0; p < passes; p++) {
    const out = new Float64Array(n);
    let sum = 0;
    for (let k = -r; k <= r; k++) sum += src[wrapI(k, n)];
    for (let i = 0; i < n; i++) {
      out[i] = sum / (2 * r + 1);
      sum += src[wrapI(i + r + 1, n)] - src[wrapI(i - r, n)];
    }
    src = out;
  }
  return src;
}

// Grow true regions: a true at j becomes true over [j - back, j + fwd].
export function dilate(mask, back, fwd) {
  const n = mask.length, out = new Uint8Array(n);
  for (let j = 0; j < n; j++) if (mask[j]) for (let k = -back; k <= fwd; k++) out[wrapI(j + k, n)] = 1;
  return out;
}

export function removeShortRuns(mask, minLen) {
  const n = mask.length;
  let start = -1;
  for (let i = 0; i < n; i++) if (!mask[i]) { start = i; break; }
  if (start < 0) return mask;
  let run = [];
  for (let k = 1; k <= n; k++) {
    const i = wrapI(start + k, n);
    if (mask[i] && k < n) run.push(i);
    else { if (run.length && run.length < minLen) for (const r of run) mask[r] = 0; run = []; }
  }
  return mask;
}

export const fmtTime = (t) => {
  if (t == null || !isFinite(t)) return '—';
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s.toFixed(3).padStart(6, '0')}`;
};
export const fmtSec = (t) => (t == null ? '—' : t.toFixed(3));
export const fmtDelta = (d) => (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(3);
