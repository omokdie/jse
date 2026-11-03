// JSE OMR — small image utilities on typed arrays (grey Uint8Array, binary
// Uint8Array 0/1). Shared by preprocess.js, dewarp.js and the classifiers.

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

export function toGray(image) {
  const { width: w, height: h, data } = image;
  const g = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    let v = (data[j] * 299 + data[j + 1] * 587 + data[j + 2] * 114) / 1000;
    const a = data[j + 3];
    if (a < 255) v = (v * a + 255 * (255 - a)) / 255;   // transparent → paper
    g[i] = v;
  }
  return g;
}

/** Box-filter downscale by an integer factor f. */
export function boxDown(src, w, h, f) {
  const dw = Math.max(1, Math.floor(w / f)), dh = Math.max(1, Math.floor(h / f));
  const out = new Uint8Array(dw * dh);
  const inv = 1 / (f * f);
  for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) {
    let s = 0;
    for (let yy = 0; yy < f; yy++) { let o = (y * f + yy) * w + x * f; for (let xx = 0; xx < f; xx++) s += src[o++]; }
    out[y * dw + x] = s * inv;
  }
  return { data: out, w: dw, h: dh };
}

/** Separable sliding-window max (sign=1) or min (sign=-1), radius r (van Herk/Gil-Werman). */
export function rankFilter(src, w, h, r, sign) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  const n = Math.max(w, h), k = 2 * r + 1;
  const g = new Uint8Array(n + k), hh = new Uint8Array(n + k), line = new Uint8Array(n + 2 * r);
  const better = sign > 0 ? (a, b) => (a > b ? a : b) : (a, b) => (a < b ? a : b);
  const pad = sign > 0 ? 0 : 255;
  const pass = (get, set, len) => {
    for (let i = 0; i < len + 2 * r; i++) { const j = i - r; line[i] = j >= 0 && j < len ? get(j) : pad; }
    const L = len + 2 * r;
    for (let i = 0; i < L; i++) g[i] = i % k === 0 ? line[i] : better(g[i - 1], line[i]);
    for (let i = L - 1; i >= 0; i--) hh[i] = (i % k === k - 1 || i === L - 1) ? line[i] : better(hh[i + 1], line[i]);
    for (let i = 0; i < len; i++) set(i, better(hh[i], g[i + 2 * r]));
  };
  for (let y = 0; y < h; y++) { const row = y * w; pass(j => src[row + j], (i, v) => { tmp[row + i] = v; }, w); }
  for (let x = 0; x < w; x++) pass(j => tmp[j * w + x], (i, v) => { out[i * w + x] = v; }, h);
  return out;
}

export function boxBlur(src, w, h, r) {
  const tmp = new Float32Array(w * h), out = new Uint8Array(w * h);
  const d = 2 * r + 1;
  for (let y = 0; y < h; y++) {
    let s = 0; const row = y * w;
    for (let x = -r; x <= r; x++) s += src[row + clamp(x, 0, w - 1)];
    for (let x = 0; x < w; x++) { tmp[row + x] = s / d; s += src[row + clamp(x + r + 1, 0, w - 1)] - src[row + clamp(x - r, 0, w - 1)]; }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[clamp(y, 0, h - 1) * w + x];
    for (let y = 0; y < h; y++) { out[y * w + x] = s / d; s += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x]; }
  }
  return out;
}

/** Separable Gaussian blur of a grey image (sigma in px), returns Uint8Array. */
export function gaussBlur(src, w, h, sigma) {
  const r = Math.max(1, Math.ceil(2.5 * sigma));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) a += k[i + r] * src[row + clamp(x + i, 0, w - 1)]; tmp[row + x] = a; }
  }
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) { let a = 0; for (let i = -r; i <= r; i++) a += k[i + r] * tmp[clamp(y + i, 0, h - 1) * w + x]; out[y * w + x] = a + 0.5; }
  return out;
}

