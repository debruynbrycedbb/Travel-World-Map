/* global d3, topojson */
// Interactive world map.
// Countries are drawn on a <canvas> (fast to redraw while dragging and zooming); markers and
// the pick dot live in an SVG layer on top, which also receives all mouse/touch input.
// Both layers are updated in the same animation frame so they never drift apart.

export function countryKey(geom) {
  return geom.id ? String(geom.id) : 'n-' + String(geom.properties.name).toLowerCase().replace(/[^a-z]+/g, '-');
}

// Map colours (match the tokens in styles.css)
const C = {
  land: '#17151f',
  landLine: '#353150',
  landHover: '#221e33',
  saved: '#6a4ee6',
  savedHover: '#7a5ff2',
  savedLine: '#a892ff',
  glow: 'rgba(124, 92, 255, 0.85)',
  selectedLine: '#e3dbff',
  selectedFill: '#2a2542',
};

export function createMap({ svgEl, canvasEl, topo, onCountryClick, onCountryHover, onMarkerClick, onMarkerHover, onPick }) {
  const svg = d3.select(svgEl);
  const ctx = canvasEl.getContext('2d');
  const hitCtx = document.createElement('canvas').getContext('2d');
  const all = topojson.feature(topo, topo.objects.countries).features;
  const features = all.filter(f => f.id !== '010'); // leave Antarctica off, like the reference
  features.forEach(f => { f.key = countryKey(f); });
  const byKey = new Map(features.map(f => [f.key, f]));

  let width = 0, height = 0, dpr = 1;
  const projection = d3.geoMercator();
  const path = d3.geoPath(projection);
  let transform = d3.zoomIdentity;
  let picking = false;
  let selectedKey = null;
  let hoverKey = null;
  let savedSet = new Set();
  let markerData = [];
  let activeMarkerId = null;
  let pickPoint = null;
  let insets = { right: 0, bottom: 0 };

  // Cached geometry in projected coordinates: one Path2D per country, plus merged paths
  // for "saved" and "not saved" so each layer is a single fill + stroke call.
  const shapes = new Map(); // key -> { p: Path2D, b: [[x0,y0],[x1,y1]] }
  let basePath = new Path2D();
  let savedPath = new Path2D();

  // ---- SVG overlay (markers + input)
  const zoomLayer = svg.append('g').attr('class', 'zoom-layer');
  const gMarkers = zoomLayer.append('g').attr('class', 'markers');
  const gPick = zoomLayer.append('g').attr('class', 'pick');

  // ---- Drawing
  // The full map is rendered into an off-screen "cache" canvas that is larger than the screen
  // (MARGIN on every side). Dragging just slides that bitmap, which costs almost nothing.
  // The cache is re-rendered when the view moves past its edge, when zoom changes a lot, or
  // shortly after zooming stops (so the borders are sharp again).
  const MARGIN = 0.3;
  const cache = document.createElement('canvas');
  const cctx = cache.getContext('2d');
  let cacheT = null;       // transform the cache was rendered at
  let cacheDirty = true;   // colours / hover / selection changed
  let sharpTimer = 0;
  let frame = 0;

  function requestDraw() {
    if (!frame) frame = requestAnimationFrame(draw);
  }
  function invalidate() { cacheDirty = true; requestDraw(); }

  function renderCache() {
    const mx = width * MARGIN, my = height * MARGIN;
    const cw = Math.round((width + 2 * mx) * dpr), ch = Math.round((height + 2 * my) * dpr);
    if (cache.width !== cw || cache.height !== ch) { cache.width = cw; cache.height = ch; }
    const { k, x, y } = transform;
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, cw, ch);
    cctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * (x + mx), dpr * (y + my));
    paintScene(cctx, k);
    cacheT = transform;
    cacheDirty = false;
  }

  function draw() {
    frame = 0;
    zoomLayer.attr('transform', transform);
    updateMarkerScale();

    const { k, x, y } = transform;
    let s = cacheT ? k / cacheT.k : 0;
    const mx = width * MARGIN, my = height * MARGIN;
    const placement = () => {
      // where the cache's top-left corner lands on screen (CSS px), and its drawn size
      const dx = x - s * (cacheT.x + mx), dy = y - s * (cacheT.y + my);
      return { dx, dy, dw: s * (width + 2 * mx), dh: s * (height + 2 * my) };
    };
    let pl = cacheT && placement();
    const covered = pl && pl.dx <= 0.5 && pl.dy <= 0.5 && pl.dx + pl.dw >= width - 0.5 && pl.dy + pl.dh >= height - 0.5;
    if (cacheDirty || !cacheT || !covered || s > 1.5 || s < 0.7) {
      renderCache(); s = 1; pl = placement();
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(cache, pl.dx * dpr, pl.dy * dpr, pl.dw * dpr, pl.dh * dpr);

    // hover highlight is drawn on top, so moving the pointer never re-renders the whole map
    const hs = hoverKey && shapes.get(hoverKey);
    if (hs && hoverKey !== selectedKey) {
      const saved = savedSet.has(hoverKey);
      ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * x, dpr * y);
      ctx.lineJoin = 'round';
      ctx.fillStyle = saved ? C.savedHover : C.landHover; ctx.fill(hs.p);
      ctx.strokeStyle = saved ? C.savedLine : C.landLine; ctx.lineWidth = (saved ? 0.8 : 0.6) / k; ctx.stroke(hs.p);
    }

    // after zooming, re-render at full sharpness once things settle
    clearTimeout(sharpTimer);
    if (Math.abs(s - 1) > 0.001) sharpTimer = setTimeout(invalidate, 140);
  }

  function paintScene(c, k) {
    c.lineJoin = 'round';
    c.fillStyle = C.land;
    c.fill(basePath);
    if (selectedKey && shapes.has(selectedKey) && !savedSet.has(selectedKey)) {
      c.fillStyle = C.selectedFill; c.fill(shapes.get(selectedKey).p);
    }
    c.strokeStyle = C.landLine;
    c.lineWidth = 0.6 / k;
    c.stroke(basePath);

    if (savedSet.size) {
      // glow: shadow blur is in screen pixels, so it looks the same at every zoom level
      c.save();
      c.shadowColor = C.glow;
      c.shadowBlur = 14 * dpr;
      c.fillStyle = C.saved;
      c.fill(savedPath);
      c.restore();
      c.strokeStyle = C.savedLine;
      c.lineWidth = 0.8 / k;
      c.stroke(savedPath);
    }
    if (selectedKey && shapes.has(selectedKey)) {
      c.strokeStyle = C.selectedLine;
      c.lineWidth = 1.4 / k;
      c.stroke(shapes.get(selectedKey).p);
    }
  }

  function rebuildGroups() {
    basePath = new Path2D();
    savedPath = new Path2D();
    for (const f of features) {
      const s = shapes.get(f.key);
      if (s) (savedSet.has(f.key) ? savedPath : basePath).addPath(s.p);
    }
  }

  // ---- Hit testing
  function keyAtPointer(event) {
    const [px, py] = d3.pointer(event, svgEl);
    const [x, y] = transform.invert([px, py]);
    for (const f of features) {
      const s = shapes.get(f.key);
      if (!s) continue;
      const [[x0, y0], [x1, y1]] = s.b;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (hitCtx.isPointInPath(s.p, x, y)) return f.key;
    }
    return null;
  }

  svg.on('pointermove.hover', (event) => {
    if (event.buttons || picking) return; // skip hit testing while dragging
    if (event.target.closest && event.target.closest('.marker')) return;
    const key = keyAtPointer(event);
    if (key !== hoverKey) { hoverKey = key; svgEl.style.cursor = key ? 'pointer' : ''; requestDraw(); }
    onCountryHover?.(key, event);
  });
  svg.on('pointerleave.hover', () => {
    if (hoverKey) { hoverKey = null; requestDraw(); }
    onCountryHover?.(null);
  });

  svg.on('click.map', (event) => {
    if (event.target.closest && event.target.closest('.marker')) return;
    if (picking) {
      const [px, py] = d3.pointer(event, svgEl);
      const [x, y] = transform.invert([px, py]);
      const lngLat = projection.invert([x, y]);
      if (!lngLat || !isFinite(lngLat[0])) return;
      onPick?.({ lng: round(lngLat[0]), lat: round(lngLat[1]), country: countryAt(lngLat[0], lngLat[1]) });
      return;
    }
    const key = keyAtPointer(event);
    if (key) onCountryClick?.(key);
  });

  function round(n) { return Math.round(n * 10000) / 10000; }

  // ---- Zoom
  const zoom = d3.zoom()
    .scaleExtent([1, 60])
    .clickDistance(5)
    .on('start', () => { if (hoverKey) { hoverKey = null; onCountryHover?.(null); } svgEl.classList.add('dragging'); })
    .on('zoom', (event) => { transform = event.transform; requestDraw(); })
    .on('end', () => svgEl.classList.remove('dragging'));
  svg.call(zoom).on('dblclick.zoom', null);

  // ---- Layout
  let homeTransform = d3.zoomIdentity;
  function resize() {
    const r = svgEl.getBoundingClientRect();
    width = Math.max(320, r.width);
    height = Math.max(320, r.height);
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasEl.width = Math.round(width * dpr);
    canvasEl.height = Math.round(height * dpr);
    svg.attr('viewBox', `0 0 ${width} ${height}`);

    // Fit to the inhabited band (about 56° S to 80° N) so the map fills the screen like a
    // wall map; the far Arctic islands run slightly past the edges.
    const padX = Math.min(40, width * 0.03);
    const padTop = Math.min(64, height * 0.08);
    const padBottom = Math.min(56, height * 0.07);
    const frameGeo = { type: 'MultiPoint', coordinates: [[-168, -56], [179, -56], [-168, 80], [179, 80]] };
    projection.fitExtent([[padX, padTop], [width - padX, height - padBottom]], frameGeo);

    shapes.clear();
    for (const f of features) {
      const d = path(f);
      if (d) shapes.set(f.key, { p: new Path2D(d), b: path.bounds(f) });
    }
    rebuildGroups();

    const m = Math.max(width, height);
    zoom.extent([[0, 0], [width, height]])
      .translateExtent([[-m * 0.6, -m * 0.6], [width + m * 0.6, height + m * 0.6]]);
    renderMarkers();
    renderPick();
    homeTransform = computeHome();
    svg.call(zoom.transform, homeTransform);
    invalidate();
  }

  // On tall phone screens the whole world is a thin strip, so start zoomed in a little
  // (centred on Europe / Africa) to use the height. Wide screens show the whole world.
  function computeHome() {
    const [[, y0], [, y1]] = path.bounds({ type: 'MultiPoint', coordinates: [[0, -56], [0, 80]] });
    const mapH = y1 - y0;
    const k = Math.min(2.4, Math.max(1, (height * 0.62) / mapH));
    if (k <= 1.05) return d3.zoomIdentity;
    const c = projection([12, 22]);
    return d3.zoomIdentity.translate(width / 2 - k * c[0], height / 2 - k * c[1]).scale(k);
  }

  // ---- Saved highlight / selection
  function setSaved(counts) {
    savedSet = new Set([...counts.entries()].filter(([, n]) => n > 0).map(([k]) => k));
    rebuildGroups();
    invalidate();
  }
  function setSelected(key) {
    selectedKey = key;
    invalidate();
  }

  // ---- Markers
  function setMarkers(entries) {
    markerData = entries.filter(e => typeof e.lat === 'number' && typeof e.lng === 'number');
    renderMarkers();
  }
  function setActiveMarker(id) {
    activeMarkerId = id;
    gMarkers.selectAll('g.marker').classed('active', d => d.id === id);
    if (id) {
      const n = gMarkers.select(`g.marker[data-id="${CSS.escape(id)}"]`).node();
      if (n) n.parentNode.appendChild(n);
    }
  }
  function renderMarkers() {
    if (!width) return;
    const sel = gMarkers.selectAll('g.marker')
      .data(markerData, d => d.id)
      .join(enter => {
        const g = enter.append('g')
          .attr('tabindex', 0)
          .attr('role', 'button')
          .on('click', (event, d) => { event.stopPropagation(); if (!picking) onMarkerClick?.(d.id); })
          .on('keydown', (event, d) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onMarkerClick?.(d.id); } })
          .on('pointermove', (event, d) => { if (!event.buttons) onMarkerHover?.(d, event); })
          .on('pointerleave', () => onMarkerHover?.(null));
        g.append('circle').attr('class', 'm-halo').attr('r', 10);
        g.append('circle').attr('class', 'm-core').attr('r', 4.6);
        return g;
      });
    sel.attr('class', d => `marker t-${d.type}` + (d.id === activeMarkerId ? ' active' : ''))
      .attr('data-id', d => d.id)
      .attr('aria-label', d => d.title)
      .each(function (d) { this.__xy = projection([d.lng, d.lat]); });
    updateMarkerScale();
  }
  function updateMarkerScale() {
    const s = 1 / Math.pow(transform.k, 0.92);
    gMarkers.selectAll('g.marker').attr('transform', function () {
      const p = this.__xy; return p ? `translate(${p[0]},${p[1]}) scale(${s})` : null;
    });
    gPick.selectAll('circle').attr('transform', function () {
      const p = this.__xy; return p ? `translate(${p[0]},${p[1]}) scale(${s})` : null;
    });
  }

  function renderPick() {
    const data = pickPoint ? [pickPoint] : [];
    gPick.selectAll('circle').data(data).join('circle')
      .attr('class', 'pick-dot').attr('r', 6)
      .each(function (d) { this.__xy = projection([d.lng, d.lat]); });
    updateMarkerScale();
  }

  function setPickMode(on, point = null) {
    picking = on;
    svg.classed('picking', on);
    if (on && hoverKey) { hoverKey = null; requestDraw(); }
    pickPoint = point;
    renderPick();
  }
  function showPickPoint(point) { pickPoint = point; renderPick(); }

  // ---- Zoom helpers
  function setInsets(next) { insets = { ...insets, ...next }; }

  function viewArea() {
    const top = Math.min(84, height * 0.12);
    return { x0: 0, y0: top, x1: width - insets.right, y1: height - insets.bottom };
  }

  function mainBounds(f) {
    // For countries with far-away territories (France, USA, Spain…) zoom to the main landmass
    // plus anything close to it.
    const g = f.geometry;
    if (!g || g.type !== 'MultiPolygon') return path.bounds(f);
    const polys = g.coordinates.map(c => ({ type: 'Polygon', coordinates: c }));
    let main = polys[0], best = -1;
    polys.forEach(p => { const a = d3.geoArea(p); if (a > best) { best = a; main = p; } });
    const mainC = d3.geoCentroid(main);
    const keep = polys.filter(p => p === main || d3.geoDistance(d3.geoCentroid(p), mainC) < 0.25);
    return path.bounds({ type: 'MultiPolygon', coordinates: keep.map(p => p.coordinates) });
  }

  function fitBounds([[x0, y0], [x1, y1]], { maxK = 14, duration = 750, pad = 48 } = {}) {
    const a = viewArea();
    const aw = Math.max(80, a.x1 - a.x0 - pad * 2);
    const ah = Math.max(80, a.y1 - a.y0 - pad * 2);
    const k = Math.max(1, Math.min(maxK, Math.min(aw / Math.max(1, x1 - x0), ah / Math.max(1, y1 - y0))));
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const tx = (a.x0 + a.x1) / 2 - k * cx;
    const ty = (a.y0 + a.y1) / 2 - k * cy;
    const t = d3.zoomIdentity.translate(tx, ty).scale(k);
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    svg.transition().duration(reduce ? 0 : duration).ease(d3.easeCubicInOut).call(zoom.transform, t);
  }

  function zoomToCountry(key) {
    const f = byKey.get(key);
    if (!f) return;
    fitBounds(mainBounds(f), { maxK: 16 });
  }

  function focusPoint(lng, lat, k = 7) {
    const p = projection([lng, lat]);
    if (!p) return;
    const span = 1 / k * Math.min(width, height) * 0.5;
    fitBounds([[p[0] - span, p[1] - span], [p[0] + span, p[1] + span]], { maxK: 40, pad: 0 });
  }

  function resetView() {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    svg.transition().duration(reduce ? 0 : 700).ease(d3.easeCubicInOut).call(zoom.transform, homeTransform);
  }
  function zoomBy(factor) {
    svg.transition().duration(280).call(zoom.scaleBy, factor);
  }

  function countryAt(lng, lat) {
    for (const f of features) {
      if (d3.geoContains(f, [lng, lat])) return f.key;
    }
    return null;
  }

  // Screen position of a country's centre (used by tests and future features)
  function screenPointOf(key) {
    const f = byKey.get(key); if (!f) return null;
    const [[x0, y0], [x1, y1]] = mainBounds(f);
    const s = shapes.get(key);
    // walk a small grid to find a point that is actually inside the shape
    for (let i = 0; i <= 12; i++) for (let j = 0; j <= 12; j++) {
      const ox = (i % 2 ? -1 : 1) * Math.ceil(i / 2) / 12, oy = (j % 2 ? -1 : 1) * Math.ceil(j / 2) / 12;
      const x = (x0 + x1) / 2 + ox * (x1 - x0), y = (y0 + y1) / 2 + oy * (y1 - y0);
      if (hitCtx.isPointInPath(s.p, x, y)) return transform.apply([x, y]);
    }
    return null;
  }

  return {
    features, byKey, resize, setSaved, setSelected, setMarkers, setActiveMarker,
    setPickMode, showPickPoint, setInsets, zoomToCountry, focusPoint, resetView, zoomBy, countryAt,
    screenPointOf,
    get isPicking() { return picking; },
  };
}
