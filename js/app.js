/* Lake Depth Map Maker — UI */
(function () {
  'use strict';
  const C = window.LakeCore, D = window.LakeData;
  const $ = (id) => document.getElementById(id);
  const MM = { in: 25.4, mm: 1 };
  const STORE = 'lakeDepthMap.settings.v1';

  const state = { lake: null, result: null, view: 'stack', file: null, map: null, marker: null, busy: false };

  // ------------------------------------------------------------------ settings
  const SETTING_IDS = ['nLayers', 'spacing', 'depthUnit', 'nice', 'customDepths', 'backing', 'units', 'shape',
    'width', 'height', 'margin', 'radius', 'thickness', 'holeDia', 'resolution', 'smooth', 'minPiece',
    'useTitle', 'useSubtitle', 'labels', 'guides', 'cutColor', 'scoreColor', 'strokeWidth', 'palette'];

  function saveSettings() {
    const o = {};
    for (const id of SETTING_IDS) { const el = $(id); o[id] = el.type === 'checkbox' ? el.checked : el.value; }
    try { localStorage.setItem(STORE, JSON.stringify(o)); } catch (e) { /* storage unavailable */ }
  }
  function loadSettings() {
    let o = null;
    try { o = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch (e) { o = null; }
    if (!o) return;
    for (const id of SETTING_IDS) {
      if (!(id in o)) continue;
      const el = $(id);
      if (el.type === 'checkbox') el.checked = !!o[id]; else el.value = o[id];
    }
  }

  function num(id, fallback) { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : fallback; }

  function settings() {
    const u = MM[$('units').value];
    const custom = $('customDepths').value.split(/[,\s;]+/).map(parseFloat).filter(Number.isFinite);
    return {
      n: parseInt($('nLayers').value, 10),
      spacing: $('spacing').value,
      unit: $('depthUnit').value,
      nice: $('nice').checked,
      custom,
      backing: $('backing').checked,
      shape: $('shape').value,
      width: num('width', 12) * u,
      height: $('height').value ? num('height', 0) * u : null,
      margin: num('margin', 1) * u,
      radius: num('radius', 0) * u,
      thickness: num('thickness', 0.125) * u,
      holeDia: num('holeDia', 0) * u,
      smooth: parseInt($('smooth').value, 10),
      minPiece: parseFloat($('minPiece').value),
      labels: $('labels').checked,
      guides: $('guides').checked,
      cutColor: $('cutColor').value.toUpperCase(),
      scoreColor: $('scoreColor').value.toUpperCase(),
      strokeWidth: num('strokeWidth', 0.1),
      palette: $('palette').value
    };
  }

  function fmtLen(mm) {
    if ($('units').value === 'mm') return (mm < 10 ? Math.round(mm * 10) / 10 : Math.round(mm)) + ' mm';
    const v = mm / 25.4;
    return v.toFixed(v < 1 ? 3 : 2).replace(/\.?0+$/, '') + '"';
  }

  // ------------------------------------------------------------------ status
  function status(msg, frac, isError) {
    const el = $('status');
    el.hidden = !msg;
    el.classList.toggle('error', !!isError);
    el.querySelector('span').textContent = msg || '';
    el.querySelector('.bar i').style.width = ((frac || 0) * 100) + '%';
  }

  // ------------------------------------------------------------------ loading lakes
  async function loadFromTiles({ bbox, surface, seed, exclude, name, knownMaxDepth }) {
    if (state.busy) return;
    state.busy = true;
    try {
      status('Downloading depth tiles…', 0);
      const target = parseInt($('resolution').value, 10);
      const tile = await D.fetchElevation(bbox, target, (d, t) => status(`Downloading depth tiles… ${d}/${t}`, d / t));
      status('Finding the lake…', 1);
      await tick();
      const depth = new Float32Array(tile.w * tile.h);
      for (let i = 0; i < depth.length; i++) depth[i] = surface - tile.elev[i];
      const seedPx = seed ? tile.toPixel(seed[0], seed[1]) : null;
      let seedElev = null;
      if (seedPx) {
        const sx = Math.round(seedPx[0]), sy = Math.round(seedPx[1]);
        if (sx >= 0 && sy >= 0 && sx < tile.w && sy < tile.h) seedElev = tile.elev[sy * tile.w + sx];
      }
      const lake = C.isolateLake(depth, tile.w, tile.h, {
        mode: seedPx ? 'seed' : 'largest', seed: seedPx, excludeMask: D.excludeMask(tile, exclude), minDepth: 0.3
      });
      if (!lake.waterPixels || lake.maxDepth < 1) {
        const at = seedElev != null ? ` The ground at your marker is ${Math.round(seedElev)} m above sea level.` : '';
        status(`No lake-floor depths found here — the terrain data is flat at this lake.${at} Check the surface elevation, or use Upload data.`, 0, true);
        return;
      }
      lake.aspect = 1; // Web Mercator pixels are locally square
      setLake(Object.assign(lake, { name, knownMaxDepth }));
      status('');
    } catch (e) {
      console.error(e);
      const blocked = e instanceof TypeError;
      status(blocked
        ? 'Couldn’t reach the depth-tile server. If you’re viewing this inside Claude, outside data is blocked there — it works once hosted on GitHub Pages. Try the demo lake or Upload data.'
        : 'Could not download depth data (' + (e.message || e) + '). Check your connection and try again.', 0, true);
    } finally {
      state.busy = false;
    }
  }

  function loadPreset(key) {
    const p = C.PRESETS[key];
    document.querySelectorAll('.lake-btn').forEach(b => b.classList.toggle('active', b.dataset.lake === key));
    return loadFromTiles({ bbox: p.bbox, surface: p.surface, seed: p.seed, exclude: p.exclude, name: p.name, knownMaxDepth: p.knownMaxDepth });
  }

  /** A made-up lake (two basins, an island, a shoal) for trying the tool without any downloads. */
  function demoLake() {
    const w = 900, h = 560, depth = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const nx = (x - 450) / 400, ny = (y - 280) / 230;
      const wob = 0.12 * Math.sin(nx * 9 + 1) * Math.cos(ny * 6) + 0.07 * Math.sin(ny * 13 + nx * 4);
      const r = nx * nx * (1 + 0.35 * ny) + ny * ny * 1.15 + wob;
      let d = r < 1 ? Math.pow(1 - r, 1.15) * 70 : -1;
      if (d > 0) {
        d += 45 * Math.exp(-(((nx + 0.45) / 0.22) ** 2 + ((ny + 0.1) / 0.3) ** 2));
        d += 30 * Math.exp(-(((nx - 0.42) / 0.18) ** 2 + ((ny - 0.15) / 0.25) ** 2));
        d -= 55 * Math.exp(-(((nx - 0.05) / 0.12) ** 2 + ((ny + 0.05) / 0.2) ** 2)); // mid-lake shoal
        if (((nx + 0.15) / 0.11) ** 2 + ((ny - 0.45) / 0.07) ** 2 < 1) d = -1; // island
      }
      depth[y * w + x] = d;
    }
    const lake = C.isolateLake(depth, w, h, { mode: 'largest' });
    lake.aspect = 1;
    document.querySelectorAll('.lake-btn').forEach(b => b.classList.toggle('active', b.dataset.lake === 'demo'));
    setLake(Object.assign(lake, { name: 'Demo Lake' }));
    status('');
  }

  function setLake(lake) {
    state.lake = lake;
    $('empty').hidden = true;
    $('title').placeholder = lake.name || '(lake name)';
    $('subtitle').placeholder = autoSubtitle();
    regenerate();
  }

  function autoSubtitle() {
    if (!state.lake) return '(max depth)';
    const d = state.lake.knownMaxDepth || state.lake.maxDepth;
    return 'Max depth ' + C.formatDepth(d, $('depthUnit').value).toLowerCase().replace(' ft', ' ft').replace(' m', ' m');
  }

  const tick = () => new Promise(r => setTimeout(r, 0));

  // ------------------------------------------------------------------ map tab
  function initMap() {
    if (state.map || !window.L) return;
    const map = L.map('map', { worldCopyJump: true }).setView([44.5, -84.5], 6);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 16, attribution: '&copy; OpenStreetMap contributors'
    }).addTo(map);
    map.on('click', (e) => {
      if (state.marker) state.marker.setLatLng(e.latlng);
      else state.marker = L.marker(e.latlng).addTo(map);
    });
    state.map = map;
  }

  function loadFromMap() {
    if (!state.map) return;
    const name = $('mapName').value.trim() || 'Lake';
    let surface = parseFloat($('mapSurface').value);
    if (!Number.isFinite(surface)) { status('Enter the lake’s surface elevation first.', 0, true); return; }
    if ($('mapSurfaceUnit').value === 'ft') surface *= C.M_PER_FT;
    if (!state.marker) { status('Tap inside the lake on the map to drop a marker first.', 0, true); return; }
    const b = state.map.getBounds();
    const bbox = [b.getWest(), Math.max(-85, b.getSouth()), b.getEast(), Math.min(85, b.getNorth())];
    const ll = state.marker.getLatLng();
    document.querySelectorAll('.lake-btn').forEach(x => x.classList.remove('active'));
    loadFromTiles({ bbox, surface, seed: [ll.lng, ll.lat], name });
  }

  // ------------------------------------------------------------------ file tab
  async function readFile(file) {
    status('Reading ' + file.name + '…', 0.3);
    try {
      const ext = file.name.split('.').pop().toLowerCase();
      let parsed;
      if (ext === 'tif' || ext === 'tiff') parsed = await D.readGeoTIFF(await file.arrayBuffer());
      else if (ext === 'asc' || ext === 'txt') parsed = D.readASC(await file.text());
      else parsed = { isImage: true, file };
      state.file = parsed;
      const opts = $('fileOptions');
      opts.hidden = false;
      opts.classList.toggle('is-image', !!parsed.isImage);
      $('fileName').value = $('fileName').value || file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
      if (parsed.isImage) {
        $('fileInfo').textContent = `${file.name} — image heightmap`;
      } else {
        const r = (v) => Number.isFinite(v) ? (Math.round(v * 100) / 100).toLocaleString() : '—';
        $('fileInfo').textContent = `${file.name} — ${parsed.w}×${parsed.h} cells, values ${r(parsed.min)} to ${r(parsed.max)}` +
          (parsed.nodata != null ? `, no-data ${parsed.nodata}` : '') + (parsed.geographic ? ', lat/long grid' : '');
        $('fileGeo').checked = !!parsed.geographic;
        // guess what the numbers mean
        let meaning = 'depth';
        if (parsed.max <= 0) meaning = 'negdepth';
        else if (parsed.min < 0 && Math.abs(parsed.min) > parsed.max) meaning = 'negdepth';
        else if (parsed.min > 20) meaning = 'elevation';
        $('fileMeaning').value = meaning;
        $('fileSurfaceRow').hidden = meaning !== 'elevation';
        $('fileSurface').placeholder = 'lake level, e.g. ' + Math.round(parsed.min + (parsed.max - parsed.min) * 0.6);
      }
      status('');
    } catch (e) {
      console.error(e);
      status('Could not read that file: ' + (e.message || e), 0, true);
    }
  }

  async function useFile() {
    const f = state.file;
    if (!f) return;
    status('Processing…', 0.5);
    await tick();
    try {
      let depth, w, h, aspect;
      if (f.isImage) {
        const img = await D.readImage(f.file, $('fileDarkDeep').checked);
        let max = num('fileImgMax', 30);
        if ($('fileImgUnit').value === 'ft') max *= C.M_PER_FT;
        depth = img.vals.map(v => v * max);
        w = img.w; h = img.h; aspect = 1;
      } else {
        const meaning = $('fileMeaning').value;
        const surface = parseFloat($('fileSurface').value);
        if (meaning === 'elevation' && !Number.isFinite(surface)) { status('Enter the lake surface elevation.', 0, true); return; }
        depth = D.valuesToDepth(f.vals, { meaning, surface, units: $('fileUnits').value, nodata: f.nodata });
        w = f.w; h = f.h;
        aspect = $('fileGeo').checked ? f.geoAspect : f.rawAspect;
      }
      const lake = C.isolateLake(depth, w, h, { mode: $('fileWhich').value, minDepth: 0.01 });
      if (!lake.waterPixels || lake.maxDepth <= 0) { status('No water deeper than 0 found — check “Values are” and the surface elevation.', 0, true); return; }
      lake.aspect = aspect || 1;
      document.querySelectorAll('.lake-btn').forEach(x => x.classList.remove('active'));
      setLake(Object.assign(lake, { name: $('fileName').value.trim() || 'Lake' }));
      status('');
    } catch (e) {
      console.error(e);
      status('Could not use that file: ' + (e.message || e), 0, true);
    }
  }

  // ------------------------------------------------------------------ generation
  let regenTimer = null;
  function scheduleRegen() { clearTimeout(regenTimer); regenTimer = setTimeout(regenerate, 120); }

  function svgOptions(s) {
    const lake = state.lake;
    const title = $('useTitle').checked ? ($('title').value.trim() || lake.name || '') : '';
    const subtitle = $('useSubtitle').checked ? ($('subtitle').value.trim() || autoSubtitle()) : '';
    return {
      cutColor: s.cutColor, scoreColor: s.scoreColor, strokeWidth: s.strokeWidth, holeDia: s.holeDia,
      labels: s.labels, guides: s.guides, title, subtitle, unit: s.unit, lakeName: lake.name, backing: s.backing
    };
  }

  function regenerate() {
    saveSettings();
    $('nLayersOut').textContent = $('nLayers').value;
    $('smoothOut').textContent = $('smooth').value;
    const mp = parseFloat($('minPiece').value);
    $('minPieceOut').textContent = mp ? fmtLen(mp).replace('"', ' in') : 'off';
    $('subtitle').placeholder = autoSubtitle();
    if (!state.lake) return;
    const s = settings();
    const lake = state.lake;
    const depths = C.layerDepths(lake, s.n, s.spacing, { nice: s.nice, unit: s.unit, custom: s.custom });
    const o = svgOptions(s);
    const smoothPx = s.smooth ? Math.max(1, Math.round(s.smooth * Math.max(lake.w, lake.h) / 1200)) : 0;
    state.result = C.buildLayers(lake, d3.contours, {
      depths, smoothing: smoothPx, chaikin: s.smooth ? 1 : 0, simplify: 0.08, minArea: s.minPiece * s.minPiece,
      panel: { width: s.width, height: s.height, margin: s.margin, shape: s.shape, cornerRadius: s.radius,
               title: o.title, subtitle: o.subtitle }
    });
    state.opts = o;
    state.settings = s;
    render();
  }

  // ------------------------------------------------------------------ palettes
  function hex(c) { return [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16)); }
  function mix(a, b, t) {
    const A = hex(a), B = hex(b);
    return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('');
  }
  function ramp(a, b, n) { return Array.from({ length: n }, (_, i) => mix(a, b, n === 1 ? 1 : i / (n - 1))); }
  function paletteColors(name, nSheets) {
    const rest = Math.max(1, nSheets - 1);
    switch (name) {
      case 'wood': return ramp('#ecd7b2', '#6e4a2c', nSheets);
      case 'chart': return ['#f0e2b6'].concat(ramp('#a8d4ec', '#ffffff', rest));
      case 'mono': return ramp('#ffffff', '#5c5c5c', nSheets);
      default: return ['#d8b98f'].concat(ramp('#cde6f1', '#0b2f4c', rest));
    }
  }

  // ------------------------------------------------------------------ rendering
  function sheetCount() { return state.result.layers.length + (state.settings.backing ? 1 : 0); }

  function render() {
    const r = state.result, s = state.settings, L = r.layout;
    const nSheets = sheetCount();
    const colors = paletteColors(s.palette, nSheets);

    // summary
    const lake = state.lake;
    const stack = nSheets * s.thickness;
    const pieces = r.layers.reduce((a, l) => a + l.polygons.reduce((b, p) => b + p.length - 1, 0), 0);
    let warn = '';
    if (r.layers.length < s.n && !s.custom.length) warn = `Only ${r.layers.length} distinct depth steps fit this lake — turn off rounding or use fewer layers.`;
    if (s.holeDia && L.margin < s.holeDia * 1.8) warn += (warn ? ' ' : '') + 'Border is too narrow for pin holes, so they were left off.';
    $('summary').innerHTML =
      `<span><b>${esc(lake.name || 'Lake')}</b></span>` +
      `<span><b>${nSheets}</b> sheets</span>` +
      `<span><b>${fmtLen(L.W)} × ${fmtLen(L.H)}</b></span>` +
      `<span>stack <b>${fmtLen(stack)}</b> thick</span>` +
      `<span>deepest in data <b>${C.formatDepth(lake.maxDepth, s.unit).toLowerCase()}</b></span>` +
      (pieces ? `<span><b>${pieces}</b> island/shoal pieces to glue down</span>` : '') +
      (warn ? `<span class="warn">${warn}</span>` : '');

    // legend
    const legend = [];
    for (let k = 0; k < nSheets; k++) {
      const isBack = k >= r.layers.length;
      const what = k === 0 ? 'top · shoreline frame' : isBack ? 'backing' : 'water deeper than ' + C.formatDepth(r.layers[k].depth, s.unit).toLowerCase();
      legend.push(`<div class="legend-item"><span class="swatch" style="background:${colors[k]}"></span>` +
        `<span>Sheet ${k + 1}<br><small>${what}</small></span><a data-sheet="${k}">SVG</a></div>`);
    }
    $('legend').innerHTML = legend.join('');

    $('dlZip').disabled = false;
    $('dlCombined').disabled = false;

    if (state.view === 'stack') drawStack(colors);
    else if (state.view === 'depth') drawDepth();
    else drawSheets();
  }

  function setupCanvas(W, H) {
    const cv = $('preview');
    const wrap = $('canvasWrap');
    const maxW = wrap.clientWidth - 32;
    const maxH = Math.max(320, window.innerHeight * 0.62);
    const scale = Math.min(maxW / W, maxH / H);
    const dpr = window.devicePixelRatio || 1;
    cv.style.width = Math.round(W * scale) + 'px';
    cv.style.height = Math.round(H * scale) + 'px';
    cv.width = Math.round(W * scale * dpr);
    cv.height = Math.round(H * scale * dpr);
    const ctx = cv.getContext('2d');
    ctx.setTransform(scale * dpr, 0, 0, scale * dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    return { ctx, px: 1 / (scale * dpr), scale: scale * dpr };
  }

  function drawStack(colors) {
    const r = state.result, s = state.settings, L = r.layout;
    $('preview').hidden = false; $('sheets').hidden = true;
    const { ctx, scale } = setupCanvas(L.W, L.H);
    const outline = C.panelOutlinePath(L);
    const holes = C.registrationHoles(L, s.holeDia).map(c => {
      const rr = s.holeDia / 2;
      return `M${c[0] - rr} ${c[1]}a${rr} ${rr} 0 1 0 ${2 * rr} 0a${rr} ${rr} 0 1 0 ${-2 * rr} 0Z`;
    }).join('');
    const n = sheetCount();
    for (let k = n - 1; k >= 0; k--) {
      const lakePath = k < r.layers.length ? C.polygonsPath(r.layers[k].polygons) : '';
      const p = new Path2D(outline + holes + lakePath);
      ctx.save();
      if (k < n - 1) {
        ctx.shadowColor = 'rgba(10, 25, 40, 0.38)';
        ctx.shadowBlur = Math.max(2, Math.min(9, s.thickness * 1.6)) * scale;
        ctx.shadowOffsetX = ctx.shadowOffsetY = Math.max(0.6, s.thickness * 0.35) * scale;
      }
      ctx.fillStyle = colors[k];
      ctx.fill(p, 'evenodd');
      ctx.restore();
    }
    // title engraving on the top sheet
    const svg = C.layerSVG(r, 0, Object.assign({}, state.opts, { labels: false, guides: false }));
    const m = svg.match(/<g id="score"[^>]*>\s*<path d="([^"]*)"/);
    if (m) {
      ctx.strokeStyle = s.palette === 'mono' ? '#555' : 'rgba(70, 40, 15, 0.75)';
      ctx.lineWidth = Math.max(0.25, L.titleH * 0.08);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke(new Path2D(m[1]));
    }
    // panel edge
    ctx.strokeStyle = 'rgba(0,0,0,0.25)';
    ctx.lineWidth = 1 / scale;
    ctx.stroke(new Path2D(outline));
  }

  function drawDepth() {
    const lake = state.lake;
    $('preview').hidden = false; $('sheets').hidden = true;
    const W = lake.w * lake.aspect, H = lake.h;
    const { ctx } = setupCanvas(W, H);
    const off = document.createElement('canvas');
    off.width = lake.w; off.height = lake.h;
    const octx = off.getContext('2d');
    const img = octx.createImageData(lake.w, lake.h);
    const stops = ['#d6efe9', '#7fc4d6', '#3a86b4', '#1b4f86', '#0c2350'];
    const rgb = stops.map(hex);
    for (let i = 0; i < lake.w * lake.h; i++) {
      const d = lake.depth[i];
      let c;
      if (d < 0) c = [236, 228, 210];
      else {
        const t = Math.min(1, d / lake.maxDepth) * (rgb.length - 1);
        const a = Math.floor(t), f = t - a, A = rgb[a], B = rgb[Math.min(a + 1, rgb.length - 1)];
        c = A.map((v, j) => v + (B[j] - v) * f);
      }
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
    }
    octx.putImageData(img, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(off, 0, 0, W, H);
  }

  function drawSheets() {
    const r = state.result;
    $('preview').hidden = true;
    const box = $('sheets');
    box.hidden = false;
    const n = sheetCount();
    let html = '';
    for (let k = 0; k < n; k++) {
      const svg = C.layerSVG(r, k, Object.assign({}, state.opts, { strokeWidth: r.layout.W / 300 }));
      const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      const label = k === 0 ? 'Sheet 1 · top' : k >= r.layers.length ? `Sheet ${k + 1} · backing` : `Sheet ${k + 1}`;
      html += `<div class="sheet"><img src="${url}" alt="${label}"><div class="cap"><span>${label}</span><button data-sheet="${k}">SVG</button></div></div>`;
    }
    box.innerHTML = html;
  }

  // ------------------------------------------------------------------ downloads
  function slug() {
    return (state.lake.name || 'lake').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'lake';
  }
  function sheetFileName(k) {
    const r = state.result;
    const nn = String(k + 1).padStart(2, '0');
    const tag = k === 0 ? '-top' : k >= r.layers.length ? '-backing' : '';
    return `${slug()}-sheet-${nn}${tag}.svg`;
  }
  // Inside a Claude artifact, files are saved through the platform's downloads capability.
  let claudeDownloads = null;
  if (window.claude && typeof window.claude.use === 'function') {
    window.claude.use('downloads').then(d => { claudeDownloads = d; }).catch(() => {});
  }
  async function download(name, content, type) {
    const blob = content instanceof Blob ? content : new Blob([content], { type: type || 'image/svg+xml' });
    if (claudeDownloads) {
      try { await claudeDownloads.save({ filename: name, data: blob }); }
      catch (e) { if (e && e.code !== 'declined') status('Could not save ' + name + ' (' + (e.code || e.message || e) + ').', 0, true); }
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  function downloadSheet(k) { download(sheetFileName(k), C.layerSVG(state.result, k, state.opts)); }

  function readme() {
    const r = state.result, s = state.settings, L = r.layout, n = sheetCount();
    const lines = [
      `${state.lake.name} — layered depth map`,
      '='.repeat(40),
      `Generated ${new Date().toLocaleDateString()} with Lake Depth Map Maker.`,
      '',
      `Sheet size: ${fmtLen(L.W)} x ${fmtLen(L.H)}  (${L.W.toFixed(1)} x ${L.H.toFixed(1)} mm)`,
      `Sheets: ${n}   Material: ${fmtLen(s.thickness)}   Stack height: ${fmtLen(n * s.thickness)}`,
      `Deepest point in data: ${C.formatDepth(state.lake.maxDepth, s.unit).toLowerCase()}`,
      '',
      'Colors: RED (' + s.cutColor + ') = cut through.  BLUE (' + s.scoreColor + ') = score / light engrave.',
      'SVGs are real size in millimeters. Import at 100% scale.',
      '',
      'Stack order (top to bottom):'
    ];
    for (let k = 0; k < n; k++) {
      const isBack = k >= r.layers.length;
      const what = k === 0 ? 'shoreline frame (top)' : isBack ? 'solid backing' : 'cut-out = water deeper than ' + C.formatDepth(r.layers[k].depth, s.unit).toLowerCase();
      lines.push(`  ${sheetFileName(k).padEnd(34)} ${what}`);
    }
    lines.push('', 'Assembly',
      '  1. Cut every sheet. Islands and shoals fall out as loose pieces - keep them with their sheet.',
      '  2. Paint or stain (lighter = shallow, darker = deep looks great).',
      '  3. Glue each loose piece onto the NEXT sheet down - the blue score outline shows where.',
      '  4. Stack from the backing up, using pins through the corner holes to keep alignment.',
      '', 'Depth data: AWS Terrain Tiles / NOAA NCEI Great Lakes Bathymetry, or your uploaded data. Not for navigation.');
    return lines.join('\r\n');
  }

  async function downloadZip() {
    const zip = new JSZip();
    const n = sheetCount();
    for (let k = 0; k < n; k++) zip.file(sheetFileName(k), C.layerSVG(state.result, k, state.opts));
    zip.file(`${slug()}-all-sheets.svg`, C.combinedSVG(state.result, state.opts));
    zip.file('README.txt', readme());
    const blob = await zip.generateAsync({ type: 'blob' });
    download(`${slug()}-depth-map.zip`, blob, 'application/zip');
  }

  // ------------------------------------------------------------------ helpers
  function esc(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]); }

  // ------------------------------------------------------------------ wiring
  function wire() {
    loadSettings();

    document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(x => x.classList.toggle('active', x === t));
      document.querySelectorAll('.tabpane').forEach(p => p.classList.toggle('active', p.id === t.dataset.tab));
      if (t.dataset.tab === 'tab-map') { initMap(); setTimeout(() => state.map && state.map.invalidateSize(), 50); }
    }));
    document.querySelectorAll('.vtab').forEach(t => t.addEventListener('click', () => {
      document.querySelectorAll('.vtab').forEach(x => x.classList.toggle('active', x === t));
      state.view = t.dataset.view;
      if (state.result) render();
    }));
    document.querySelectorAll('.lake-btn').forEach(b => b.addEventListener('click', () =>
      b.dataset.lake === 'demo' ? demoLake() : loadPreset(b.dataset.lake)));
    $('mapLoad').addEventListener('click', loadFromMap);

    // file input + drag/drop
    $('fileInput').addEventListener('change', (e) => e.target.files[0] && readFile(e.target.files[0]));
    const drop = $('fileDrop');
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
    drop.addEventListener('drop', (e) => e.dataTransfer.files[0] && readFile(e.dataTransfer.files[0]));
    $('fileMeaning').addEventListener('change', () => { $('fileSurfaceRow').hidden = $('fileMeaning').value !== 'elevation'; });
    $('fileLoad').addEventListener('click', useFile);

    // unit conversion of size fields
    let lastUnits = $('units').value;
    $('units').addEventListener('change', () => {
      const f = MM[lastUnits] / MM[$('units').value];
      for (const id of ['width', 'height', 'margin', 'radius', 'thickness', 'holeDia']) {
        const el = $(id);
        if (el.value !== '') el.value = +(parseFloat(el.value) * f).toFixed(3);
        el.step = $('units').value === 'mm' ? (id === 'width' || id === 'height' ? 5 : 0.5) : (id === 'thickness' || id === 'holeDia' ? 0.01 : 0.125);
      }
      lastUnits = $('units').value;
      scheduleRegen();
    });

    const live = ['nLayers', 'spacing', 'depthUnit', 'nice', 'customDepths', 'backing', 'shape', 'width', 'height',
      'margin', 'radius', 'thickness', 'holeDia', 'smooth', 'minPiece', 'useTitle', 'useSubtitle', 'title', 'subtitle',
      'labels', 'guides', 'cutColor', 'scoreColor', 'strokeWidth', 'palette'];
    for (const id of live) {
      $(id).addEventListener('input', scheduleRegen);
      $(id).addEventListener('change', scheduleRegen);
    }
    $('resolution').addEventListener('change', saveSettings);

    $('dlZip').addEventListener('click', downloadZip);
    $('dlCombined').addEventListener('click', () => download(`${slug()}-all-sheets.svg`, C.combinedSVG(state.result, state.opts)));
    document.addEventListener('click', (e) => {
      const t = e.target.closest('[data-sheet]');
      if (t && state.result) { e.preventDefault(); downloadSheet(parseInt(t.dataset.sheet, 10)); }
    });

    let rt;
    window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => state.result && render(), 150); });
    regenerate();
  }

  wire();
})();
