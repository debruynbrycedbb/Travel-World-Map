# Travel World Map

A personal world map for places to visit, things to do and things worth remembering.
Click a country to open its page, save entries with photos, notes, tags and links, and
keep a library of inspiration you can filter and search.

It is a static site (HTML, CSS and JavaScript only), so it runs on GitHub Pages with no
server or build step.

## Features

- **World map**: every country with clear borders. Drag to pan, scroll or pinch to zoom,
  use the + / − / reset buttons. Countries with saved entries glow purple, and entries
  with coordinates show as coloured markers (one colour per type).
- **Country pages**: click a country (or search for it) to open its page with everything
  saved there, filterable by type and tag. The map zooms to the country beside the page.
- **Entries**: four types (Place to visit, Thing to do, Worth remembering, Inspiration),
  each with a title, country, place name, map marker, notes, tags, links and photos.
  - Set the marker by typing `lat, lng`, pasting a Google Maps / OpenStreetMap link,
    searching by name (**Find**), or clicking the exact spot (**Pick on map**).
  - Photos can be uploaded, dropped, pasted or added by image address. Uploads are
    resized to 1600 px so storage stays small. The first photo is the cover.
- **Library**: every entry in one grid. Paste a link and press Enter to save it instantly;
  links without a country stay in Inspiration until you assign one. Filter by type,
  region, country and tag; sort by date, name or country.
- **Quick save from any site**: in the Library, drag **＋ Save to map** to your bookmarks
  bar. Clicking it on any page opens this site with that page’s link and title filled in.
- **Search**: press `/` anywhere to search countries, saved entries and tags.
- **Storage and backups**: entries are saved in your browser (IndexedDB). Use
  **⋯ → Export backup** to download everything as JSON, and **Import backup** to restore
  it or move it to another browser or device.

## Publish on GitHub Pages

1. Push these files to the `main` branch of this repository.
2. On GitHub open **Settings → Pages**.
3. Under **Build and deployment**, set **Source** to *Deploy from a branch*, choose
   `main` and `/ (root)`, then **Save**.
4. After a minute the site is live at
   `https://debruynbrycedbb.github.io/Travel-World-Map/`.

## Run it on your computer

The map data is loaded with `fetch`, which browsers block for files opened directly
from disk. Serve the folder instead:

```bash
cd Travel-World-Map
python3 -m http.server 8000
# then open http://localhost:8000
```

## Where your data lives

Everything you save is stored in the browser you saved it in, on that device. It is not
uploaded anywhere and is not part of the repository, so the public site shows an empty
map to anyone else. Clearing site data for the page deletes it, so export a backup now
and then. To use the same collection on your phone and laptop, export on one and import
on the other.

## Entries published with the site

Entries in `assets/data/entries.json` (photos in `assets/images/<country>/`) show for
everyone who opens the site. On a visitor’s first visit each one is copied into their
browser, after which it behaves like any other entry: it can be edited or deleted, and a
deleted one does not come back. To change a published entry, edit it in `entries.json`
and raise its `rev` number; visitors who haven’t edited their copy get the update.

Each entry looks like this (`country` is the ISO 3166-1 numeric code, e.g. `724` Spain):

```json
{
  "id": "site-es-las-medulas", "type": "place", "title": "Las Médulas",
  "country": "724", "location": "León", "lat": 42.45889, "lng": -6.76,
  "notes": "", "tags": [], "links": [],
  "images": [{ "src": "assets/images/spain/las-medulas.jpg" }],
  "rev": 1, "date": "2026-10-25T13:00:00Z"
}
```

`type` is one of `place`, `activity`, `memory` or `inspiration`.

## Files

```
index.html                  page shell
assets/css/styles.css       all styling (dark theme, layout, responsive rules)
assets/js/app.js            routing, country pages, library, editor, search, backups
assets/js/map.js            D3 world map: zoom, highlights, markers, pick-on-map
assets/js/store.js          IndexedDB storage
assets/js/examples.js       optional example entries (⋯ → Load example entries)
assets/data/countries-50m.json   country borders (Natural Earth 1:50m, via world-atlas)
assets/data/countries-meta.json  names, flags and regions per country
assets/data/entries.json         entries published with the site (see above)
assets/images/                   photos for those entries
assets/vendor/              D3 v7 and topojson-client, included so no CDN is needed
```

## Credits

Country borders: [Natural Earth](https://www.naturalearthdata.com/) via
[world-atlas](https://github.com/topojson/world-atlas). Country names, flags and regions:
[world-countries](https://github.com/mledoze/countries). Map rendering:
[D3](https://d3js.org/). Place search uses
[OpenStreetMap Nominatim](https://nominatim.org/).