export function histogram(src, step = 1) {
  const hist = new Uint32Array(256);
  for (let i = 0; i < src.length; i += step) hist[src[i]]++;
  return hist;
}
export function percentile(hist, p) {
  let total = 0; for (let i = 0; i < 256; i++) total += hist[i];
  let acc = 0; const target = p * total;
  for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= target) return i; }
  return 255;
}
export function otsu(hist) {
  let total = 0, sum = 0; for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let sumB = 0, wB = 0, best = 0, thr = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

/** Vertical run-length statistics of a binary image: staff spacing (mode of
 * the period between two thin black runs) and line thickness (mode of the
 * black runs that take part in that periodic pattern — robust to noise
 * speckles, which make 1-px runs the overall mode on permissive thresholds).
 * Columns are subsampled by `step`. */
export function runStats(bin, w, h, step = 2, maxRun = 160) {
  const columns = [];
  const runs = [];
  for (let x = 0; x < w; x += step) {
    runs.length = 0;
    let y = 0;
    while (y < h) {
      const v = bin[y * w + x]; let y2 = y;
      while (y2 < h && bin[y2 * w + x] === v) y2++;
      runs.push(v ? (y2 - y) : -(y2 - y));
      y = y2;
    }
    columns.push(Int32Array.from(runs));
  }
  const periodHist = (cap) => {
    const period = new Float64Array(maxRun + 2);
    let pairs = 0;
    for (const rs of columns) for (let i = 0; i + 2 < rs.length; i++) {
      const a = rs[i], g = rs[i + 1], b = rs[i + 2];
      if (a > 0 && a <= cap && b > 0 && b <= cap && g < 0) { const p = a - g; if (p >= 3 && p <= maxRun) { period[p] += 1; pairs++; } }
    }
    let sp = 0, best = 0;
    for (let p = 3; p <= maxRun; p++) { const v = period[p] + 0.5 * (period[p - 1] || 0) + 0.5 * (period[p + 1] || 0); if (v > best) { best = v; sp = p; } }
    if (sp) { let s = 0, c = 0; for (let p = sp - 1; p <= sp + 1; p++) if (p > 0 && p <= maxRun) { s += p * period[p]; c += period[p]; } if (c) sp = s / c; }
    return { sp, best, pairs };
  };
  // pass 1: any reasonably thin pair; pass 2: thickness from the periodic runs
  const p1 = periodHist(Math.max(4, Math.floor(maxRun / 5)));
  const thick = new Float64Array(maxRun + 1);
  if (p1.sp) {
    for (const rs of columns) for (let i = 0; i + 2 < rs.length; i++) {
      const a = rs[i], g = rs[i + 1], b = rs[i + 2];
      if (a > 0 && b > 0 && g < 0 && Math.abs(a - g - p1.sp) <= 0.15 * p1.sp + 1 && a <= 0.5 * p1.sp) { thick[a]++; if (b <= 0.5 * p1.sp) thick[b]++; }
    }
  }
  let t = 1; for (let i = 1; i <= maxRun; i++) if (thick[i] > thick[t]) t = i;
  if (!p1.sp) {   // fallback: plain mode of black runs
    const black = new Float64Array(maxRun + 1);
    for (const rs of columns) for (const r of rs) if (r > 0 && r <= maxRun) black[r]++;
    for (let i = 1; i <= maxRun; i++) if (black[i] > black[t]) t = i;
  }
  const p2 = periodHist(2 * t + 1);
  const sp = p2.sp || p1.sp || 0;
  const ev = p2.sp ? p2 : p1;
  return { thickness: t, spacing: sp, evidence: ev.best, peakShare: ev.pairs ? ev.best / ev.pairs : 0, columns: columns.length };
}

/** Mask of "thin horizontal" ink: pixels whose vertical black run ≤ maxRun. */
export function thinMask(bin, w, h, maxRun) {
  const m = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) {
    let y = 0;
    while (y < h) {
      if (!bin[y * w + x]) { y++; continue; }
      let y2 = y; while (y2 < h && bin[y2 * w + x]) y2++;
      if (y2 - y <= maxRun) for (let k = y; k < y2; k++) m[k * w + x] = 1;
      y = y2;
    }
  }
  return m;
}

/** Skew angle (radians) maximising the sharpness of the row projection of
 * thin-horizontal pixels; coarse-to-fine search within ±maxDeg. */
