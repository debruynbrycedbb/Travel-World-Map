/* global d3, topojson */
// Interactive world map: country shapes, glow on saved countries, destination markers,
// zoom / drag, zoom-to-country and a "pick a location" mode for the entry editor.

export function countryKey(geom) {
  return geom.id ? String(geom.id) : 'n-' + String(geom.properties.name).toLowerCase().replace(/[^a-z]+/g, '-');
}

export function createMap({ svgEl, topo, onCountryClick, onCountryHover, onMarkerClick, onMarkerHover, onPick }) {
  const svg = d3.select(svgEl);
  const all = topojson.feature(topo, topo.objects.countries).features;
  const features = all.filter(f => f.id !== '010'); // leave Antarctica off, like the reference
  features.forEach(f => { f.key = countryKey(f); });
  const byKey = new Map(features.map(f => [f.key, f]));

  let width = 0, height = 0;
  const projection = d3.geoMercator();
  const path = d3.geoPath(projection);
  let transform = d3.zoomIdentity;
  let picking = false;
  let selectedKey = null;
  let savedCounts = new Map();
  let markerData = [];
  let activeMarkerId = null;
  let pickPoint = null;
  let insets = { right: 0, bottom: 0 };

  // ---- SVG structure
  const defs = svg.append('defs');
  const glowFilter = defs.append('filter').attr('id', 'country-glow')
    .attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
  const glowBlur = glowFilter.append('feGaussianBlur').attr('stdDeviation', 6);

  const zoomLayer = svg.append('g').attr('class', 'zoom-layer');
  const gBase = zoomLayer.append('g').attr('class', 'countries-base');
  const gGlow = zoomLayer.append('g').attr('class', 'glow-layer').attr('filter', 'url(#country-glow)');
  const gSaved = zoomLayer.append('g').attr('class', 'countries-saved');
  const gMarkers = zoomLayer.append('g').attr('class', 'markers');
  const gPick = zoomLayer.append('g').attr('class', 'pick');

  const countryPaths = gBase.selectAll('path.country')
    .data(features, d => d.key)
    .join('path')
    .attr('class', 'country')
    .attr('id', d => 'c-' + d.key)
    .attr('data-key', d => d.key)
    .on('mousemove', (event, d) => { if (!picking) onCountryHover?.(d.key, event); })
    .on('mouseleave', () => onCountryHover?.(null))
    .on('click', (event, d) => {
      if (picking) return; // handled by svg click
      onCountryClick?.(d.key);
    });

  // ---- Zoom
  const zoom = d3.zoom()
    .scaleExtent([1, 60])
    .clickDistance(5)
    .on('zoom', (event) => {
      transform = event.transform;
      zoomLayer.attr('transform', transform);
      glowBlur.attr('stdDeviation', 5.5 / transform.k);
      updateMarkerScale();
    });
  svg.call(zoom).on('dblclick.zoom', null);

  svg.on('click.pick', (event) => {
    if (!picking) return;
    const [px, py] = d3.pointer(event, svgEl);
    const [x, y] = transform.invert([px, py]);
    const lngLat = projection.invert([x, y]);
    if (!lngLat || !isFinite(lngLat[0])) return;
    onPick?.({ lng: round(lngLat[0]), lat: round(lngLat[1]), country: countryAt(lngLat[0], lngLat[1]) });
  });

  function round(n) { return Math.round(n * 10000) / 10000; }

  // ---- Layout
  function resize() {
    const r = svgEl.getBoundingClientRect();
    width = Math.max(320, r.width);
    height = Math.max(320, r.height);
    svg.attr('viewBox', `0 0 ${width} ${height}`);
    // Fit to the inhabited band (about 56° S to 80° N) so the map fills the screen like a
    // wall map; the far Arctic islands run slightly past the edges.
    const padX = Math.min(40, width * 0.03);
    const padTop = Math.min(64, height * 0.08);
    const padBottom = Math.min(56, height * 0.07);
    const frame = { type: 'MultiPoint', coordinates: [[-168, -56], [179, -56], [-168, 80], [179, 80]] };
    projection.fitExtent([[padX, padTop], [width - padX, height - padBottom]], frame);
    countryPaths.attr('d', path);
    gGlow.selectAll('path').attr('d', d => path(d));
    const m = Math.max(width, height);
    zoom.extent([[0, 0], [width, height]])
      .translateExtent([[-m * 0.6, -m * 0.6], [width + m * 0.6, height + m * 0.6]]);
    renderMarkers();
    renderPick();
    homeTransform = computeHome();
    svg.call(zoom.transform, homeTransform);
  }

  // On tall phone screens the whole world is a thin strip, so start zoomed in a little
  // (centred on Europe / Africa) to use the height. Wide screens show the whole world.
  let homeTransform = d3.zoomIdentity;
  function computeHome() {
    const [[, y0], [, y1]] = path.bounds({ type: 'MultiPoint', coordinates: [[0, -56], [0, 80]] });
    const mapH = y1 - y0;
    const k = Math.min(2.4, Math.max(1, (height * 0.62) / mapH));
    if (k <= 1.05) return d3.zoomIdentity;
    const c = projection([12, 22]);
    return d3.zoomIdentity.translate(width / 2 - k * c[0], height / 2 - k * c[1]).scale(k);
  }

  // ---- Saved highlight
  function setSaved(counts) {
    savedCounts = counts;
    countryPaths.each(function (d) {
      const isSaved = (counts.get(d.key) || 0) > 0;
      this.classList.toggle('saved', isSaved);
      const target = isSaved ? gSaved.node() : gBase.node();
      if (this.parentNode !== target) target.appendChild(this);
    });
    gGlow.selectAll('path')
      .data(features.filter(f => (counts.get(f.key) || 0) > 0), d => d.key)
      .join('path')
      .attr('d', d => path(d));
    raiseSelected();
  }

  function setSelected(key) {
    selectedKey = key;
    countryPaths.classed('selected', d => d.key === key);
    raiseSelected();
  }
  function raiseSelected() {
    if (!selectedKey) return;
    const node = svgEl.querySelector('#c-' + CSS.escape(selectedKey));
    if (node) node.parentNode.appendChild(node);
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
          .on('mousemove', (event, d) => onMarkerHover?.(d, event))
          .on('mouseleave', () => onMarkerHover?.(null));
        g.append('circle').attr('class', 'm-halo').attr('r', 10);
        g.append('circle').attr('class', 'm-core').attr('r', 4.6);
        return g;
      });
    sel.attr('class', d => `marker t-${d.type}` + (d.id === activeMarkerId ? ' active' : ''))
      .attr('data-id', d => d.id)
      .attr('aria-label', d => d.title)
      .each(function (d) {
        const p = projection([d.lng, d.lat]);
        this.__xy = p;
      });
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
    // For countries with far-away territories (France, USA, Norway…) zoom to the main landmass
    // plus anything reasonably close to it.
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

  return {
    features, byKey, resize, setSaved, setSelected, setMarkers, setActiveMarker,
    setPickMode, showPickPoint, setInsets, zoomToCountry, focusPoint, resetView, zoomBy, countryAt,
    get isPicking() { return picking; },
  };
}
