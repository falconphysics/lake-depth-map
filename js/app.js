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
    'useTitle', 'useSubtitle', 'labels', 'guides', 'cutColor', 'scoreColor', 'strokeWidth', 'palette', 'mapDetail'];

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
  /**
   * Download NOAA elevations and isolate the lake.
   * surfaces: candidate lake-surface values. The Great Lakes are stored as depth below
   * chart datum (surface 0) while most other places are height above sea level, so we
   * try each candidate and keep the one whose deepest point best matches what we expect.
   */
  async function loadFromTiles({ bbox, surfaces, seed, exclude, name, knownMaxDepth, strictSeed }) {
    if (state.busy) return;
    state.busy = true;
    try {
      status('Downloading NOAA depth data…', 0.15);
      const target = parseInt($('resolution').value, 10);
      const tile = await D.fetchNOAA(bbox, target, () => {});
      status('Finding the lake…', 0.9);
      await tick();
      const seedPx = seed ? tile.toPixel(seed[0], seed[1]) : null;
      let seedElev = null;
      if (seedPx) {
        const sx = Math.round(seedPx[0]), sy = Math.round(seedPx[1]);
        if (sx >= 0 && sy >= 0 && sx < tile.w && sy < tile.h) seedElev = tile.elev[sy * tile.w + sx];
      }
      const excl = D.excludeMask(tile, exclude);
      let best = null, sawFlat = false, sawHigh = false;
      for (const surface of surfaces) {
        if (!Number.isFinite(surface)) continue;
        const depth = new Float32Array(tile.w * tile.h);
        for (let i = 0; i < depth.length; i++) depth[i] = surface - tile.elev[i];
        const lake = C.isolateLake(depth, tile.w, tile.h, {
          mode: seedPx ? 'seed' : 'largest', seed: seedPx, strictSeed: !!strictSeed, excludeMask: excl, minDepth: 0.3
        });
        if (!lake.waterPixels) continue;
        if (strictSeed && lake.waterPixels > 0.85 * tile.w * tile.h) { sawHigh = true; continue; } // surface too high: land floods
        const vals = [];
        for (let i = 0; i < lake.depth.length; i++) if (lake.depth[i] > 0) vals.push(lake.depth[i]);
        vals.sort((a, b) => a - b);
        const pct = (q) => vals[Math.min(vals.length - 1, Math.floor(vals.length * q))];
        // A lake with only a water surface (no bathymetry) comes back nearly flat.
        if (pct(0.95) - pct(0.05) < 1 || lake.maxDepth < 1) { sawFlat = true; continue; }
        const p999 = pct(0.999) || lake.maxDepth; // robust max: one bad pixel can't skew it
        if (!knownMaxDepth) { best = { lake, p999 }; break; } // first valid surface wins (the user's)
        const score = Math.abs(Math.log(p999 / knownMaxDepth));
        if (!best || score < best.score) best = { lake, score, p999 };
      }
      if (!best) {
        const v = seedElev != null && Number.isFinite(seedElev) ? Math.round(seedElev * 10) / 10 : null;
        const at = v != null ? ` (NOAA reads ${v} m at your marker${sawFlat ? ' — just the water surface' : ''})` : '';
        status(sawHigh && !sawFlat
          ? `That surface elevation floods the land around the lake — check the number and the m/ft setting.`
          : sawFlat
          ? `NOAA has this lake's surface but not its depths${at}. Use Upload data with a depth map from your state DNR, or trace a depth chart as a grayscale image.`
          : `No lake-floor depths at your marker${at}. Make sure the marker is on the water and the surface elevation is right — or use Upload data.`, 0, true);
        return;
      }
      const lake = best.lake;
      // clip isolated spikes to the robust max so they don't distort the layer steps
      for (let i = 0; i < lake.depth.length; i++) if (lake.depth[i] > best.p999) lake.depth[i] = best.p999;
      lake.maxDepth = best.p999;
      lake.aspect = 1; // grid was requested with square (metre-wise) pixels
      lake.geo = cropGeo(tile.geo, lake);
      setLake(Object.assign(lake, { name, knownMaxDepth }));
      status('');
    } catch (e) {
      console.error(e);
      const blocked = e instanceof TypeError;
      status(blocked
        ? 'Couldn’t reach NOAA’s depth server. If you’re viewing this inside Claude, outside data is blocked there — it works on GitHub Pages. Otherwise try again in a minute; NOAA’s server is sometimes slow.'
        : 'Could not download depth data (' + (e.message || e) + '). Try again in a minute.', 0, true);
    } finally {
      state.busy = false;
    }
  }

  function loadPreset(key) {
    const p = C.PRESETS[key];
    document.querySelectorAll('.lake-btn').forEach(b => b.classList.toggle('active', b.dataset.lake === key));
    return loadFromTiles({ bbox: p.bbox, surfaces: [0, p.surface], seed: p.seed, exclude: p.exclude, name: p.name, knownMaxDepth: p.knownMaxDepth });
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

  /** Georeference of the cropped lake grid (pixel 0,0 in Web Mercator metres). */
  function cropGeo(geo, lake) {
    if (!geo) return null;
    return { mx0: geo.mx0 + (lake.offsetX || 0) * geo.mpp, my1: geo.my1 - (lake.offsetY || 0) * geo.mpp, mpp: geo.mpp };
  }

  // ------------------------------------------------------------------ map details (OpenStreetMap)
  const R_EARTH = 6378137;
  const DETAIL_NAMES = ['Off', 'Cities + freeways', '+ towns + US highways', '+ state highways', '+ villages'];
  function lonLatToGrid(geo, lon, lat) {
    const mx = R_EARTH * lon * Math.PI / 180, my = R_EARTH * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360));
    return [(mx - geo.mx0) / geo.mpp, (geo.my1 - my) / geo.mpp];
  }
  function gridToLonLat(geo, gx, gy) {
    const mx = geo.mx0 + gx * geo.mpp, my = geo.my1 - gy * geo.mpp;
    return [mx / R_EARTH * 180 / Math.PI, (2 * Math.atan(Math.exp(my / R_EARTH)) - Math.PI / 2) * 180 / Math.PI];
  }
  /** Lon/lat box covered by the whole panel, padded a little. */
  function panelLonLatBox(result, geo) {
    const L = result.layout, sx = L.aspect * L.scale, sy = L.scale;
    const a = gridToLonLat(geo, (0 - L.ox) / sx, (0 - L.oy) / sy);
    const b = gridToLonLat(geo, (L.W - L.ox) / sx, (L.H - L.oy) / sy);
    const padX = (b[0] - a[0]) * 0.05, padY = (a[1] - b[1]) * 0.05;
    return [a[0] - padX, b[1] - padY, b[0] + padX, a[1] + padY];
  }
  /** Map path for the top sheet from the bundled data, or null (and load it) if not ready. */
  function mapPathFor(result, o, detail) {
    const lake = state.lake;
    if (!detail || !lake.geo) return null;
    if (!state.mapData) {
      if (!state.mapDataLoading) {
        state.mapDataLoading = true;
        status('Loading map details…', 0.5);
        D.loadMapData().then(d => { state.mapData = d; status(''); regenerate(); })
          .catch(e => { console.error(e); status('Could not load the map details file (' + (e.message || e) + ').', 0, true); })
          .finally(() => { state.mapDataLoading = false; });
      }
      return null;
    }
    const need = panelLonLatBox(result, lake.geo);
    const db = state.mapData.bbox;
    state.mapOutside = need[2] < db[0] || need[0] > db[2] || need[3] < db[1] || need[1] > db[3];
    const key = lake.id + ':' + need.map(v => v.toFixed(3)).join(',');
    if (state.mapGridKey !== key) {
      const hit = (b) => b[2] >= need[0] && b[0] <= need[2] && b[3] >= need[1] && b[1] <= need[3];
      state.mapGrid = {
        roads: state.mapData.roads.filter(r => hit(r.bb)).map(r => ({ cls: r.cls, pts: r.pts.map(p => lonLatToGrid(lake.geo, p[0], p[1])) })),
        places: state.mapData.places.filter(p => p.lon >= need[0] && p.lon <= need[2] && p.lat >= need[1] && p.lat <= need[3])
          .map(p => { const g = lonLatToGrid(lake.geo, p.lon, p.lat); return Object.assign({ gx: g[0], gy: g[1] }, p); })
      };
      state.mapGridKey = key;
    }
    return C.mapOverlay(result, state.mapGrid, { detail, holeDia: o.holeDia, title: o.title, subtitle: o.subtitle });
  }

  let lakeCounter = 0;
  function setLake(lake) {
    lake.id = ++lakeCounter;
    state.lake = lake;
    if (lake.source !== 'dnr') $('useContours').hidden = true;
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

  /** Michigan inland lakes: build the lake floor from the DNR contour maps. Returns true if handled. */
  async function tryDNR(ll, bbox, typedName) {
    if (!window.LakeDNR || !LakeDNR.inMichigan(ll.lng, ll.lat)) return false;
    try {
      status('Checking Michigan DNR lake maps…', 0.1);
      const hit = await LakeDNR.findLakeAt(ll.lng, ll.lat, bbox);
      if (!hit || !hit.inside) return false;
      const target = parseInt($('resolution').value, 10);
      const g = await LakeDNR.loadLake(hit.key, target, (m) => status(m, 0.5));
      const lake = C.isolateLake(g.depth, g.w, g.h, { mode: 'all', minDepth: 0.001 });
      if (!lake.waterPixels) return false;
      lake.aspect = 1;
      lake.geo = cropGeo(g.geo, lake);
      const name = typedName || (g.name ? g.name : 'Lake');
      document.querySelectorAll('.lake-btn').forEach(x => x.classList.remove('active'));
      state.dnrLevels = g.levelsFt.filter(d => d > 0);
      setLake(Object.assign(lake, { name, knownMaxDepth: lake.maxDepth, source: 'dnr' }));
      $('useContours').hidden = !state.dnrLevels.length;
      status(`Built from ${state.dnrLevels.length + 1} Michigan DNR contours (0–${Math.max(0, ...state.dnrLevels)} ft).`, 1);
      return true;
    } catch (e) {
      console.warn('DNR lookup failed, falling back to NOAA', e);
      return false;
    }
  }

  async function loadFromMap() {
    if (!state.map) return;
    const typedName = $('mapName').value.trim();
    const name = typedName || 'Lake';
    let surface = parseFloat($('mapSurface').value);
    if (Number.isFinite(surface) && $('mapSurfaceUnit').value === 'ft') surface *= C.M_PER_FT;
    if (!state.marker) { status('Tap inside the lake on the map to drop a marker first.', 0, true); return; }
    const b = state.map.getBounds();
    const bbox = [b.getWest(), Math.max(-85, b.getSouth()), b.getEast(), Math.min(85, b.getNorth())];
    const ll = state.marker.getLatLng();
    if (state.busy) return;
    state.busy = true;
    let handled = false;
    try { handled = await tryDNR(ll, bbox, typedName); } finally { state.busy = false; }
    if (handled) return;
    document.querySelectorAll('.lake-btn').forEach(x => x.classList.remove('active'));
    loadFromTiles({ bbox, surfaces: Number.isFinite(surface) ? [surface, 0] : [0], seed: [ll.lng, ll.lat], name, strictSeed: true });
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
    $('mapDetailOut').textContent = DETAIL_NAMES[parseInt($('mapDetail').value, 10)];
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
    const detail = parseInt($('mapDetail').value, 10);
    o.mapPath = mapPathFor(state.result, o, detail);
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
    if (parseInt($('mapDetail').value, 10) && !lake.geo) warn += (warn ? ' ' : '') + 'Map details need a lake from the Great Lakes or Pick on map tabs.';
    else if (parseInt($('mapDetail').value, 10) && state.mapOutside) warn += (warn ? ' ' : '') + 'Map details cover the Great Lakes region only.';
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
    const mm = svg.match(/<g id="map"[^>]*>\s*<path d="([^"]*)"/);
    if (mm) {
      ctx.strokeStyle = s.palette === 'mono' ? '#666' : 'rgba(70, 40, 15, 0.65)';
      ctx.lineWidth = 0.35;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.stroke(new Path2D(mm[1]));
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
      '', 'Depth data: NOAA NCEI Great Lakes Bathymetry (DEM Global Mosaic), or your uploaded data. Not for navigation.');
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
    $('useContours').addEventListener('click', () => {
      if (!state.dnrLevels) return;
      $('depthUnit').value = 'ft';
      $('customDepths').value = state.dnrLevels.join(', ');
      scheduleRegen();
    });

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
      'labels', 'guides', 'cutColor', 'scoreColor', 'strokeWidth', 'palette', 'mapDetail'];
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