export function estimateSkew(thin, w, h, maxDeg = 15) {
  const xs = [], ys = [];
  const stride = Math.max(1, Math.floor((w * h) / 2.5e6));
  for (let i = 0; i < w * h; i += stride) if (thin[i]) { xs.push(i % w - w / 2); ys.push(Math.floor(i / w) - h / 2); }
  if (xs.length < 200) return 0;
  // cap the number of points for speed
  const n = Math.min(xs.length, 250000), inc = xs.length / n;
  const px = new Float32Array(n), py = new Float32Array(n);
  for (let i = 0; i < n; i++) { const j = Math.floor(i * inc); px[i] = xs[j]; py[i] = ys[j]; }
  const diag = Math.hypot(w, h), hist = new Float64Array(Math.ceil(diag) + 2);
  const score = (a) => {
    hist.fill(0);
    const c = Math.cos(a), s = Math.sin(a), off = diag / 2;
    for (let i = 0; i < n; i++) hist[(py[i] * c - px[i] * s + off) | 0]++;
    let v = 0; for (let i = 0; i < hist.length; i++) v += hist[i] * hist[i];
    return v;
  };
  const deg = Math.PI / 180;
  let best = 0, bestV = -1;
  for (let a = -maxDeg; a <= maxDeg + 1e-9; a += 0.5) { const v = score(a * deg); if (v > bestV) { bestV = v; best = a; } }
  let mid = best;
  for (let a = best - 0.5; a <= best + 0.5 + 1e-9; a += 0.1) { const v = score(a * deg); if (v > bestV) { bestV = v; mid = a; } }
  let fine = mid;
  for (let a = mid - 0.1; a <= mid + 0.1 + 1e-9; a += 0.02) { const v = score(a * deg); if (v > bestV) { bestV = v; fine = a; } }
  return fine * deg;
}

/** Bilinear sample of a grey image (outside → `fill`). */
export function bilinear(src, w, h, x, y, fill = 255) {
  if (!(x >= 0 && y >= 0 && x < w - 1 && y < h - 1)) {
    if (x > -1 && y > -1 && x < w && y < h) { const xi = clamp(Math.round(x), 0, w - 1), yi = clamp(Math.round(y), 0, h - 1); return src[yi * w + xi]; }
    return fill;
  }
  const x0 = x | 0, y0 = y | 0, fx = x - x0, fy = y - y0, o = y0 * w + x0;
  return (src[o] * (1 - fx) + src[o + 1] * fx) * (1 - fy) + (src[o + w] * (1 - fx) + src[o + w + 1] * fx) * fy;
}

/** Horizontal / vertical ink run length at every pixel (Uint16). */
export function runLengths(bin, w, h, vertical) {
  const out = new Uint16Array(w * h);
  if (vertical) {
    for (let x = 0; x < w; x++) {
      let y = 0;
      while (y < h) {
        if (!bin[y * w + x]) { y++; continue; }
        let y2 = y; while (y2 < h && bin[y2 * w + x]) y2++;
        const L = Math.min(65535, y2 - y);
        for (let k = y; k < y2; k++) out[k * w + x] = L;
        y = y2;
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      const row = y * w; let x = 0;
      while (x < w) {
        if (!bin[row + x]) { x++; continue; }
        let x2 = x; while (x2 < w && bin[row + x2]) x2++;
        const L = Math.min(65535, x2 - x);
        for (let k = x; k < x2; k++) out[row + k] = L;
        x = x2;
      }
    }
  }
  return out;
}

/** 1-D Gaussian blur along x only (sigma px), returns Uint8Array. */
export function gaussBlurX(src, w, h, sigma) {
  const r = Math.max(1, Math.ceil(2.5 * sigma));
  const k = new Float32Array(2 * r + 1);
  let s = 0;
  for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + r]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) { let a = 0; for (let i = -r; i <= r; i++) a += k[i + r] * src[row + clamp(x + i, 0, w - 1)]; out[row + x] = a + 0.5; }
  }
  return out;
}

/** Noise sigma of a normalised grey image, from horizontal neighbour
 * differences on paper pixels (robust: MAD). */
export function estimateNoise(img, w, h, paper) {
  const diffs = new Uint32Array(256);
  let n = 0;
  const lim = paper - 25;
  for (let y = 1; y < h - 1; y += 3) {
    const row = y * w;
    for (let x = 1; x < w - 2; x += 2) {
      const a = img[row + x], b = img[row + x + 1];
      if (a < lim || b < lim) continue;
      diffs[Math.min(255, Math.abs(a - b))]++; n++;
    }
  }
  if (n < 100) return 2;
  let acc = 0, med = 0;
  for (let i = 0; i < 256; i++) { acc += diffs[i]; if (acc >= n / 2) { med = i; break; } }
  return Math.max(0.5, 1.4826 * med / Math.SQRT2);
}
