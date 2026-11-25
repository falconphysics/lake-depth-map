/*
 * Lake Depth Map — core geometry engine
 * Pure functions: no DOM access. Works in the browser (window.LakeCore)
 * and in Node (module.exports) for testing.
 *
 * Coordinate conventions
 *   grid:   row-major Float32Array, x → east, y → south (north up)
 *           depth in metres; land / outside = -1
 *   output: millimetres, SVG coordinate space (y down)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LakeCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const M_PER_FT = 0.3048;

  // ---------------------------------------------------------------------------
  // Great Lakes presets. Surface = IGLD85 low-water datum. NOAA's mosaic stores the
  // lakes as depth below that datum; the loader tries both and checks knownMaxDepth.
  // ---------------------------------------------------------------------------
  const PRESETS = {
    superior: {
      name: 'Lake Superior', surface: 183.2, knownMaxDepth: 406.3,
      bbox: [-92.3, 46.3, -84.3, 49.1], seed: [-86.5, 47.5]
    },
    michigan: {
      name: 'Lake Michigan', surface: 176.0, knownMaxDepth: 281.3,
      bbox: [-88.1, 41.55, -84.76, 46.15], seed: [-87.0, 43.5]
    },
    huron: {
      name: 'Lake Huron', surface: 176.0, knownMaxDepth: 228.6,
      bbox: [-84.72, 42.98, -79.6, 46.4], seed: [-82.4, 44.8]
    },
    erie: {
      name: 'Lake Erie', surface: 173.5, knownMaxDepth: 64,
      bbox: [-83.55, 41.35, -78.8, 42.95], seed: [-81.5, 42.2],
      // cut the Detroit River so Lake St. Clair doesn't flood in
      exclude: [[-83.6, 42.08, -82.6, 43.0]]
    },
    ontario: {
      name: 'Lake Ontario', surface: 74.2, knownMaxDepth: 244.4,
      bbox: [-79.95, 43.15, -75.9, 44.3], seed: [-77.8, 43.6]
    }
  };

  // ---------------------------------------------------------------------------
  // Masking
  // ---------------------------------------------------------------------------

  /** 4-connected flood fill over a Uint8Array water mask. Returns component mask. */
  function floodFill(water, w, h, seed) {
    const out = new Uint8Array(w * h);
    if (!water[seed]) return out;
    const q = new Int32Array(w * h);
    let head = 0, tail = 0;
    q[tail++] = seed; out[seed] = 1;
    while (head < tail) {
      const i = q[head++];
      const x = i % w, y = (i - x) / w;
      if (x > 0 && water[i - 1] && !out[i - 1]) { out[i - 1] = 1; q[tail++] = i - 1; }
      if (x < w - 1 && water[i + 1] && !out[i + 1]) { out[i + 1] = 1; q[tail++] = i + 1; }
      if (y > 0 && water[i - w] && !out[i - w]) { out[i - w] = 1; q[tail++] = i - w; }
      if (y < h - 1 && water[i + w] && !out[i + w]) { out[i + w] = 1; q[tail++] = i + w; }
    }
    return out;
  }

  /** Label components and return the mask of the largest one. */
  function largestComponent(water, w, h) {
    const seen = new Uint8Array(w * h);
    let best = null, bestCount = 0;
    const q = new Int32Array(w * h);
    for (let s = 0; s < w * h; s++) {
      if (!water[s] || seen[s]) continue;
      let head = 0, tail = 0, count = 0;
      q[tail++] = s; seen[s] = 1;
      while (head < tail) {
        const i = q[head++]; count++;
        const x = i % w, y = (i - x) / w;
        if (x > 0 && water[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; q[tail++] = i - 1; }
        if (x < w - 1 && water[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; q[tail++] = i + 1; }
        if (y > 0 && water[i - w] && !seen[i - w]) { seen[i - w] = 1; q[tail++] = i - w; }
        if (y < h - 1 && water[i + w] && !seen[i + w]) { seen[i + w] = 1; q[tail++] = i + w; }
      }
      if (count > bestCount) { bestCount = count; best = s; }
    }
    return best === null ? new Uint8Array(w * h) : floodFill(water, w, h, best);
  }

  /** Find the nearest water pixel to (sx, sy) within maxR pixels. */
  function nearestWater(water, w, h, sx, sy, maxR) {
    sx = Math.round(sx); sy = Math.round(sy);
    for (let r = 0; r <= maxR; r++) {
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
          const x = sx + dx, y = sy + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          if (water[y * w + x]) return y * w + x;
        }
      }
    }
    return -1;
  }

  /**
   * Turn a raw depth field into a single-lake grid.
   * depth: Float32Array (metres, positive = below surface, NaN = no data)
   * opts: { seed:[x,y] pixel or null, mode:'seed'|'largest'|'all',
   *         excludeMask: Uint8Array|null, minDepth }
   * Returns { depth, w, h, maxDepth, waterPixels, offsetX, offsetY } cropped
   * to the lake with 3 px padding, outside = -1.
   */
  function isolateLake(depth, w, h, opts) {
    opts = opts || {};
    const minDepth = opts.minDepth != null ? opts.minDepth : 0.05;
    const water = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const d = depth[i];
      if (d > minDepth && Number.isFinite(d) && !(opts.excludeMask && opts.excludeMask[i])) water[i] = 1;
    }
    let lake;
    const mode = opts.mode || 'largest';
    if (mode === 'all') lake = water;
    else if (mode === 'seed' && opts.seed) {
      // strictSeed: the marker must be (nearly) on water — never wander off to another lake
      const r = opts.strictSeed ? 3 : Math.round(Math.max(w, h) * 0.05);
      const s = nearestWater(water, w, h, opts.seed[0], opts.seed[1], r);
      if (s >= 0) lake = floodFill(water, w, h, s);
      else if (opts.strictSeed) lake = new Uint8Array(w * h);
      else lake = largestComponent(water, w, h);
    } else lake = largestComponent(water, w, h);

    let x0 = w, y0 = h, x1 = -1, y1 = -1, n = 0, maxD = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!lake[i]) continue;
      n++;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (depth[i] > maxD) maxD = depth[i];
    }
    if (n === 0) return { depth: new Float32Array(0), w: 0, h: 0, maxDepth: 0, waterPixels: 0 };
    const pad = 3;
    const cw = x1 - x0 + 1 + pad * 2, ch = y1 - y0 + 1 + pad * 2;
    const out = new Float32Array(cw * ch).fill(-1);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = y * w + x;
      if (lake[i]) out[(y - y0 + pad) * cw + (x - x0 + pad)] = depth[i];
    }
    return { depth: out, w: cw, h: ch, maxDepth: maxD, waterPixels: n, offsetX: x0 - pad, offsetY: y0 - pad };
  }

  // ---------------------------------------------------------------------------
  // Smoothing: normalised box blur (3 passes ≈ Gaussian) inside the lake only,
  // so the shoreline itself never moves.
  // ---------------------------------------------------------------------------
  function boxBlur1D(src, dst, w, h, r, horizontal) {
    const len = horizontal ? w : h, lines = horizontal ? h : w;
    const stride = horizontal ? 1 : w, lineStride = horizontal ? w : 1;
    const inv = 1 / (2 * r + 1);
    for (let l = 0; l < lines; l++) {
      const base = l * lineStride;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += src[base + Math.min(len - 1, Math.max(0, k)) * stride];
      for (let i = 0; i < len; i++) {
        dst[base + i * stride] = acc * inv;
        const add = Math.min(len - 1, i + r + 1), sub = Math.max(0, i - r);
        acc += src[base + add * stride] - src[base + sub * stride];
      }
    }
  }
  function blur(field, w, h, r) {
    let a = Float32Array.from(field), b = new Float32Array(w * h);
    for (let p = 0; p < 3; p++) {
      boxBlur1D(a, b, w, h, r, true);
      boxBlur1D(b, a, w, h, r, false);
    }
    return a;
  }
  function smoothLake(grid, radius) {
    const { w, h } = grid;
    if (!radius || radius < 1) return grid;
    const r = Math.max(1, Math.round(radius));
    const val = new Float32Array(w * h), msk = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) if (grid.depth[i] >= 0) { val[i] = grid.depth[i]; msk[i] = 1; }
    const bv = blur(val, w, h, r), bm = blur(msk, w, h, r);
    const out = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = msk[i] ? (bm[i] > 1e-6 ? bv[i] / bm[i] : grid.depth[i]) : -1;
    return Object.assign({}, grid, { depth: out });
  }

  // ---------------------------------------------------------------------------
  // Layer depths
  // ---------------------------------------------------------------------------
  function niceFloor(v) {
    if (v <= 0) return 0;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / p;
    return (f >= 5 ? 5 : f >= 2 ? 2 : 1) * p;
  }

  /**
   * Compute cut depths (metres) for each layer. Layer 1 is always the shoreline (0).
   * spacing: 'linear' | 'sqrt' (more shallow detail) | 'area' (equal area per step)
   */
  function layerDepths(grid, nLayers, spacing, opts) {
    opts = opts || {};
    const max = grid.maxDepth;
    const unit = opts.unit === 'ft' ? M_PER_FT : 1;
    if (opts.custom && opts.custom.length) {
      const c = opts.custom.map(v => v * unit).filter(v => v > 0 && v < max).sort((a, b) => a - b);
      return [0].concat(Array.from(new Set(c)));
    }
    const n = Math.max(1, nLayers);
    let t = [];
    if (spacing === 'area') {
      const vals = [];
      for (let i = 0; i < grid.depth.length; i++) if (grid.depth[i] > 0) vals.push(grid.depth[i]);
      vals.sort((a, b) => a - b);
      for (let k = 0; k < n; k++) t.push(k === 0 ? 0 : vals[Math.floor(vals.length * k / n)]);
    } else {
      for (let k = 0; k < n; k++) {
        const f = k / n;
        t.push(max * (spacing === 'sqrt' ? f * f : f));
      }
    }
    if (opts.nice && n > 1 && spacing !== 'area' && spacing !== 'sqrt') {
      // linear: one round step size (1, 2, 2.5, 5 × 10^k) close to the raw step
      const maxD = max / unit, raw = maxD / n;
      const p = Math.pow(10, Math.floor(Math.log10(raw)));
      let best = raw, bestErr = Infinity;
      for (const mult of [0.1, 1, 10]) for (const c of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5]) {
        const s = c * p * mult;
        if ((n - 1) * s >= maxD) continue;
        const err = Math.abs(Math.log(s / raw));
        if (err < bestErr) { bestErr = err; best = s; }
      }
      t = t.map((_, k) => k * best * unit);
    } else if (opts.nice && n > 1) {
      let minGap = Infinity;
      for (let k = 1; k < t.length; k++) minGap = Math.min(minGap, t[k] - t[k - 1]);
      const g = niceFloor(minGap / unit / 3) || 1; // granularity in display units
      t = t.map(v => Math.round(v / unit / g) * g * unit);
    }
    const out = [0];
    for (let k = 1; k < t.length; k++) if (t[k] > out[out.length - 1] + 1e-6 && t[k] < max) out.push(t[k]);
    return out;
  }

  // ---------------------------------------------------------------------------
  // Polygon utilities (rings are arrays of [x,y], open — no repeated last point)
  // ---------------------------------------------------------------------------
  function ringArea(r) {
    let a = 0;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    return a / 2;
  }
  function segDist2(p, a, b) {
    let x = a[0], y = a[1], dx = b[0] - x, dy = b[1] - y;
    if (dx || dy) {
      const t = ((p[0] - x) * dx + (p[1] - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) { x = b[0]; y = b[1]; } else if (t > 0) { x += dx * t; y += dy * t; }
    }
    dx = p[0] - x; dy = p[1] - y;
    return dx * dx + dy * dy;
  }
  function dpOpen(pts, tol2) {
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let md = 0, mi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = segDist2(pts[i], pts[a], pts[b]);
        if (d > md) { md = d; mi = i; }
      }
      if (md > tol2) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  /** Douglas–Peucker for a closed ring. */
  function simplifyRing(ring, tol) {
    if (ring.length < 8 || tol <= 0) return ring;
    let far = 0, fd = -1;
    for (let i = 1; i < ring.length; i++) {
      const dx = ring[i][0] - ring[0][0], dy = ring[i][1] - ring[0][1], d = dx * dx + dy * dy;
      if (d > fd) { fd = d; far = i; }
    }
    const tol2 = tol * tol;
    const a = dpOpen(ring.slice(0, far + 1), tol2);
    const b = dpOpen(ring.slice(far).concat([ring[0]]), tol2);
    const out = a.concat(b.slice(1, -1));
    return out.length >= 3 ? out : ring;
  }
  /** Chaikin corner cutting for a closed ring. */
  function chaikin(ring, iterations) {
    let r = ring;
    for (let it = 0; it < iterations; it++) {
      const o = [];
      for (let i = 0; i < r.length; i++) {
        const p = r[i], q = r[(i + 1) % r.length];
        o.push([0.75 * p[0] + 0.25 * q[0], 0.75 * p[1] + 0.25 * q[1]]);
        o.push([0.25 * p[0] + 0.75 * q[0], 0.25 * p[1] + 0.75 * q[1]]);
      }
      r = o;
    }
    return r;
  }

  // ---------------------------------------------------------------------------
  // Panel layout
  // ---------------------------------------------------------------------------
  /**
   * opts (all mm): width, height|null (auto), margin, shape 'rect'|'circle',
   *   cornerRadius, title, subtitle
   */
  function panelLayout(grid, opts) {
    const aspect = grid.aspect || 1;
    const gw = grid.w * aspect, gh = grid.h; // grid extents in "square" units
    const m = opts.margin;
    const hasTitle = !!(opts.title || opts.subtitle);
    let titleH = hasTitle ? Math.max(4, Math.min(12, opts.width * 0.036)) : 0;
    const band = hasTitle ? titleH * (opts.subtitle && opts.title ? 2.1 : 1.4) : 0;
    let W = opts.width, H, scale, ox, oy;
    if (opts.shape === 'circle') {
      H = W;
      const R = W / 2 - m;
      // inscribe the lake's bounding box in the circle, nudged up to leave room for a title
      const diag = Math.hypot(gw, gh);
      scale = (2 * R) / diag * (hasTitle ? 0.84 : 1);
      ox = (W - gw * scale) / 2;
      oy = (H - gh * scale) / 2 - (hasTitle ? R * 0.12 : 0);
    } else {
      const innerW = W - 2 * m;
      if (opts.height) {
        H = opts.height;
        const innerH = H - 2 * m - band;
        scale = Math.min(innerW / gw, innerH / gh);
      } else {
        scale = innerW / gw;
        H = gh * scale + 2 * m + band;
      }
      ox = (W - gw * scale) / 2;
      oy = m + (H - 2 * m - band - gh * scale) / 2;
    }
    return { W, H, scale, ox, oy, aspect, margin: m, titleH, band, shape: opts.shape || 'rect',
             cornerRadius: opts.cornerRadius || 0 };
  }

  // ---------------------------------------------------------------------------
  // Contour extraction for every layer
  // ---------------------------------------------------------------------------
  /**
   * contoursFactory: d3.contours (passed in so this file has no dependencies)
   * opts: { depths (m), smoothing(px), chaikin(iter), simplify(mm), minArea(mm²), panel opts }
   * Returns { layout, layers:[{ index, depth, polygons:[[outer, ...holes], ...] }] }
   */
  function buildLayers(rawGrid, contoursFactory, opts) {
    const grid = smoothLake(rawGrid, opts.smoothing || 0);
    grid.aspect = rawGrid.aspect || 1;
    const layout = panelLayout(grid, opts.panel);
    const { w, h } = grid;
    const gen = contoursFactory().size([w, h]).smooth(true);
    const values = Array.from(grid.depth);
    const tf = (p) => [layout.ox + p[0] * layout.aspect * layout.scale, layout.oy + p[1] * layout.scale];
    const minArea = opts.minArea || 0;
    const layers = [];
    // Shoreline: contour a lightly blurred water mask at 0.5 so it isn't pixel-stepped.
    let shoreValues = null;
    if (opts.smoothing > 0) {
      const msk = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) msk[i] = rawGrid.depth[i] >= 0 ? 1 : 0;
      shoreValues = Array.from(blur(msk, w, h, Math.max(1, Math.round(opts.smoothing / 3))));
    }
    opts.depths.forEach((d, idx) => {
      const mp = idx === 0
        ? (shoreValues ? gen.contour(shoreValues, 0.5) : gen.contour(values, 1e-4))
        : gen.contour(values, d); // values outside the lake are -1
      const polygons = [];
      for (const poly of mp.coordinates) {
        const rings = [];
        poly.forEach((ring, ri) => {
          let r = ring.slice(0, -1).map(tf);
          if (opts.chaikin) r = chaikin(r, opts.chaikin);
          r = simplifyRing(r, opts.simplify || 0);
          if (r.length < 3) return;
          const a = Math.abs(ringArea(r));
          if (a < minArea) { if (ri === 0) rings.length = 0, rings.dead = true; return; }
          if (!rings.dead) rings.push(r);
        });
        if (!rings.dead && rings.length) polygons.push(rings);
      }
      layers.push({ index: idx + 1, depth: d, polygons });
    });
    return { layout, layers, grid };
  }

  // ---------------------------------------------------------------------------
  // Single-stroke engraving font (cap height 6, width 4). Lowercase → uppercase.
  // ---------------------------------------------------------------------------
  const O = [[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]];
  const P = [[0, 6], [0, 0], [3, 0], [4, 1], [4, 2], [3, 3], [0, 3]];
  const GLYPHS = {
    'A': [[[0, 6], [2, 0], [4, 6]], [[0.7, 4], [3.3, 4]]],
    'B': [[[0, 6], [0, 0], [3, 0], [4, 0.8], [4, 2.2], [3, 3], [0, 3]], [[3, 3], [4, 3.8], [4, 5.2], [3, 6], [0, 6]]],
    'C': [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5]]],
    'D': [[[0, 0], [0, 6], [2.5, 6], [4, 4.5], [4, 1.5], [2.5, 0], [0, 0]]],
    'E': [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
    'F': [[[4, 0], [0, 0], [0, 6]], [[0, 3], [3, 3]]],
    'G': [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 5], [1, 6], [3, 6], [4, 5], [4, 3.5], [2.2, 3.5]]],
    'H': [[[0, 0], [0, 6]], [[4, 0], [4, 6]], [[0, 3], [4, 3]]],
    'I': [[[1, 0], [3, 0]], [[2, 0], [2, 6]], [[1, 6], [3, 6]]],
    'J': [[[4, 0], [4, 5], [3, 6], [1, 6], [0, 5]]],
    'K': [[[0, 0], [0, 6]], [[4, 0], [0, 3.5]], [[1.3, 2.6], [4, 6]]],
    'L': [[[0, 0], [0, 6], [4, 6]]],
    'M': [[[0, 6], [0, 0], [2, 3], [4, 0], [4, 6]]],
    'N': [[[0, 6], [0, 0], [4, 6], [4, 0]]],
    'O': [O],
    'P': [P],
    'Q': [O, [[2.5, 4.5], [4, 6]]],
    'R': [P, [[2, 3], [4, 6]]],
    'S': [[[4, 1], [3, 0], [1, 0], [0, 1], [0, 2], [1, 3], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]]],
    'T': [[[0, 0], [4, 0]], [[2, 0], [2, 6]]],
    'U': [[[0, 0], [0, 5], [1, 6], [3, 6], [4, 5], [4, 0]]],
    'V': [[[0, 0], [2, 6], [4, 0]]],
    'W': [[[0, 0], [1, 6], [2, 2.5], [3, 6], [4, 0]]],
    'X': [[[0, 0], [4, 6]], [[4, 0], [0, 6]]],
    'Y': [[[0, 0], [2, 3], [4, 0]], [[2, 3], [2, 6]]],
    'Z': [[[0, 0], [4, 0], [0, 6], [4, 6]]],
    '0': [O, [[3.6, 0.6], [0.4, 5.4]]],
    '1': [[[1, 1], [2, 0], [2, 6]], [[1, 6], [3, 6]]],
    '2': [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [0, 6], [4, 6]]],
    '3': [[[0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [4, 4], [4, 5], [3, 6], [1, 6], [0, 5]], [[1.5, 3], [3, 3]]],
    '4': [[[3, 6], [3, 0], [0, 4], [4, 4]]],
    '5': [[[4, 0], [0, 0], [0, 2.8], [3, 2.8], [4, 3.8], [4, 5], [3, 6], [1, 6], [0, 5]]],
    '6': [[[3.5, 0], [1.5, 0], [0, 1.5], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]]],
    '7': [[[0, 0], [4, 0], [1.5, 6]]],
    '8': [[[1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 2], [3, 3], [1, 3], [0, 4], [0, 5], [1, 6], [3, 6], [4, 5], [4, 4], [3, 3]]],
    '9': [[[4, 3], [1, 3], [0, 2], [0, 1], [1, 0], [3, 0], [4, 1], [4, 4.5], [2.5, 6], [0.5, 6]]],
    '.': [[[1.7, 5.6], [2.3, 5.6], [2.3, 6], [1.7, 6], [1.7, 5.6]]],
    ',': [[[2.3, 5.2], [2.3, 6], [1.6, 7]]],
    '-': [[[1, 3], [3, 3]]],
    '\'': [[[2, 0], [2, 1.6]]],
    '"': [[[1.4, 0], [1.4, 1.6]], [[2.6, 0], [2.6, 1.6]]],
    ':': [[[1.7, 1.6], [2.3, 1.6], [2.3, 2.2], [1.7, 2.2], [1.7, 1.6]], [[1.7, 5.2], [2.3, 5.2], [2.3, 5.8], [1.7, 5.8], [1.7, 5.2]]],
    '/': [[[0, 6], [4, 0]]],
    '&': [[[4, 6], [0.8, 2.4], [0.8, 1], [1.6, 0], [2.6, 0], [3.2, 1], [3, 2], [0, 4.2], [0, 5.2], [1, 6], [2.6, 6], [4, 4]]],
    '#': [[[1.3, 0.5], [0.8, 5.5]], [[3.2, 0.5], [2.7, 5.5]], [[0, 2], [4, 2]], [[0, 4], [4, 4]]],
    '(': [[[2.8, -0.3], [1.5, 1.5], [1.5, 4.5], [2.8, 6.3]]],
    ')': [[[1.2, -0.3], [2.5, 1.5], [2.5, 4.5], [1.2, 6.3]]],
    '°': [[[1.2, 0], [2.2, 0], [2.6, 0.5], [2.6, 1.3], [2.2, 1.8], [1.2, 1.8], [0.8, 1.3], [0.8, 0.5], [1.2, 0]]]
  };
  const ADV = 5.4, SPACE = 4;
  // narrow glyphs: [x shift, advance]
  const NARROW = { 'I': [-1, 3.4], '.': [-1.4, 2.6], ',': [-1.4, 2.6], ':': [-1.4, 2.6], '\'': [-1.4, 2.6],
                   '"': [-0.9, 3.4], '(': [-1, 3.4], ')': [-1, 3.4], '1': [-0.6, 4.4] };
  function adv(ch) { return ch === ' ' || !GLYPHS[ch] ? SPACE : (NARROW[ch] ? NARROW[ch][1] : ADV); }

  function textWidth(str, size) {
    const s = size / 6;
    let w = 0;
    for (const ch of String(str).toUpperCase()) w += adv(ch) * s;
    return Math.max(0, w - 1.4 * s);
  }
  /** Returns an SVG path "d" for text with its top-left at (x, y). */
  function textPath(str, x, y, size) {
    const s = size / 6;
    let cx = x, d = '';
    for (const ch of String(str).toUpperCase()) {
      const g = GLYPHS[ch];
      if (!g) { cx += SPACE * s; continue; }
      const sh = NARROW[ch] ? NARROW[ch][0] : 0;
      for (const line of g) {
        d += 'M' + line.map(p => fmt(cx + (p[0] + sh) * s) + ' ' + fmt(y + p[1] * s)).join('L');
      }
      cx += adv(ch) * s;
    }
    return d;
  }
  function textPathCentered(str, cx, cy, size, maxWidth) {
    let sz = size;
    const tw = textWidth(str, sz);
    if (maxWidth && tw > maxWidth) sz = size * maxWidth / tw;
    return textPath(str, cx - textWidth(str, sz) / 2, cy - sz / 2, sz);
  }

  // ---------------------------------------------------------------------------
  // SVG writing
  // ---------------------------------------------------------------------------
  function fmt(v) { return (Math.round(v * 100) / 100).toString(); }
  function ringPath(r) { return 'M' + r.map(p => fmt(p[0]) + ' ' + fmt(p[1])).join('L') + 'Z'; }
  function polygonsPath(polys) { return polys.map(p => p.map(ringPath).join('')).join(''); }

  function panelOutlinePath(L) {
    if (L.shape === 'circle') {
      const r = L.W / 2;
      return `M${fmt(0)} ${fmt(r)}A${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(L.W)} ${fmt(r)}A${fmt(r)} ${fmt(r)} 0 1 0 0 ${fmt(r)}Z`;
    }
    const rr = Math.min(L.cornerRadius, L.W / 2, L.H / 2);
    if (!rr) return `M0 0H${fmt(L.W)}V${fmt(L.H)}H0Z`;
    const W = L.W, H = L.H;
    return `M${fmt(rr)} 0H${fmt(W - rr)}A${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(W)} ${fmt(rr)}V${fmt(H - rr)}` +
      `A${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(W - rr)} ${fmt(H)}H${fmt(rr)}A${fmt(rr)} ${fmt(rr)} 0 0 1 0 ${fmt(H - rr)}` +
      `V${fmt(rr)}A${fmt(rr)} ${fmt(rr)} 0 0 1 ${fmt(rr)} 0Z`;
  }

  function registrationHoles(L, dia) {
    if (!dia) return [];
    const m = L.margin;
    if (m < dia * 1.8) return [];
    if (L.shape === 'circle') {
      const c = L.W / 2, rr = c - m / 2;
      return [45, 135, 225, 315].map(a => [c + rr * Math.cos(a * Math.PI / 180), c + rr * Math.sin(a * Math.PI / 180)]);
    }
    const inset = Math.max(m / 2, Math.min(L.cornerRadius * 0.6, m - dia));
    return [[inset, inset], [L.W - inset, inset], [L.W - inset, L.H - inset], [inset, L.H - inset]];
  }
  function circlePath(c, r) {
    return `M${fmt(c[0] - r)} ${fmt(c[1])}a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(2 * r)} 0a${fmt(r)} ${fmt(r)} 0 1 0 ${fmt(-2 * r)} 0Z`;
  }

  function formatDepth(m, unit) {
    const v = unit === 'ft' ? m / M_PER_FT : m;
    const r = v >= 100 ? Math.round(v) : Math.round(v * 10) / 10;
    return r.toLocaleString('en-US') + (unit === 'ft' ? ' FT' : ' M');
  }

  /**
   * Build the SVG for one layer.
   * result: output of buildLayers; k: 0-based layer index, or result.layers.length for the backing
   * o: { cutColor, scoreColor, strokeWidth, holeDia, labels, guides, title, subtitle, unit, lakeName }
   */
  function layerSVG(result, k, o) {
    const L = result.layout, layers = result.layers;
    const isBacking = k >= layers.length;
    const cut = [], score = [];
    cut.push(panelOutlinePath(L));
    for (const c of registrationHoles(L, o.holeDia)) cut.push(circlePath(c, o.holeDia / 2));
    if (!isBacking) cut.push(polygonsPath(layers[k].polygons));

    // alignment guide: outline of the hole in the layer directly above
    if (o.guides && k > 0) score.push(polygonsPath(layers[k - 1].polygons));

    const labelSize = Math.min(4, L.margin * 0.35);
    if (o.labels && k > 0 && labelSize >= 2) {
      const text = isBacking ? `BACK - ${layers.length + 1}` : `${k + 1} - ${formatDepth(layers[k].depth, o.unit)}`;
      const y = L.shape === 'circle' ? L.margin * 0.5 : L.margin * 0.5;
      score.push(textPathCentered(text, L.W / 2, y, labelSize, L.W * 0.5));
    }
    if (k === 0 && (o.title || o.subtitle) && L.titleH) {
      let th = L.titleH, cy;
      if (L.shape === 'circle') {
        const R = L.W / 2, Ri = R - L.margin * 0.4;
        const lakeBottom = L.oy + result.grid.h * L.scale;
        const avail = (L.H - L.margin * 0.6) - lakeBottom;
        const both = o.title && o.subtitle;
        th = Math.min(th, avail / (both ? 2.3 : 1.5));
        if (th >= 2) {
          const blockH = th * (both ? 1.75 : 1);
          const top = lakeBottom + (avail - blockH) / 2;
          const chordAt = (yy) => 2 * Math.sqrt(Math.max(0, Ri * Ri - (yy - R) * (yy - R)));
          const t1 = o.title || o.subtitle;
          score.push(textPathCentered(t1, R, top + th / 2, th, chordAt(top + th) * 0.82));
          if (both) score.push(textPathCentered(o.subtitle, R, top + th * 1.45, th * 0.55, chordAt(top + blockH) * 0.82));
        }
      } else {
        const bandTop = L.H - L.margin - L.band;
        const maxW = L.W - 2 * L.margin;
        const mid = (bandTop + L.H) / 2; // centre of the bottom border
        if (o.title && o.subtitle) {
          cy = mid;
          score.push(textPathCentered(o.title, L.W / 2, cy - th * 0.4, th, maxW));
          score.push(textPathCentered(o.subtitle, L.W / 2, cy + th * 0.6, th * 0.55, maxW));
        } else {
          cy = mid;
          score.push(textPathCentered(o.title || o.subtitle, L.W / 2, cy, th, maxW));
        }
      }
    }

    const sw = o.strokeWidth || 0.1;
    const name = isBacking ? 'Backing' : `Layer ${k + 1}`;
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(L.W)}mm" height="${fmt(L.H)}mm" viewBox="0 0 ${fmt(L.W)} ${fmt(L.H)}">\n` +
      `<title>${esc(o.lakeName || 'Lake')} — ${name}</title>\n` +
      `<g id="cut" fill="none" stroke="${o.cutColor || '#FF0000'}" stroke-width="${sw}">\n<path fill-rule="evenodd" d="${cut.join('')}"/>\n</g>\n` +
      (score.length ? `<g id="score" fill="none" stroke="${o.scoreColor || '#0000FF'}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round">\n<path d="${score.join('')}"/>\n</g>\n` : '') +
      `</svg>\n`;
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

  /** Every sheet laid out in a grid on one SVG, for nesting or a quick look. */
  function combinedSVG(result, o, cols) {
    const L = result.layout, n = result.layers.length + (o.backing ? 1 : 0);
    cols = cols || Math.ceil(Math.sqrt(n));
    const gap = 10, rows = Math.ceil(n / cols);
    const TW = cols * L.W + (cols - 1) * gap, TH = rows * L.H + (rows - 1) * gap;
    let body = '';
    for (let k = 0; k < n; k++) {
      const s = layerSVG(result, k, o);
      const inner = s.slice(s.indexOf('<g '), s.lastIndexOf('</svg>'));
      const x = (k % cols) * (L.W + gap), y = Math.floor(k / cols) * (L.H + gap);
      body += `<g id="sheet-${k + 1}" transform="translate(${fmt(x)} ${fmt(y)})">\n${inner}</g>\n`;
    }
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(TW)}mm" height="${fmt(TH)}mm" viewBox="0 0 ${fmt(TW)} ${fmt(TH)}">\n${body}</svg>\n`;
  }

  return {
    M_PER_FT, PRESETS, floodFill, largestComponent, isolateLake, smoothLake, layerDepths,
    buildLayers, panelLayout, layerSVG, combinedSVG, polygonsPath, panelOutlinePath,
    registrationHoles, ringArea, simplifyRing, chaikin, textPath, textWidth, formatDepth, GLYPHS
  };
});
