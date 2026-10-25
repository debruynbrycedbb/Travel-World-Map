# Travel World Map

A personal world map for places to visit, things to do and things worth remembering.
Click a country to open its page, save entries with photos, notes, tags and links, and
keep a library of inspiration you can filter and search.

It is a static site (HTML, CSS and JavaScript only) hosted on GitHub Pages. Everything you
save is stored in this repository, so it is the same on every device and visible to anyone
who opens the site.

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
    resized to 1600 px. The first photo is the cover.
- **Library**: every entry in one grid. Paste a link and press Enter to save it instantly;
  links without a country stay in Inspiration until you assign one. Filter by type,
  region, country and tag; sort by date, name or country.
- **Quick save from any site**: in the Library, drag **＋ Save to map** to your bookmarks
  bar. Clicking it on any page opens this site with that page’s link and title filled in.
- **Search**: press `/` anywhere to search countries, saved entries and tags (accents
  don’t matter, so “medulas” finds Las Médulas).

## Saving (stored in this repository)

All entries live in `assets/data/entries.json`; uploaded photos go in
`assets/images/uploads/`. When you save, add, edit or delete on the site, it makes a commit
to this repository through the GitHub API. Visitors see the change about a minute later,
once GitHub Pages has rebuilt. Every change is in the commit history, so anything can be
looked up or restored.

Anyone can view the site. To edit, connect each device you use once:

1. On GitHub open **Settings → Developer settings → Personal access tokens →
   Fine-grained tokens → Generate new token**
   (direct link: <https://github.com/settings/personal-access-tokens/new>).
2. Give it a name and an expiry date.
3. **Repository access**: *Only select repositories* → `Travel-World-Map`.
4. **Permissions**: add **Contents** and set it to **Read and write**. Nothing else is needed.
5. Generate the token and copy it.
6. On the site, click **Save** (or **⋯ → Connect GitHub to save**), paste the token and
   click **Connect**.

The token is stored only in that browser. Anyone who has it can change this repository,
so keep it private. Revoke it on GitHub at any time; **⋯ → Saving to GitHub → Disconnect
this device** removes it from the browser.

If two devices save at the same moment, the second save is applied on top of the first,
so nothing is lost.

**⋯ → Export backup** downloads everything as JSON; **Import backup** commits a backup
file back into the repository.

## Publish on GitHub Pages

1. On GitHub open **Settings → Pages**.
2. Under **Build and deployment**, set **Source** to *Deploy from a branch*, choose
   `main` and `/ (root)`, then **Save**.
3. After a minute the site is live at
   `https://debruynbrycedbb.github.io/Travel-World-Map/`.

## Run it on your computer

The map data is loaded with `fetch`, which browsers block for files opened directly
from disk. Serve the folder instead:

```bash
cd Travel-World-Map
python3 -m http.server 8000
# then open http://localhost:8000
```

## Entry format

Each entry in `assets/data/entries.json` looks like this (`country` is the ISO 3166-1
numeric code, e.g. `724` Spain; `type` is `place`, `activity`, `memory` or `inspiration`):

```json
{
  "id": "site-es-las-medulas", "type": "place", "title": "Las Médulas",
  "country": "724", "location": "León", "lat": 42.45889, "lng": -6.76,
  "notes": "", "tags": [], "links": [],
  "images": [{ "src": "assets/images/spain/las-medulas.jpg" }],
  "createdAt": 1792933200000, "updatedAt": 1792933200000
}
```

## Files

```
index.html                       page shell
assets/css/styles.css            all styling (dark theme, layout, responsive rules)
assets/js/app.js                 routing, country pages, library, editor, search, backups
assets/js/map.js                 world map: canvas drawing, zoom, highlights, markers, pick-on-map
assets/js/github.js              saving: loads and commits entries through the GitHub API
assets/js/store.js               reads entries left in a browser by the earlier version
assets/data/entries.json         your entries
assets/data/countries-50m.json   country borders (Natural Earth 1:50m, via world-atlas)
assets/data/countries-meta.json  names, flags and regions per country
assets/images/                   photos
assets/vendor/                   D3 v7 and topojson-client, included so no CDN is needed
```

## Credits

Country borders: [Natural Earth](https://www.naturalearthdata.com/) via
[world-atlas](https://github.com/topojson/world-atlas). Country names, flags and regions:
[world-countries](https://github.com/mledoze/countries). Map rendering:
[D3](https://d3js.org/). Place search uses
[OpenStreetMap Nominatim](https://nominatim.org/).
