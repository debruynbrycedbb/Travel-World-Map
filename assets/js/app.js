/* global d3 */
import { openStore } from './store.js';
import { createMap } from './map.js';
import { GitHubStore, loadConfig, saveConfig, clearConfig, guessRepo, DATA_PATH, UPLOAD_DIR, dataUrlToBase64 } from './github.js';

// ---------------------------------------------------------------- constants
const TYPES = {
  place: { label: 'Place to visit', plural: 'Places', one: 'place', many: 'places' },
  activity: { label: 'Thing to do', plural: 'Things to do', one: 'thing to do', many: 'things to do' },
  memory: { label: 'Worth remembering', plural: 'Memories', one: 'memory', many: 'memories' },
  inspiration: { label: 'Inspiration', plural: 'Inspiration', one: 'inspiration', many: 'inspiration' },
};
const TYPE_KEYS = Object.keys(TYPES);

// ---------------------------------------------------------------- helpers
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const fold = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); // accent-insensitive matching
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function fmtCoords(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return '';
  return `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lng).toFixed(4)}° ${lng >= 0 ? 'E' : 'W'}`;
}
function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}
function normalizeUrl(u) {
  u = String(u || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z0-9+.-]*:/i.test(u)) u = 'https://' + u;
  try { const p = new URL(u); return /^https?:$/.test(p.protocol) ? p.href : ''; } catch { return ''; }
}
function safeImageSrc(src) {
  if (/^data:image\//i.test(src)) return src;
  if (/^assets\/images\/[\w\-./% ]+$/i.test(src) && !src.includes('..')) return src; // photos shipped with the site
  return normalizeUrl(src);
}
// Accepts "41.3874, 2.1686", "41.3874 2.1686" or a Google / Apple / OpenStreetMap link.
function parseCoords(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const pats = [
    /@(-?\d{1,2}(?:\.\d+)?),\s*(-?\d{1,3}(?:\.\d+)?)/,          // google .../@lat,lng,15z
    /!3d(-?\d{1,2}(?:\.\d+)?)!4d(-?\d{1,3}(?:\.\d+)?)/,          // google place data
    /[?&](?:q|query|ll|sll|daddr|destination)=(-?\d{1,2}(?:\.\d+)?)(?:,|%2C)\s*(-?\d{1,3}(?:\.\d+)?)/i,
    /[?&]mlat=(-?\d{1,2}(?:\.\d+)?)&mlon=(-?\d{1,3}(?:\.\d+)?)/,   // openstreetmap
    /#map=\d+\/(-?\d{1,2}(?:\.\d+)?)\/(-?\d{1,3}(?:\.\d+)?)/,      // openstreetmap
    /^(-?\d{1,2}(?:\.\d+)?)\s*[,;\s]\s*(-?\d{1,3}(?:\.\d+)?)$/,     // plain "lat, lng"
  ];
  for (const p of pats) {
    const m = t.match(p);
    if (m) {
      const lat = +m[1], lng = +m[2];
      if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat: Math.round(lat * 1e5) / 1e5, lng: Math.round(lng * 1e5) / 1e5 };
    }
  }
  return undefined; // text present but not understood
}
function titleFromUrl(url) {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean).reverse();
    for (const s of segs) {
      const clean = decodeURIComponent(s).replace(/\.[a-z0-9]{2,5}$/i, '');
      if (/[a-z]{3,}[-_+ ][a-z]{2,}/i.test(clean) && !/^[0-9a-f-]{16,}$/i.test(clean)) {
        const words = clean.replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
        return words.charAt(0).toUpperCase() + words.slice(1);
      }
    }
    return `Saved from ${domainOf(url)}`;
  } catch { return 'Saved link'; }
}
function hueFromId(id) {
  let h = 0; for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return 238 + (h % 58);
}
function placeholderStyle(e) {
  const h = hueFromId(e.id);
  return `background: radial-gradient(120% 90% at 20% 10%, hsl(${h} 55% 30% / .9), transparent 60%), linear-gradient(140deg, hsl(${h + 14} 45% 16%), hsl(${h - 10} 50% 8%));`;
}
function compressImage(file, max = 1600, quality = 0.84) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Not an image'));
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(c.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------- state
const state = {
  gh: null,             // GitHubStore when this device is connected
  legacy: [],           // entries found in this browser's old local storage
  legacyStore: null,
  entries: new Map(),
  meta: {},
  map: null,
  mapTypes: new Set(TYPE_KEYS),
  view: 'map',          // 'map' | 'country' | 'library'
  country: null,
  countryTab: 'all',
  countryTag: null,
  lib: { q: '', type: 'all', region: 'all', country: 'all', tag: 'all', sort: 'new' },
  editor: null,         // { d, isNew, error }
  detail: null,         // { id, img }
};

const nameToKey = new Map();
const cca2ToKey = new Map();

function countryName(key) { return state.meta[key]?.name || 'Unknown'; }
function countryFlag(key) { return state.meta[key]?.flag || ''; }
function entriesArr() { return [...state.entries.values()]; }
function entriesIn(key) { return entriesArr().filter(e => e.country === key); }
function allTags() {
  const counts = new Map();
  entriesArr().forEach(e => (e.tags || []).forEach(t => counts.set(t, (counts.get(t) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------- persistence (GitHub)
// With a GitHub connection every change is committed to the repository (see github.js).
// Without one the site is view-only and shows what is published on GitHub Pages.
const localPhotos = new Map(); // repo path -> data URL, so new photos show before GitHub serves them

function imgSrc(src) {
  if (localPhotos.has(src)) return localPhotos.get(src);
  if (state.gh && src.startsWith(UPLOAD_DIR)) return state.gh.rawUrl(src); // fresh uploads, before Pages rebuilds
  return src;
}
function requireConnection(then) {
  if (state.gh) return true;
  openConnect({ then });
  return false;
}
// Newly added photos (data URLs) become files in the repo
function photoFilesFor(e) {
  const files = {};
  e.images = (e.images || []).map(im => {
    if (!/^data:image\//.test(im.src)) return im;
    const path = `${UPLOAD_DIR}${e.id.replace(/[^\w-]/g, '').slice(0, 16)}-${Math.random().toString(36).slice(2, 8)}.jpg`;
    files[path] = dataUrlToBase64(im.src);
    localPhotos.set(path, im.src);
    return { src: path };
  });
  return files;
}
// Photos removed from an entry while editing are removed from the repo too
function removedPhotos(old, list) {
  const used = new Set(list.flatMap(e => (e.images || []).map(i => i.src)));
  const files = {};
  (old?.images || []).map(i => i.src).filter(src => src.startsWith('assets/images/') && !used.has(src)).forEach(src => { files[src] = null; });
  return files;
}
function applyRemote(list) {
  state.entries = new Map(list.map(sanitizeEntry).filter(Boolean).map(e => [e.id, e]));
}
async function persist(change, revert) {
  toast('Saving to GitHub…', null, { sticky: true });
  try {
    const list = await state.gh.commit(change);
    applyRemote(list); // also picks up changes made on other devices
    refreshAll();
    return true;
  } catch (err) {
    console.error(err);
    revert();
    refreshAll();
    toast(`Not saved. ${err.message || 'GitHub didn’t accept the change.'}`, null, { long: true });
    return false;
  }
}
async function saveEntry(e) {
  if (!requireConnection()) return false;
  e.updatedAt = Date.now();
  const prev = state.entries.get(e.id) || null;
  const files = photoFilesFor(e);
  state.entries.set(e.id, e);
  refreshAll();
  return persist(current => {
    const old = current.find(x => x.id === e.id);
    const list = old ? current.map(x => (x.id === e.id ? e : x)) : [...current, e];
    return { entries: list, files: { ...removedPhotos(old, list), ...files }, message: `${old ? 'Update' : 'Add'} “${e.title}”` };
  }, () => { if (prev) state.entries.set(e.id, prev); else state.entries.delete(e.id); });
}
async function deleteEntry(id) {
  const e = state.entries.get(id);
  if (!e || !requireConnection()) return;
  state.entries.delete(id);
  refreshAll();
  // photos stay in the repo so Undo can bring the entry back complete
  const ok = await persist(current => ({ entries: current.filter(x => x.id !== id), message: `Delete “${e.title}”` }),
    () => state.entries.set(id, e));
  if (ok) toast(`Deleted “${e.title}”`, { label: 'Undo', run: async () => { if (await saveEntry(e)) toast(`Restored “${e.title}”`); } });
}
async function putMany(list, message) {
  if (!requireConnection()) return false;
  const files = {};
  list.forEach(e => Object.assign(files, photoFilesFor(e)));
  const prev = new Map(state.entries);
  list.forEach(e => state.entries.set(e.id, e));
  refreshAll();
  return persist(current => {
    const m = new Map(current.map(x => [x.id, x]));
    list.forEach(e => m.set(e.id, e));
    return { entries: [...m.values()], files, message };
  }, () => { state.entries = prev; });
}

function sanitizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || !raw.title) return null;
  const type = TYPE_KEYS.includes(raw.type) ? raw.type : 'place';
  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);
  return {
    id: String(raw.id || uid()),
    type,
    title: String(raw.title).slice(0, 200),
    country: raw.country && state.meta[raw.country] ? String(raw.country) : null,
    location: String(raw.location || ''),
    lat: num(raw.lat), lng: num(raw.lng),
    notes: String(raw.notes || ''),
    tags: Array.isArray(raw.tags) ? [...new Set(raw.tags.map(t => String(t).trim().toLowerCase()).filter(Boolean))] : [],
    links: Array.isArray(raw.links) ? raw.links.map(l => ({ label: String(l.label || ''), url: normalizeUrl(l.url) })).filter(l => l.url) : [],
    images: Array.isArray(raw.images) ? raw.images.map(i => ({ src: safeImageSrc(i.src) })).filter(i => i.src) : [],
    createdAt: num(raw.createdAt) || Date.parse(raw.date || '') || Date.now(),
    updatedAt: num(raw.updatedAt) || Date.parse(raw.date || '') || Date.now(),
  };
}

// ---------------------------------------------------------------- refresh
function refreshAll() {
  refreshMap();
  if (state.view === 'country') renderCountry();
  if (state.view === 'library') renderLibrary();
  if (state.detail && $('#entry-dialog').open) {
    if (state.entries.has(state.detail.id)) renderDetail(); else $('#entry-dialog').close();
  }
}

function refreshMap() {
  const visible = entriesArr().filter(e => state.mapTypes.has(e.type));
  const counts = new Map();
  visible.forEach(e => { if (e.country) counts.set(e.country, (counts.get(e.country) || 0) + 1); });
  state.map.setSaved(counts);
  state.map.setMarkers(visible);
  renderMapFilters();
  $('#onboard').hidden = state.entries.size > 0 || state.view !== 'map';
}

function renderMapFilters() {
  const all = entriesArr();
  $('#map-filters').innerHTML = TYPE_KEYS.map(t => {
    const n = all.filter(e => e.type === t).length;
    return `<button type="button" class="chip t-${t}" data-type="${t}" aria-pressed="${state.mapTypes.has(t)}"><span class="dot"></span>${TYPES[t].plural}<span class="count">${n}</span></button>`;
  }).join('');
}

// ---------------------------------------------------------------- routing
function go(hash) {
  if (location.hash === hash) route(); else location.hash = hash;
}
function route() {
  const h = decodeURIComponent(location.hash.replace(/^#\/?/, ''));
  const [path, query = ''] = h.split('?');
  const parts = path.split('/').filter(Boolean);

  if (parts[0] === 'save') {
    const params = new URLSearchParams(query);
    history.replaceState(null, '', location.pathname + location.search + '#/');
    showMapView();
    openQuickSave({ url: params.get('url') || '', title: params.get('title') || '' });
    return;
  }
  if (parts[0] === 'country' && parts[1] && state.meta[parts[1]]) return showCountry(parts[1]);
  if (parts[0] === 'library') return showLibrary();
  showMapView();
}

function hideOverlays() {
  $('#country-panel').hidden = true;
  $('#library').hidden = true;
}
function showMapView() {
  const wasZoomed = state.view !== 'map';
  hideOverlays();
  state.view = 'map';
  state.country = null;
  state.map.setSelected(null);
  state.map.setInsets({ right: 0, bottom: 0 });
  if (wasZoomed) state.map.resetView();
  $('#onboard').hidden = state.entries.size > 0;
}
function showCountry(key) {
  const changed = state.country !== key;
  $('#library').hidden = true;
  state.view = 'country';
  state.country = key;
  if (changed) { state.countryTab = 'all'; state.countryTag = null; }
  $('#country-panel').hidden = false;
  $('#onboard').hidden = true;
  renderCountry();
  if (changed) $('#country-content').scrollTop = 0;
  state.map.setSelected(key);
  applyPanelInsets();
  state.map.zoomToCountry(key);
}
function showLibrary() {
  $('#country-panel').hidden = true;
  state.view = 'library';
  state.country = null;
  state.map.setSelected(null);
  $('#onboard').hidden = true;
  $('#library').hidden = false;
  renderLibrary();
}
function applyPanelInsets() {
  const panel = $('#country-panel');
  if (panel.hidden) { state.map.setInsets({ right: 0, bottom: 0 }); return; }
  const narrow = matchMedia('(max-width: 760px)').matches;
  const r = panel.getBoundingClientRect();
  state.map.setInsets(narrow ? { right: 0, bottom: r.height } : { right: r.width, bottom: 0 });
}

// ---------------------------------------------------------------- cards
function cardHTML(e, { showCountry = false } = {}) {
  const cover = e.images?.[0]?.src;
  const sub = [
    showCountry && e.country ? `${countryFlag(e.country)} ${countryName(e.country)}` : '',
    e.location,
    !e.location && e.links?.[0] ? domainOf(e.links[0].url) : '',
  ].filter(Boolean).join(' · ');
  const tags = (e.tags || []).slice(0, 3).map(t => `<span class="tag">#${esc(t)}</span>`).join('');
  return `<button type="button" class="card" data-entry="${esc(e.id)}">
    <div class="card-media" ${cover ? '' : `style="${placeholderStyle(e)}"`}>
      ${cover ? `<img src="${esc(imgSrc(cover))}" alt="" loading="lazy">` : `<div class="card-ph">${esc(fmtCoords(e.lat, e.lng) || (e.links?.[0] ? domainOf(e.links[0].url) : ''))}</div>`}
      <span class="card-type"><span class="dot t-${e.type}"></span>${TYPES[e.type].label}</span>
    </div>
    <div class="card-body">
      <span class="card-title">${esc(e.title)}</span>
      ${sub ? `<span class="card-sub">${esc(sub)}</span>` : ''}
      ${tags ? `<span class="card-tags">${tags}</span>` : ''}
    </div>
  </button>`;
}

// ---------------------------------------------------------------- country page
function renderCountry() {
  const key = state.country;
  const m = state.meta[key] || {};
  const list = entriesIn(key).sort((a, b) => b.updatedAt - a.updatedAt);
  const byType = Object.fromEntries(TYPE_KEYS.map(t => [t, list.filter(e => e.type === t)]));
  let shown = state.countryTab === 'all' ? list : byType[state.countryTab];
  const tagsHere = [...new Set(shown.flatMap(e => e.tags || []))].sort();
  if (state.countryTag && !tagsHere.includes(state.countryTag)) state.countryTag = null;
  if (state.countryTag) shown = shown.filter(e => e.tags?.includes(state.countryTag));

  const region = [m.region, m.subregion].filter(Boolean).join(' · ');
  const stats = TYPE_KEYS.filter(t => byType[t].length).map(t =>
    `<span class="stat"><span class="dot t-${t}"></span><b>${byType[t].length}</b> ${byType[t].length === 1 ? TYPES[t].one : TYPES[t].many}</span>`).join('');

  const tabs = [['all', 'All', list.length], ...TYPE_KEYS.map(t => [t, TYPES[t].plural, byType[t].length])]
    .filter(([t, , n]) => t === 'all' || n > 0)
    .map(([t, label, n]) => `<button type="button" data-tab="${t}" aria-pressed="${state.countryTab === t}">${label}<span class="count">${n}</span></button>`).join('');

  const addType = state.countryTab === 'all' ? 'place' : state.countryTab;
  const body = list.length === 0
    ? `<div class="empty"><strong>Nothing saved in ${esc(m.name)} yet</strong><p>Add a place to visit, something to do or something to remember.</p>
        <button type="button" class="pill-btn small pill-accent" data-add="place">Add to ${esc(m.name)}</button></div>`
    : shown.length === 0
      ? `<div class="empty"><p>No entries match this filter.</p></div>`
      : `<div class="cards">${shown.map(e => cardHTML(e)).join('')}</div>`;

  $('#country-content').innerHTML = `
    <div class="panel-head">
      <div class="panel-flag" aria-hidden="true">${m.flag || ''}</div>
      <div class="panel-title">
        ${region ? `<div class="eyebrow">${esc(region)}</div>` : ''}
        <h1 id="country-name">${esc(m.name)}</h1>
      </div>
      <button type="button" class="icon-btn small close-btn" data-close aria-label="Close ${esc(m.name)}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="panel-stats">${stats || '<span class="stat">Nothing saved yet</span>'}</div>
    ${list.length ? `<div class="panel-toolbar"><div class="seg" role="group" aria-label="Filter by type">${tabs}</div>
      <button type="button" class="pill-btn small pill-accent" data-add="${addType}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 4v12M4 10h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>Add</button></div>` : ''}
    ${tagsHere.length > 1 ? `<div class="tag-filter" role="group" aria-label="Filter by tag">${tagsHere.map(t => `<button type="button" class="tag" data-tag="${esc(t)}" aria-pressed="${state.countryTag === t}">#${esc(t)}</button>`).join('')}</div>` : ''}
    ${body}`;
}

// ---------------------------------------------------------------- library
function renderLibrary() {
  const f = state.lib;
  const all = entriesArr();
  const countriesWith = [...new Set(all.map(e => e.country).filter(Boolean))].sort((a, b) => countryName(a).localeCompare(countryName(b)));
  const regions = [...new Set(countriesWith.map(k => state.meta[k]?.region).filter(Boolean))].sort();
  const tags = allTags();

  const q = fold(f.q.trim());
  let list = all.filter(e => {
    if (f.type !== 'all' && e.type !== f.type) return false;
    if (f.country === 'none' ? e.country : (f.country !== 'all' && e.country !== f.country)) return false;
    if (f.region !== 'all' && state.meta[e.country]?.region !== f.region) return false;
    if (f.tag !== 'all' && !e.tags?.includes(f.tag)) return false;
    if (q) {
      const hay = fold([e.title, e.location, e.notes, ...(e.tags || []), e.country ? countryName(e.country) : '', ...(e.links || []).map(l => l.url + ' ' + l.label)].join(' '));
      if (!q.split(/\s+/).every(w => hay.includes(w))) return false;
    }
    return true;
  });
  const sorters = {
    new: (a, b) => b.createdAt - a.createdAt,
    old: (a, b) => a.createdAt - b.createdAt,
    updated: (a, b) => b.updatedAt - a.updatedAt,
    az: (a, b) => a.title.localeCompare(b.title),
    country: (a, b) => (a.country ? countryName(a.country) : '~').localeCompare(b.country ? countryName(b.country) : '~') || a.title.localeCompare(b.title),
  };
  list.sort(sorters[f.sort] || sorters.new);

  const opt = (v, label, cur) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(label)}</option>`;
  const base = location.origin + location.pathname;
  const bookmarklet = `javascript:(function(){window.open('${base}#/save?url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title))})();`;
  const filtered = list.length !== all.length;

  const wrapExisting = $('#library-content .library-wrap');
  const focusId = document.activeElement?.id;
  const selStart = document.activeElement?.selectionStart;

  $('#library-content').innerHTML = `
  <div class="library-wrap">
    <div class="lib-head">
      <div class="lib-head-left">
        <button type="button" class="icon-btn" data-close aria-label="Back to map">
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M12 4l-6 6 6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <h1 id="library-title">Library</h1>
      </div>
      <span class="sub">${filtered ? `${list.length} of ${all.length}` : `${all.length}`} saved</span>
    </div>

    <form class="quick-bar" id="lib-quick" autocomplete="off">
      <input class="field-input" id="lib-quick-url" type="text" inputmode="url" placeholder="Paste a link to save it: article, reel, TikTok, Google Maps…" aria-label="Link to save">
      <button type="submit" class="pill-btn small pill-accent">Save link</button>
      <button type="button" class="pill-btn small" data-new>Add with details</button>
      <span class="hint">Saved links go to Inspiration until you give them a country. Quick-save from any site: drag <a href="${esc(bookmarklet)}" onclick="return false" title="Drag to your bookmarks bar">＋ Save to map</a> to your bookmarks bar.</span>
    </form>

    <div class="lib-filters">
      <input class="field-input grow" id="lib-q" type="search" placeholder="Search titles, notes, tags, links" value="${esc(f.q)}" aria-label="Search library">
      <select class="field-input" id="lib-type" aria-label="Type">${opt('all', 'All types', f.type)}${TYPE_KEYS.map(t => opt(t, TYPES[t].plural, f.type)).join('')}</select>
      <select class="field-input" id="lib-region" aria-label="Region">${opt('all', 'All regions', f.region)}${regions.map(r => opt(r, r, f.region)).join('')}</select>
      <select class="field-input" id="lib-country" aria-label="Country">${opt('all', 'All countries', f.country)}${opt('none', 'No country yet', f.country)}${countriesWith.map(k => opt(k, `${countryFlag(k)} ${countryName(k)}`, f.country)).join('')}</select>
      <select class="field-input" id="lib-tag" aria-label="Tag">${opt('all', 'All tags', f.tag)}${tags.map(([t, n]) => opt(t, `#${t} (${n})`, f.tag)).join('')}</select>
      <select class="field-input" id="lib-sort" aria-label="Sort">${opt('new', 'Newest first', f.sort)}${opt('updated', 'Recently edited', f.sort)}${opt('old', 'Oldest first', f.sort)}${opt('az', 'A–Z', f.sort)}${opt('country', 'By country', f.sort)}</select>
      ${filtered ? '<button type="button" class="text-btn" data-reset-filters>Clear filters</button>' : ''}
    </div>

    ${all.length === 0
      ? `<div class="empty"><strong>Your library is empty</strong><p>Paste a link above, or open a country on the map and add a place.</p></div>`
      : list.length === 0
        ? `<div class="empty"><p>Nothing matches these filters.</p></div>`
        : `<div class="lib-grid">${list.map(e => cardHTML(e, { showCountry: true })).join('')}</div>`}
  </div>`;

  if (wrapExisting && focusId === 'lib-q') {
    const inp = $('#lib-q'); inp.focus();
    try { inp.setSelectionRange(selStart, selStart); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- entry detail
function openEntry(id) {
  if (!state.entries.has(id)) return;
  state.detail = { id, img: 0 };
  renderDetail();
  const dlg = $('#entry-dialog');
  if (!dlg.open) dlg.showModal();
  state.map.setActiveMarker(id);
}
function renderDetail() {
  const e = state.entries.get(state.detail.id);
  const imgs = e.images || [];
  const i = Math.min(state.detail.img, Math.max(0, imgs.length - 1));
  const coords = fmtCoords(e.lat, e.lng);
  const gallery = imgs.length ? `
    <div>
      <div class="gallery-main"><img src="${esc(imgSrc(imgs[i].src))}" alt="${esc(e.title)} photo ${i + 1} of ${imgs.length}"></div>
      ${imgs.length > 1 ? `<div class="gallery-thumbs">${imgs.map((im, n) => `<button type="button" data-img="${n}" aria-label="Show photo ${n + 1}" aria-current="${n === i}"><img src="${esc(imgSrc(im.src))}" alt=""></button>`).join('')}</div>` : ''}
    </div>` : '';
  const meta = [
    e.country ? `<button type="button" class="country-link" data-country="${esc(e.country)}">${countryFlag(e.country)} ${esc(countryName(e.country))}</button>` : '<span>No country yet</span>',
    e.location ? `<span>${esc(e.location)}</span>` : '',
    coords ? `<span class="coords">${coords}</span>` : '',
  ].filter(Boolean).join('');
  const links = (e.links || []).map(l => `<li><a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">
      <span class="ll-label">${esc(l.label || l.url)}</span><span class="ll-domain">${esc(domainOf(l.url))} ↗</span></a></li>`).join('');

  $('#entry-dialog').innerHTML = `
    <div class="dialog-head">
      <span class="tag t-${e.type}"><span class="dot t-${e.type}" style="width:7px;height:7px;border-radius:50%"></span>${TYPES[e.type].label}</span>
      <h2>${esc(e.title)}</h2>
      <button type="button" class="icon-btn small" data-dialog-close aria-label="Close">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="dialog-body">
      <div class="detail">
        ${gallery}
        <div class="detail-meta">${meta}</div>
        ${e.notes ? `<p class="notes">${esc(e.notes)}</p>` : ''}
        ${e.tags?.length ? `<div class="card-tags">${e.tags.map(t => `<button type="button" class="tag" data-lib-tag="${esc(t)}">#${esc(t)}</button>`).join('')}</div>` : ''}
        ${links ? `<div><p class="section-label">Links</p><ul class="link-list">${links}</ul></div>` : ''}
        ${e.example ? '<p class="field-hint">This is an example entry. Remove all examples from the ⋯ menu.</p>' : ''}
      </div>
    </div>
    <div class="dialog-foot">
      <button type="button" class="text-btn danger" data-delete>Delete</button>
      <span class="spacer"></span>
      ${coords ? '<button type="button" class="pill-btn" data-show-on-map>Show on map</button>' : ''}
      <button type="button" class="pill-btn pill-accent" data-edit>Edit</button>
    </div>`;
}

// ---------------------------------------------------------------- editor
function openEditor(entry = null, preset = {}) {
  if (!requireConnection(() => openEditor(entry, preset))) return;
  const d = entry ? structuredClone(entry) : {
    id: uid(), type: 'place', title: '', country: null, location: '', lat: null, lng: null,
    notes: '', tags: [], links: [], images: [], createdAt: Date.now(), updatedAt: Date.now(), ...preset,
  };
  d.tags = d.tags || []; d.links = d.links || []; d.images = d.images || [];
  state.editor = { d, isNew: !entry, error: '', geo: null };
  renderEditor();
  const dlg = $('#editor-dialog');
  if (!dlg.open) dlg.showModal();
  if (!entry) setTimeout(() => $('#ed-title')?.focus(), 30);
}

function renderEditor() {
  const { d, isNew, error } = state.editor;
  const typeBtns = TYPE_KEYS.map(t => `<button type="button" data-ed-type="${t}" aria-pressed="${d.type === t}"><span class="dot t-${t}"></span>${TYPES[t].label}</button>`).join('');
  $('#editor-dialog').innerHTML = `
    <form id="editor-form" novalidate style="display:contents">
    <div class="dialog-head">
      <h2>${isNew ? 'New entry' : 'Edit entry'}</h2>
      <button type="button" class="icon-btn small" data-dialog-close aria-label="Close without saving">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="dialog-body">
      <div class="form-grid">
        <div class="type-seg" role="group" aria-label="Type">${typeBtns}</div>
        <label class="field"><span class="field-label">Title</span>
          <input class="field-input" id="ed-title" value="${esc(d.title)}" placeholder="e.g. Sunrise hike up Mount Batur" maxlength="200"></label>
        <div class="row">
          <label class="field"><span class="field-label">Country</span>
            <input class="field-input" id="ed-country" list="country-list" value="${esc(d.country ? countryName(d.country) : (d._countryText || ''))}" placeholder="Start typing a country"></label>
          <label class="field"><span class="field-label">Place or area</span>
            <input class="field-input" id="ed-location" value="${esc(d.location)}" placeholder="e.g. Ubud, Bali"></label>
        </div>
        <div class="field">
          <label class="field-label" for="ed-coords">Map marker</label>
          <div class="row" style="align-items:center">
            <input class="field-input mono" id="ed-coords" style="flex:1 1 220px" value="${esc(typeof d.lat === 'number' ? `${d.lat}, ${d.lng}` : '')}" placeholder="lat, lng — or paste a Google Maps link">
            <button type="button" class="pill-btn small" data-geo-find>Find</button>
            <button type="button" class="pill-btn small" data-pick>Pick on map</button>
            ${typeof d.lat === 'number' ? '<button type="button" class="text-btn" data-clear-coords>Remove</button>' : ''}
          </div>
          <span class="field-hint" id="ed-coords-hint">${typeof d.lat === 'number' ? fmtCoords(d.lat, d.lng) : 'Optional. Adds a marker for this exact spot.'}</span>
          <div class="geo-results" id="ed-geo"></div>
        </div>
        <label class="field"><span class="field-label">Notes</span>
          <textarea class="field-input" id="ed-notes" placeholder="Why it’s worth it, best time to go, who recommended it…">${esc(d.notes)}</textarea></label>
        <div class="field">
          <span class="field-label">Tags</span>
          <div class="chip-input" id="ed-tags"></div>
          <div class="suggest" id="ed-tag-suggest"></div>
        </div>
        <div class="field">
          <span class="field-label">Links</span>
          <div class="links-list" id="ed-links"></div>
          <div><button type="button" class="text-btn" data-add-link>+ Add link</button></div>
        </div>
        <div class="field">
          <span class="field-label">Images</span>
          <div class="image-grid" id="ed-images"></div>
          <div class="row" style="align-items:center">
            <input class="field-input" id="ed-img-url" style="flex:1 1 220px" placeholder="Or paste an image address (https://…)">
            <button type="button" class="pill-btn small" data-add-img-url>Add image</button>
          </div>
          <span class="field-hint">Upload, drop or paste photos. They’re resized and stored in this browser.</span>
          <input type="file" id="ed-file" accept="image/*" multiple hidden>
        </div>
      </div>
    </div>
    <div class="dialog-foot">
      ${error ? `<span class="field-error" role="alert">${esc(error)}</span>` : ''}
      ${!isNew ? '<button type="button" class="text-btn danger" data-ed-delete>Delete</button>' : ''}
      <span class="spacer"></span>
      <button type="button" class="pill-btn" data-dialog-close>Cancel</button>
      <button type="submit" class="pill-btn pill-accent">${isNew ? 'Save' : 'Save changes'}</button>
    </div>
    </form>`;
  renderEdTags(); renderEdLinks(); renderEdImages(); renderGeo();
}

function renderEdTags() {
  const { d } = state.editor;
  const box = $('#ed-tags');
  box.innerHTML = d.tags.map((t, i) => `<span class="tag">#${esc(t)}<button type="button" class="x" data-rm-tag="${i}" aria-label="Remove tag ${esc(t)}">×</button></span>`).join('')
    + `<input id="ed-tag-input" placeholder="${d.tags.length ? '' : 'Add tags, press Enter'}" aria-label="Add tag">`;
  const sugg = allTags().map(([t]) => t).filter(t => !d.tags.includes(t)).slice(0, 10);
  $('#ed-tag-suggest').innerHTML = sugg.map(t => `<button type="button" class="tag" data-add-tag="${esc(t)}">+ ${esc(t)}</button>`).join('');
}
function addTag(raw) {
  const t = String(raw).trim().replace(/^#/, '').toLowerCase().slice(0, 30);
  const { d } = state.editor;
  if (t && !d.tags.includes(t)) d.tags.push(t);
  const inp = $('#ed-tag-input'); if (inp) inp.value = '';
  renderEdTags();
  $('#ed-tag-input').focus();
}
function renderEdLinks() {
  const { d } = state.editor;
  $('#ed-links').innerHTML = d.links.map((l, i) => `
    <div class="link-row">
      <input class="field-input lr-label" data-link-label="${i}" value="${esc(l.label)}" placeholder="Label (optional)" aria-label="Link ${i + 1} label">
      <input class="field-input" data-link-url="${i}" value="${esc(l.url)}" placeholder="https://…" inputmode="url" aria-label="Link ${i + 1} address">
      <button type="button" class="icon-btn small" data-rm-link="${i}" aria-label="Remove link ${i + 1}">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
    </div>`).join('');
}
function renderEdImages() {
  const { d } = state.editor;
  $('#ed-images').innerHTML = d.images.map((im, i) => `
    <div class="img-tile">
      <img src="${esc(imgSrc(im.src))}" alt="Image ${i + 1}">
      ${i === 0 ? '<span class="cover-badge">Cover</span>' : ''}
      <div class="img-actions">
        ${i > 0 ? `<button type="button" data-cover-img="${i}" aria-label="Use image ${i + 1} as cover" title="Use as cover">★</button>` : ''}
        <button type="button" data-rm-img="${i}" aria-label="Remove image ${i + 1}" title="Remove">×</button>
      </div>
    </div>`).join('') + `<button type="button" class="drop-zone" id="ed-drop">Upload or drop photos</button>`;
}
function renderGeo() {
  const g = state.editor.geo;
  const box = $('#ed-geo');
  if (!box) return;
  if (!g) { box.innerHTML = ''; return; }
  if (g.loading) { box.innerHTML = '<span class="field-hint">Searching…</span>'; return; }
  if (g.error) { box.innerHTML = `<span class="field-error">${esc(g.error)}</span>`; return; }
  box.innerHTML = g.results.map((r, i) => `<button type="button" data-geo-pick="${i}">${esc(r.display_name)}<span class="mono">${fmtCoords(+r.lat, +r.lon)}</span></button>`).join('');
}

function syncEditorFields() {
  const ed = state.editor; if (!ed) return;
  const d = ed.d;
  d.title = $('#ed-title').value.trim();
  d.location = $('#ed-location').value.trim();
  d.notes = $('#ed-notes').value;
  const ctext = $('#ed-country').value.trim();
  const ckey = nameToKey.get(ctext.toLowerCase());
  d.country = ckey || null;
  d._countryText = ckey ? '' : ctext;
  const pending = $('#ed-tag-input')?.value.trim();
  if (pending) { addTag(pending); }
}

function applyCoordsInput() {
  const ed = state.editor; const d = ed.d;
  const val = $('#ed-coords').value;
  const parsed = parseCoords(val);
  const hint = $('#ed-coords-hint');
  if (parsed === null) { d.lat = null; d.lng = null; hint.textContent = 'Optional. Adds a marker for this exact spot.'; hint.className = 'field-hint'; return true; }
  if (parsed === undefined) { hint.textContent = 'Couldn’t read coordinates. Use “lat, lng” like 41.3874, 2.1686, or paste a Google Maps link.'; hint.className = 'field-error'; return false; }
  d.lat = parsed.lat; d.lng = parsed.lng;
  $('#ed-coords').value = `${d.lat}, ${d.lng}`;
  hint.textContent = fmtCoords(d.lat, d.lng); hint.className = 'field-hint';
  const k = state.map.countryAt(d.lng, d.lat);
  const ctext = $('#ed-country').value.trim();
  if (!ctext) { if (k) $('#ed-country').value = countryName(k); }
  else if (k && nameToKey.get(ctext.toLowerCase()) !== k) {
    hint.textContent += ` · this spot is in ${countryName(k)}, not ${ctext}`;
  }
  return true;
}

async function geoFind() {
  syncEditorFields();
  const d = state.editor.d;
  const q = [d.location || d.title, d.country ? countryName(d.country) : d._countryText].filter(Boolean).join(', ');
  if (!q) { state.editor.geo = { error: 'Type a place name or title first.' }; renderGeo(); return; }
  state.editor.geo = { loading: true }; renderGeo();
  try {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 9000);
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&q=${encodeURIComponent(q)}`, { signal: ctrl.signal, headers: { 'Accept-Language': 'en' } });
    clearTimeout(t);
    if (!res.ok) throw new Error(res.status);
    const results = await res.json();
    state.editor.geo = results.length ? { results } : { error: `No match for “${q}”. Try a shorter name, or use Pick on map.` };
  } catch {
    state.editor.geo = { error: 'Place search isn’t reachable right now. Use Pick on map, or paste a Google Maps link.' };
  }
  renderGeo();
}

async function saveEditor() {
  syncEditorFields();
  if (!applyCoordsInput()) return;
  const ed = state.editor; const d = ed.d;
  const links = d.links.map(l => ({ label: l.label.trim(), url: normalizeUrl(l.url) }));
  const badLink = d.links.findIndex((l, i) => l.url.trim() && !links[i].url);
  if (badLink >= 0) { ed.error = `Link ${badLink + 1} isn’t a valid web address.`; return rerenderEditorKeepScroll(); }
  if (d._countryText) { ed.error = `“${d._countryText}” isn’t in the country list. Pick a suggestion or leave it blank.`; return rerenderEditorKeepScroll(); }
  if (!d.title) {
    const first = links.find(l => l.url);
    if (first) d.title = titleFromUrl(first.url);
    else { ed.error = 'Give it a title.'; rerenderEditorKeepScroll(); $('#ed-title').focus(); return; }
  }
  d.links = links.filter(l => l.url);
  delete d._countryText;
  const isNew = ed.isNew;
  $('#editor-dialog').close();
  state.editor = null;
  if (await saveEntry(d)) {
    toast(isNew ? `Saved “${d.title}”` : 'Changes saved', d.country && state.country !== d.country ? { label: `Open ${countryName(d.country)}`, run: () => go('#/country/' + d.country) } : null);
  }
}
function rerenderEditorKeepScroll() {
  const body = $('#editor-dialog .dialog-body');
  const top = body?.scrollTop || 0;
  renderEditor();
  $('#editor-dialog .dialog-body').scrollTop = top;
}

async function addImageFiles(files) {
  const list = [...files].filter(f => f.type.startsWith('image/'));
  if (!list.length) return;
  const ed = state.editor;
  for (const f of list) {
    if (f.size > 25 * 1024 * 1024) { toast(`${f.name} is over 25 MB, skipped.`); continue; }
    try { ed.d.images.push({ src: await compressImage(f) }); }
    catch { toast(`Couldn’t read ${f.name}.`); }
  }
  if (state.editor === ed) renderEdImages();
}

// ---- pick on map
let pickReturn = null;
function startPick() {
  syncEditorFields();
  applyCoordsInput();
  const d = state.editor.d;
  pickReturn = { editor: state.editor, panelHidden: $('#country-panel').hidden, libHidden: $('#library').hidden };
  $('#editor-dialog').close();
  $('#country-panel').hidden = true;
  $('#library').hidden = true;
  $('#pick-banner').hidden = false;
  const point = typeof d.lat === 'number' ? { lat: d.lat, lng: d.lng } : null;
  state.map.setInsets({ right: 0, bottom: 0 });
  state.map.setPickMode(true, point);
  if (point) state.map.focusPoint(point.lng, point.lat, 6);
  else if (d.country) state.map.zoomToCountry(d.country);
}
function endPick(result) {
  if (!pickReturn) return;
  const { editor, panelHidden, libHidden } = pickReturn;
  pickReturn = null;
  $('#pick-banner').hidden = true;
  state.map.setPickMode(false);
  $('#country-panel').hidden = panelHidden;
  $('#library').hidden = libHidden;
  applyPanelInsets();
  if (state.view === 'country' && state.country) state.map.zoomToCountry(state.country);
  else if (state.view === 'map') state.map.resetView();
  if (result) {
    editor.d.lat = result.lat; editor.d.lng = result.lng;
    if (!editor.d.country && !editor.d._countryText && result.country) editor.d.country = result.country;
  }
  state.editor = editor;
  renderEditor();
  $('#editor-dialog').showModal();
}

// ---------------------------------------------------------------- quick save
function openQuickSave(preset = {}) {
  if (!requireConnection(() => openQuickSave(preset))) return;
  const url = preset.url || '';
  const dlg = $('#quick-dialog');
  const qs = { type: preset.type || 'inspiration' };
  dlg._qs = qs;
  const typeBtns = () => TYPE_KEYS.map(t => `<button type="button" data-qs-type="${t}" aria-pressed="${qs.type === t}"><span class="dot t-${t}"></span>${TYPES[t].label}</button>`).join('');
  dlg.innerHTML = `
    <form id="quick-form" novalidate style="display:contents" autocomplete="off">
    <div class="dialog-head">
      <h2>Quick save</h2>
      <button type="button" class="icon-btn small" data-dialog-close aria-label="Close">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
      </button>
    </div>
    <div class="dialog-body"><div class="form-grid">
      <label class="field"><span class="field-label">Link</span>
        <input class="field-input" id="qs-url" type="text" inputmode="url" value="${esc(url)}" placeholder="Paste any link (optional)"></label>
      <label class="field"><span class="field-label">Title</span>
        <input class="field-input" id="qs-title" value="${esc(preset.title || '')}" placeholder="What is it?" maxlength="200"></label>
      <div class="type-seg" role="group" aria-label="Type" id="qs-types">${typeBtns()}</div>
      <div class="row">
        <label class="field"><span class="field-label">Country</span>
          <input class="field-input" id="qs-country" list="country-list" value="${esc(preset.country ? countryName(preset.country) : '')}" placeholder="Optional"></label>
        <label class="field"><span class="field-label">Tags</span>
          <input class="field-input" id="qs-tags" placeholder="food, hiking (comma separated)"></label>
      </div>
      <span class="field-error" id="qs-error" role="alert"></span>
    </div></div>
    <div class="dialog-foot">
      <button type="button" class="text-btn" data-qs-more>More details…</button>
      <span class="spacer"></span>
      <button type="button" class="pill-btn" data-dialog-close>Cancel</button>
      <button type="submit" class="pill-btn pill-accent">Save</button>
    </div>
    </form>`;
  dlg._typeBtns = typeBtns;
  if (!dlg.open) dlg.showModal();
  setTimeout(() => (url ? $('#qs-title') : $('#qs-url')).focus(), 30);
}
function readQuickSave() {
  const dlg = $('#quick-dialog');
  const rawUrl = $('#qs-url').value.trim();
  const url = normalizeUrl(rawUrl);
  const ctext = $('#qs-country').value.trim();
  const country = nameToKey.get(ctext.toLowerCase()) || null;
  const err = (m) => { $('#qs-error').textContent = m; return null; };
  if (rawUrl && !url) return err('That link isn’t a valid web address.');
  if (ctext && !country) return err(`“${ctext}” isn’t in the country list. Pick a suggestion or leave it blank.`);
  let title = $('#qs-title').value.trim();
  if (!title && !url) return err('Add a link or a title.');
  if (!title) title = titleFromUrl(url);
  const coords = rawUrl ? parseCoords(rawUrl) : null;
  return {
    id: uid(), type: dlg._qs.type, title, country: country || (coords ? state.map.countryAt(coords.lng, coords.lat) : null),
    location: '', lat: coords?.lat ?? null, lng: coords?.lng ?? null, notes: '',
    tags: [...new Set($('#qs-tags').value.split(',').map(t => t.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))],
    links: url ? [{ label: '', url }] : [], images: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
}

async function quickSaveUrl(raw) {
  if (!requireConnection()) return false;
  const url = normalizeUrl(raw);
  if (!url) { toast('That isn’t a valid web address.'); return false; }
  const coords = parseCoords(raw);
  const e = {
    id: uid(), type: 'inspiration', title: titleFromUrl(url),
    country: coords ? state.map.countryAt(coords.lng, coords.lat) : null,
    location: '', lat: coords?.lat ?? null, lng: coords?.lng ?? null, notes: '', tags: [],
    links: [{ label: '', url }], images: [], createdAt: Date.now(), updatedAt: Date.now(),
  };
  if (!(await saveEntry(e))) return false;
  toast(`Saved “${e.title}”`, { label: 'Edit', run: () => openEditor(state.entries.get(e.id)) });
  return true;
}

// ---------------------------------------------------------------- confirm + toast
function confirmDialog({ title, body, ok = 'Delete' }) {
  return new Promise(resolve => {
    const dlg = $('#confirm-dialog');
    dlg.innerHTML = `
      <div class="dialog-head"><h2>${esc(title)}</h2></div>
      <div class="dialog-body"><p style="margin:0;color:var(--muted)">${esc(body)}</p></div>
      <div class="dialog-foot">
        <button type="button" class="pill-btn" value="no">Cancel</button>
        <button type="button" class="pill-btn pill-accent" value="yes" style="background:#c9475a;border-color:#ff9aa8">${esc(ok)}</button>
      </div>`;
    const done = (v) => { dlg.close(); resolve(v); };
    dlg.onclick = (ev) => { const b = ev.target.closest('button'); if (b) done(b.value === 'yes'); };
    dlg.oncancel = () => resolve(false);
    dlg.showModal();
  });
}

let toastTimer;
function toast(msg, action = null, { sticky = false, long = false } = {}) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" class="text-btn">${esc(action.label)}</button>` : ''}`;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.run(); };
  el.hidden = false;
  // keep toast above any open modal dialog
  const openDlg = [...document.querySelectorAll('dialog[open]')].pop();
  if (openDlg && el.parentNode !== openDlg) openDlg.appendChild(el);
  else if (!openDlg && el.parentNode !== $('#app')) $('#app').appendChild(el);
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { el.hidden = true; }, action || long ? 7000 : 3200);
}

// ---------------------------------------------------------------- search
let searchItems = [];
let searchIndex = -1;
function runSearch() {
  const input = $('#search-input');
  const q = fold(input.value.trim());
  const box = $('#search-results');
  if (!q) { closeSearch(); return; }
  const counts = new Map();
  entriesArr().forEach(e => e.country && counts.set(e.country, (counts.get(e.country) || 0) + 1));

  const countries = Object.entries(state.meta)
    .filter(([, m]) => fold(m.name).includes(q))
    .sort((a, b) => (fold(a[1].name).startsWith(q) ? 0 : 1) - (fold(b[1].name).startsWith(q) ? 0 : 1) || (counts.get(b[0]) || 0) - (counts.get(a[0]) || 0) || a[1].name.localeCompare(b[1].name))
    .slice(0, 6);
  const words = q.split(/\s+/);
  const entries = entriesArr().filter(e => {
    const hay = fold([e.title, e.location, e.notes, ...(e.tags || []), e.country ? countryName(e.country) : ''].join(' '));
    return words.every(w => hay.includes(w));
  }).sort((a, b) => (fold(a.title).includes(q) ? 0 : 1) - (fold(b.title).includes(q) ? 0 : 1)).slice(0, 8);
  const tags = allTags().filter(([t]) => t.includes(q.replace(/^#/, ''))).slice(0, 4);

  searchItems = [];
  let html = '';
  if (countries.length) {
    html += '<div class="sr-group">Countries</div>';
    countries.forEach(([k, m]) => {
      const n = counts.get(k) || 0;
      searchItems.push({ kind: 'country', key: k });
      html += `<button type="button" class="sr-item" role="option" data-i="${searchItems.length - 1}"><span class="sr-flag">${m.flag || '·'}</span><span class="sr-text"><span class="sr-title">${esc(m.name)}</span><span class="sr-sub">${n ? `${n} saved` : esc(m.subregion || m.region || '')}</span></span></button>`;
    });
  }
  if (entries.length) {
    html += '<div class="sr-group">Saved</div>';
    entries.forEach(e => {
      searchItems.push({ kind: 'entry', id: e.id });
      html += `<button type="button" class="sr-item" role="option" data-i="${searchItems.length - 1}"><span class="sr-flag"><span class="dot t-${e.type}" style="display:inline-block;width:8px;height:8px;border-radius:50%"></span></span><span class="sr-text"><span class="sr-title">${esc(e.title)}</span><span class="sr-sub">${esc([TYPES[e.type].label, e.country ? countryName(e.country) : '', e.location].filter(Boolean).join(' · '))}</span></span></button>`;
    });
  }
  if (tags.length) {
    html += '<div class="sr-group">Tags</div>';
    tags.forEach(([t, n]) => {
      searchItems.push({ kind: 'tag', tag: t });
      html += `<button type="button" class="sr-item" role="option" data-i="${searchItems.length - 1}"><span class="sr-flag">#</span><span class="sr-text"><span class="sr-title">${esc(t)}</span><span class="sr-sub">${n} saved · open in library</span></span></button>`;
    });
  }
  box.innerHTML = html || `<div class="sr-empty">No countries or saved entries match “${esc(input.value.trim())}”.</div>`;
  box.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  searchIndex = searchItems.length ? 0 : -1;
  markSearch();
}
function markSearch() {
  $$('#search-results .sr-item').forEach((b, i) => b.setAttribute('aria-selected', String(i === searchIndex)));
  $(`#search-results .sr-item[data-i="${searchIndex}"]`)?.scrollIntoView({ block: 'nearest' });
}
function closeSearch() {
  $('#search-results').hidden = true;
  $('#search-input').setAttribute('aria-expanded', 'false');
}
function chooseSearch(i) {
  const it = searchItems[i];
  if (!it) return;
  $('#search-input').value = '';
  closeSearch();
  $('#search-input').blur();
  if (it.kind === 'country') go('#/country/' + it.key);
  else if (it.kind === 'entry') openEntry(it.id);
  else if (it.kind === 'tag') { state.lib = { ...state.lib, tag: it.tag, q: '' }; go('#/library'); }
}

// ---------------------------------------------------------------- backup
function exportBackup() {
  const data = { app: 'travel-world-map', version: 1, exportedAt: new Date().toISOString(), entries: entriesArr() };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `travel-map-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`Exported ${data.entries.length} entries`);
}
async function importBackup(file) {
  try {
    const data = JSON.parse(await file.text());
    const raw = Array.isArray(data) ? data : data.entries;
    if (!Array.isArray(raw)) throw new Error('no entries');
    const list = raw.map(sanitizeEntry).filter(Boolean);
    if (await putMany(list, `Import ${list.length} entries from a backup`)) toast(`Imported ${list.length} entr${list.length === 1 ? 'y' : 'ies'}`);
  } catch {
    toast('That file isn’t a Travel World Map backup.');
  }
}

// ---------------------------------------------------------------- events
function bindEvents() {
  const app = $('#app');

  // Map filter chips
  $('#map-filters').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-type]'); if (!b) return;
    const t = b.dataset.type;
    if (state.mapTypes.has(t)) state.mapTypes.delete(t); else state.mapTypes.add(t);
    refreshMap();
  });

  $('#zoom-in').onclick = () => state.map.zoomBy(1.8);
  $('#zoom-out').onclick = () => state.map.zoomBy(1 / 1.8);
  $('#zoom-reset').onclick = () => { if (state.country) state.map.zoomToCountry(state.country); else state.map.resetView(); };
  $('#btn-home').onclick = () => go('#/');
  $('#btn-library').onclick = () => go(state.view === 'library' ? '#/' : '#/library');
  $('#btn-quick-save').onclick = () => openQuickSave({ country: state.country || null, type: state.country ? 'place' : 'inspiration' });
  $('#pick-cancel').onclick = () => endPick(null);

  // Menu
  const menu = $('#menu'), menuBtn = $('#btn-menu');
  menuBtn.onclick = (ev) => { ev.stopPropagation(); menu.hidden = !menu.hidden; menuBtn.setAttribute('aria-expanded', String(!menu.hidden)); };
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.menu-wrap')) { menu.hidden = true; menuBtn.setAttribute('aria-expanded', 'false'); }
    if (!ev.target.closest('#search')) closeSearch();
  });
  menu.addEventListener('click', async (ev) => {
    const a = ev.target.closest('[data-action]')?.dataset.action; if (!a) return;
    menu.hidden = true;
    if (a === 'github') openConnect();
    if (a === 'export') exportBackup();
    if (a === 'import') { if (requireConnection(() => $('#import-file').click())) $('#import-file').click(); }
    if (a === 'upload-local') uploadLocalEntries();
  });
  $('#import-file').onchange = (ev) => { const f = ev.target.files[0]; if (f) importBackup(f); ev.target.value = ''; };

  $('#onboard').addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-onboard]')?.dataset.onboard;
    if (a === 'save') openQuickSave({ type: 'place' });
  });

  // Search
  const sInput = $('#search-input');
  sInput.addEventListener('input', debounce(runSearch, 80));
  sInput.addEventListener('focus', () => { if (sInput.value.trim()) runSearch(); });
  sInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown') { ev.preventDefault(); searchIndex = Math.min(searchItems.length - 1, searchIndex + 1); markSearch(); }
    else if (ev.key === 'ArrowUp') { ev.preventDefault(); searchIndex = Math.max(0, searchIndex - 1); markSearch(); }
    else if (ev.key === 'Enter') { ev.preventDefault(); chooseSearch(searchIndex); }
    else if (ev.key === 'Escape') { sInput.value = ''; closeSearch(); sInput.blur(); }
  });
  $('#search-results').addEventListener('click', (ev) => {
    const b = ev.target.closest('.sr-item'); if (b) chooseSearch(+b.dataset.i);
  });

  // Global keys
  document.addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if (ev.key === '/' && !typing && !document.querySelector('dialog[open]')) { ev.preventDefault(); sInput.focus(); }
    if (ev.key === 'Escape' && !document.querySelector('dialog[open]') && !typing) {
      if (pickReturn) endPick(null);
      else if (state.view !== 'map') go('#/');
    }
  });

  // Delegated clicks for panel, library and dialogs
  app.addEventListener('click', async (ev) => {
    const t = ev.target;
    const card = t.closest('[data-entry]');
    if (card) { openEntry(card.dataset.entry); return; }
    if (t.closest('[data-close]')) { go('#/'); return; }
    const tab = t.closest('[data-tab]');
    if (tab) { state.countryTab = tab.dataset.tab; state.countryTag = null; renderCountry(); return; }
    const tagBtn = t.closest('[data-tag]');
    if (tagBtn) { state.countryTag = state.countryTag === tagBtn.dataset.tag ? null : tagBtn.dataset.tag; renderCountry(); return; }
    const add = t.closest('[data-add]');
    if (add) { openEditor(null, { country: state.country, type: add.dataset.add }); return; }
    if (t.closest('[data-new]')) { openEditor(null, { type: 'inspiration' }); return; }
    if (t.closest('[data-reset-filters]')) { state.lib = { q: '', type: 'all', region: 'all', country: 'all', tag: 'all', sort: state.lib.sort }; renderLibrary(); return; }
  });

  // Library inputs
  $('#library').addEventListener('input', debounce((ev) => {
    if (ev.target.id === 'lib-q') { state.lib.q = ev.target.value; renderLibrary(); }
  }, 120));
  $('#library').addEventListener('change', (ev) => {
    const map = { 'lib-type': 'type', 'lib-region': 'region', 'lib-country': 'country', 'lib-tag': 'tag', 'lib-sort': 'sort' };
    const k = map[ev.target.id];
    if (k) { state.lib[k] = ev.target.value; renderLibrary(); }
  });
  $('#library').addEventListener('submit', async (ev) => {
    if (ev.target.id !== 'lib-quick') return;
    ev.preventDefault();
    const inp = $('#lib-quick-url');
    const v = inp.value.trim();
    if (!v) { inp.focus(); return; }
    if (await quickSaveUrl(v)) { $('#lib-quick-url').value = ''; $('#lib-quick-url').focus(); }
  });

  // Entry detail dialog
  const det = $('#entry-dialog');
  det.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (t === det || t.closest('[data-dialog-close]')) { det.close(); return; }
    const e = state.entries.get(state.detail?.id); if (!e) return;
    const img = t.closest('[data-img]');
    if (img) { state.detail.img = +img.dataset.img; renderDetail(); return; }
    if (t.closest('[data-edit]')) { det.close(); openEditor(e); return; }
    if (t.closest('[data-delete]')) {
      det.close();
      if (await confirmDialog({ title: 'Delete this entry?', body: `“${e.title}” and its photos will be removed.` })) deleteEntry(e.id);
      return;
    }
    const c = t.closest('[data-country]');
    if (c) { det.close(); go('#/country/' + c.dataset.country); return; }
    const tg = t.closest('[data-lib-tag]');
    if (tg) { det.close(); state.lib = { ...state.lib, tag: tg.dataset.libTag, q: '' }; go('#/library'); return; }
    if (t.closest('[data-show-on-map]')) {
      det.close();
      if (e.country) { go('#/country/' + e.country); setTimeout(() => state.map.focusPoint(e.lng, e.lat, 8), 800); }
      else { go('#/'); state.map.focusPoint(e.lng, e.lat, 8); }
      state.map.setActiveMarker(e.id);
    }
  });
  det.addEventListener('close', () => { state.map.setActiveMarker(null); });

  // Editor dialog
  const edd = $('#editor-dialog');
  edd.addEventListener('click', async (ev) => {
    const t = ev.target;
    if (!state.editor) return;
    const d = state.editor.d;
    if (t === edd || t.closest('[data-dialog-close]')) { edd.close(); return; }
    const tb = t.closest('[data-ed-type]');
    if (tb) { d.type = tb.dataset.edType; $$('[data-ed-type]', edd).forEach(b => b.setAttribute('aria-pressed', String(b === tb))); return; }
    const rt = t.closest('[data-rm-tag]');
    if (rt) { d.tags.splice(+rt.dataset.rmTag, 1); renderEdTags(); return; }
    const at = t.closest('[data-add-tag]');
    if (at) { addTag(at.dataset.addTag); return; }
    if (t.closest('[data-add-link]')) { d.links.push({ label: '', url: '' }); renderEdLinks(); $(`[data-link-url="${d.links.length - 1}"]`).focus(); return; }
    const rl = t.closest('[data-rm-link]');
    if (rl) { d.links.splice(+rl.dataset.rmLink, 1); renderEdLinks(); return; }
    const ri = t.closest('[data-rm-img]');
    if (ri) { d.images.splice(+ri.dataset.rmImg, 1); renderEdImages(); return; }
    const ci = t.closest('[data-cover-img]');
    if (ci) { const [im] = d.images.splice(+ci.dataset.coverImg, 1); d.images.unshift(im); renderEdImages(); return; }
    if (t.closest('#ed-drop')) { $('#ed-file').click(); return; }
    if (t.closest('[data-add-img-url]')) {
      const src = safeImageSrc($('#ed-img-url').value);
      if (!src) { toast('Paste a full image address starting with https://'); return; }
      d.images.push({ src }); $('#ed-img-url').value = ''; renderEdImages(); return;
    }
    if (t.closest('[data-pick]')) { startPick(); return; }
    if (t.closest('[data-geo-find]')) { geoFind(); return; }
    if (t.closest('[data-clear-coords]')) { syncEditorFields(); d.lat = null; d.lng = null; rerenderEditorKeepScroll(); return; }
    const gp = t.closest('[data-geo-pick]');
    if (gp) {
      syncEditorFields();
      const r = state.editor.geo.results[+gp.dataset.geoPick];
      d.lat = Math.round(+r.lat * 1e5) / 1e5; d.lng = Math.round(+r.lon * 1e5) / 1e5;
      if (!d.location) d.location = r.name || r.display_name.split(',')[0];
      const cc = r.address?.country_code?.toUpperCase();
      if (!d.country && cc && cca2ToKey.has(cc)) { d.country = cca2ToKey.get(cc); d._countryText = ''; }
      state.editor.geo = null;
      rerenderEditorKeepScroll();
      return;
    }
    if (t.closest('[data-ed-delete]')) {
      edd.close();
      const e = state.entries.get(d.id);
      if (e && await confirmDialog({ title: 'Delete this entry?', body: `“${e.title}” and its photos will be removed.` })) deleteEntry(e.id);
    }
  });
  edd.addEventListener('submit', (ev) => { ev.preventDefault(); saveEditor(); });
  edd.addEventListener('input', (ev) => {
    if (!state.editor) return;
    const d = state.editor.d;
    const t = ev.target;
    if (t.dataset.linkLabel !== undefined) d.links[+t.dataset.linkLabel].label = t.value;
    if (t.dataset.linkUrl !== undefined) d.links[+t.dataset.linkUrl].url = t.value;
  });
  edd.addEventListener('change', (ev) => {
    if (ev.target.id === 'ed-coords') applyCoordsInput();
    if (ev.target.id === 'ed-file') { addImageFiles(ev.target.files); ev.target.value = ''; }
  });
  edd.addEventListener('keydown', (ev) => {
    const t = ev.target;
    if (t.id === 'ed-tag-input') {
      if ((ev.key === 'Enter' || ev.key === ',') && t.value.trim()) { ev.preventDefault(); addTag(t.value); }
      else if (ev.key === 'Enter') ev.preventDefault();
      else if (ev.key === 'Backspace' && !t.value && state.editor.d.tags.length) { state.editor.d.tags.pop(); renderEdTags(); $('#ed-tag-input').focus(); }
    } else if (ev.key === 'Enter' && t.tagName === 'INPUT' && t.id !== 'ed-title') {
      ev.preventDefault(); // Enter in side fields shouldn't submit
      if (t.id === 'ed-coords') applyCoordsInput();
      if (t.id === 'ed-img-url') $('[data-add-img-url]').click();
    }
  });
  edd.addEventListener('focusout', (ev) => {
    const inp = ev.target;
    if (inp.id !== 'ed-tag-input' || !inp.value.trim() || !inp.isConnected) return;
    const v = inp.value.trim().replace(/^#/, '').toLowerCase().slice(0, 30);
    inp.value = '';
    setTimeout(() => {
      if (!state.editor || state.editor.d.tags.includes(v)) return;
      state.editor.d.tags.push(v);
      renderEdTags();
    }, 0);
  });
  edd.addEventListener('paste', (ev) => {
    const files = [...(ev.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
    if (files.length) { ev.preventDefault(); addImageFiles(files); }
  });
  edd.addEventListener('dragover', (ev) => { if (ev.dataTransfer?.types?.includes('Files')) { ev.preventDefault(); $('#ed-drop')?.classList.add('over'); } });
  edd.addEventListener('dragleave', (ev) => { if (!edd.contains(ev.relatedTarget)) $('#ed-drop')?.classList.remove('over'); });
  edd.addEventListener('drop', (ev) => {
    if (!ev.dataTransfer?.files?.length) return;
    ev.preventDefault(); $('#ed-drop')?.classList.remove('over');
    addImageFiles(ev.dataTransfer.files);
  });
  edd.addEventListener('close', () => { if (!pickReturn) state.editor = null; });

  // Quick-save dialog
  const qd = $('#quick-dialog');
  qd.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t === qd || t.closest('[data-dialog-close]')) { qd.close(); return; }
    const tb = t.closest('[data-qs-type]');
    if (tb) { qd._qs.type = tb.dataset.qsType; $('#qs-types').innerHTML = qd._typeBtns(); return; }
    if (t.closest('[data-qs-more]')) {
      const empty = ['#qs-url', '#qs-title', '#qs-country', '#qs-tags'].every(s => !$(s).value.trim());
      const e = empty ? null : readQuickSave();
      if (!empty && !e) return; // validation message is showing
      qd.close();
      openEditor(null, e || { type: qd._qs.type });
    }
  });
  qd.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const e = readQuickSave();
    if (!e) return;
    qd.close();
    if (await saveEntry(e)) toast(`Saved “${e.title}”`, { label: 'Edit', run: () => openEditor(state.entries.get(e.id)) });
  });
  qd.addEventListener('input', (ev) => {
    if (ev.target.id === 'qs-url') {
      const c = parseCoords(ev.target.value);
      if (c && !$('#qs-country').value.trim()) {
        const k = state.map.countryAt(c.lng, c.lat);
        if (k) $('#qs-country').value = countryName(k);
      }
    }
    $('#qs-error').textContent = '';
  });

  // GitHub connect dialog
  const gd = $('#github-dialog');
  gd.addEventListener('click', (ev) => {
    const t = ev.target;
    if (t === gd || t.closest('[data-dialog-close]')) { gd.close(); return; }
    if (t.closest('[data-gh-disconnect]')) { gd.close(); disconnectGitHub(); }
  });
  gd.addEventListener('submit', (ev) => { ev.preventDefault(); connectGitHub(); });
  gd.addEventListener('input', () => { const e = $('#gh-error'); if (e) e.textContent = ''; });

  window.addEventListener('hashchange', route);
  window.addEventListener('resize', debounce(() => {
    state.map.resize();
    applyPanelInsets();
    if (state.country) state.map.zoomToCountry(state.country);
  }, 150));
}

// ---------------------------------------------------------------- map callbacks
function tooltipAt(event, html) {
  const tip = $('#tooltip');
  if (!html) { tip.hidden = true; return; }
  tip.innerHTML = html;
  tip.hidden = false;
  const app = $('#app').getBoundingClientRect();
  const r = tip.getBoundingClientRect();
  let x = event.clientX - app.left + 14, y = event.clientY - app.top + 16;
  if (x + r.width > app.width - 8) x = event.clientX - app.left - r.width - 14;
  if (y + r.height > app.height - 8) y = event.clientY - app.top - r.height - 12;
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}

// ---------------------------------------------------------------- GitHub connection
function updateStorageNote() {
  const gh = state.gh;
  $('#storage-note').textContent = gh
    ? `Saving to GitHub: ${gh.owner}/${gh.repo}. Visitors see changes about a minute after you save.`
    : 'View only. Connect GitHub to save changes.';
  $('[data-action="github"]').textContent = gh ? 'Saving to GitHub ✓' : 'Connect GitHub to save…';
  $('[data-action="upload-local"]').hidden = !(gh && state.legacy.length);
  $('[data-action="upload-local"]').textContent = `Upload ${state.legacy.length} entr${state.legacy.length === 1 ? 'y' : 'ies'} saved only in this browser`;
}

function openConnect({ then = null } = {}) {
  const dlg = $('#github-dialog');
  dlg._then = then;
  const cfg = loadConfig() || {};
  const guess = guessRepo();
  const repoText = cfg.owner ? `${cfg.owner}/${cfg.repo}` : (guess.owner ? `${guess.owner}/${guess.repo}` : '');
  const repoName = (cfg.repo || guess.repo || 'your repository');
  const close = `<button type="button" class="icon-btn small" data-dialog-close aria-label="Close">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>`;
  if (state.gh) {
    const g = state.gh;
    dlg.innerHTML = `
      <div class="dialog-head"><h2>Saving to GitHub</h2>${close}</div>
      <div class="dialog-body"><div class="form-grid">
        <p class="prose">Every change is saved as a commit to <b>${esc(g.owner)}/${esc(g.repo)}</b> (branch <span class="mono">${esc(g.branch)}</span>) in <span class="mono">${esc(DATA_PATH)}</span>. Photos go in <span class="mono">${esc(UPLOAD_DIR)}</span>.</p>
        <p class="prose">Visitors see your changes about a minute after you save, once GitHub Pages has updated. You can see or undo any change in the repository’s commit history.</p>
      </div></div>
      <div class="dialog-foot">
        <button type="button" class="text-btn danger" data-gh-disconnect>Disconnect this device</button>
        <span class="spacer"></span>
        <button type="button" class="pill-btn pill-accent" data-dialog-close>Done</button>
      </div>`;
  } else {
    dlg.innerHTML = `
      <form id="gh-form" novalidate style="display:contents" autocomplete="off">
      <div class="dialog-head"><h2>Connect GitHub to save</h2>${close}</div>
      <div class="dialog-body"><div class="form-grid">
        <p class="prose">Entries are saved in your GitHub repository, so they’re the same on every device and anyone who opens the site sees them. Only the site’s owner can save. Connect once on each device you edit from.</p>
        <ol class="steps">
          <li>On GitHub, <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">create a fine-grained token ↗</a>. Give it a name and an expiry date.</li>
          <li>Under <b>Repository access</b>, choose <b>Only select repositories</b> and pick <b>${esc(repoName)}</b>.</li>
          <li>Under <b>Permissions</b>, add <b>Contents</b> and set it to <b>Read and write</b>.</li>
          <li>Click <b>Generate token</b>, copy it and paste it below.</li>
        </ol>
        <div class="row">
          <label class="field"><span class="field-label">Repository</span>
            <input class="field-input mono" id="gh-repo" value="${esc(repoText)}" placeholder="owner/repository" spellcheck="false"></label>
          <label class="field" style="flex:0 1 140px"><span class="field-label">Branch</span>
            <input class="field-input mono" id="gh-branch" value="${esc(cfg.branch || 'main')}" spellcheck="false"></label>
        </div>
        <label class="field"><span class="field-label">Access token</span>
          <input class="field-input mono" id="gh-token" type="password" placeholder="github_pat_…" spellcheck="false" autocomplete="off"></label>
        <span class="field-hint">The token is kept only in this browser. Anyone who has it can change this repository, so keep it private. You can revoke it on GitHub at any time.</span>
        <span class="field-error" id="gh-error" role="alert"></span>
      </div></div>
      <div class="dialog-foot">
        <span class="spacer"></span>
        <button type="button" class="pill-btn" data-dialog-close>Cancel</button>
        <button type="submit" class="pill-btn pill-accent" id="gh-submit">Connect</button>
      </div>
      </form>`;
  }
  if (!dlg.open) dlg.showModal();
  setTimeout(() => $('#gh-token')?.focus(), 30);
}

async function connectGitHub() {
  const dlg = $('#github-dialog');
  const err = (m) => { $('#gh-error').textContent = m; };
  const repoRaw = $('#gh-repo').value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  const [owner, repo] = repoRaw.split('/');
  const branch = $('#gh-branch').value.trim() || 'main';
  const token = $('#gh-token').value.trim();
  if (!owner || !repo) return err('Enter the repository as owner/repository, e.g. debruynbrycedbb/Travel-World-Map.');
  if (!token) return err('Paste the access token you created on GitHub.');
  const btn = $('#gh-submit'); btn.disabled = true; btn.textContent = 'Connecting…';
  const gh = new GitHubStore({ owner, repo, branch, token });
  try {
    const list = await gh.load();
    const stored = saveConfig({ owner, repo, branch, token });
    state.gh = gh;
    applyRemote(list);
    refreshAll();
    updateStorageNote();
    const then = dlg._then;
    dlg.close();
    toast(stored ? 'Connected. Changes now save to GitHub.' : 'Connected for this visit only: this browser blocks saving the token.', null, { long: !stored });
    then?.();
    offerLegacyUpload();
  } catch (e) {
    err(e.message || 'Couldn’t connect to GitHub.');
    btn.disabled = false; btn.textContent = 'Connect';
  }
}

async function disconnectGitHub() {
  const ok = await confirmDialog({ title: 'Disconnect this device?', body: 'The access token is removed from this browser and the site becomes view-only here. Your entries stay on GitHub.', ok: 'Disconnect' });
  if (!ok) return;
  clearConfig();
  state.gh = null;
  updateStorageNote();
  await loadPublished();
  refreshAll();
  toast('Disconnected. This browser is now view-only.');
}

// Entries saved in this browser by the earlier version of the site
async function findLegacyEntries() {
  try {
    const store = await openStore();
    if (store.kind !== 'indexeddb') return [];
    state.legacyStore = store;
    return (await store.all()).filter(e => !e.site && !e.example).map(sanitizeEntry).filter(Boolean);
  } catch { return []; }
}
function offerLegacyUpload() {
  const pending = state.legacy.filter(e => !state.entries.has(e.id));
  state.legacy = pending;
  updateStorageNote();
  if (state.gh && pending.length) {
    toast(`${pending.length} entr${pending.length === 1 ? 'y is' : 'ies are'} saved only in this browser`, { label: 'Upload to GitHub', run: uploadLocalEntries });
  }
}
async function uploadLocalEntries() {
  const list = state.legacy;
  if (!list.length || !requireConnection()) return;
  if (await putMany(list.map(e => ({ ...e })), `Add ${list.length} entries saved in a browser`)) {
    try { await Promise.all(list.map(e => state.legacyStore.remove(e.id))); } catch { /* ignore */ }
    state.legacy = [];
    updateStorageNote();
    toast(`Uploaded ${list.length} entr${list.length === 1 ? 'y' : 'ies'} to GitHub`);
  }
}

async function loadPublished() {
  try {
    const res = await fetch(DATA_PATH, { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    applyRemote(Array.isArray(data) ? data : (data.entries || []));
  } catch (err) {
    console.error(err);
    state.entries = new Map();
  }
}

// ---------------------------------------------------------------- boot
async function boot() {
  let topo, meta;
  try {
    [topo, meta] = await Promise.all([
      fetch('assets/data/countries-50m.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
      fetch('assets/data/countries-meta.json').then(r => { if (!r.ok) throw new Error(r.status); return r.json(); }),
    ]);
  } catch (err) {
    $('#map-loading').textContent = 'The map data didn’t load. If you opened index.html straight from your computer, serve the folder instead (see README).';
    console.error(err);
    return;
  }
  state.meta = meta;
  Object.entries(meta).forEach(([k, m]) => {
    nameToKey.set(m.name.toLowerCase(), k);
    if (m.cca2) cca2ToKey.set(m.cca2, k);
  });
  const dl = document.createElement('datalist');
  dl.id = 'country-list';
  dl.innerHTML = Object.values(meta).map(m => m.name).sort((a, b) => a.localeCompare(b)).map(n => `<option value="${esc(n)}"></option>`).join('');
  document.body.appendChild(dl);

  let bootError = null;
  const cfg = loadConfig();
  if (cfg) {
    const gh = new GitHubStore(cfg);
    try { applyRemote(await gh.load()); state.gh = gh; }
    catch (err) { bootError = err.message; }
  }
  if (!state.gh) await loadPublished();
  state.legacy = await findLegacyEntries();

  state.map = createMap({
    svgEl: $('#map'),
    canvasEl: $('#map-canvas'),
    topo,
    onCountryClick: (key) => go('#/country/' + key),
    onCountryHover: (key, event) => {
      if (!key) return tooltipAt(null, null);
      const n = entriesIn(key).length;
      tooltipAt(event, `${countryFlag(key)} ${esc(countryName(key))}${n ? `<span class="tt-sub">${n} saved</span>` : ''}`);
    },
    onMarkerClick: (id) => openEntry(id),
    onMarkerHover: (e, event) => {
      if (!e) return tooltipAt(null, null);
      tooltipAt(event, `${esc(e.title)}<span class="tt-sub">${TYPES[e.type].label}</span>`);
    },
    onPick: (res) => endPick(res),
  });
  // The map module's pick handler fires before endPick restores the editor.
  $('#map-loading').remove();
  state.map.resize();
  bindEvents();
  refreshMap();
  updateStorageNote();
  route();
  if (bootError) toast(`View only for now. ${bootError}`, { label: 'Reconnect', run: () => openConnect() }, { long: true });
  else offerLegacyUpload();
}

boot();
