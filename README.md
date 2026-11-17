# Bucato — best day for laundry (Veneto)

A Progressive Web App that recommends the best day in the next 5 days to dry laundry outdoors. It combines:

- **ARPAV** (official Veneto forecast): zone meteograms (`bollettino_widget.xml`) and bulletin text (`bollettino_utenti.xml`), open data under CC BY 4.0
- **Open-Meteo multimodel**: ItaliaMeteo ICON-2I, ECMWF IFS, DWD ICON, Météo-France, UK Met Office, NOAA GFS
- **Open-Meteo ensembles**: ECMWF ENS (51 members) and ICON-EU EPS (40 members), used for rain probability

All three sources send `Access-Control-Allow-Origin: *`, so the app is fully static. It needs no server, API key or build step.

## Run it on Android

### Option A: GitHub Pages (recommended)
1. On github.com, create a **public** repository, e.g. `bucato`.
2. Upload the *contents* of this folder (`index.html` must be at the top level, along with the `icons/` folder), either through *Add file → Upload files* or with `git push`.
3. Go to **Settings → Pages → Build and deployment**, set *Source: Deploy from a branch*, choose *Branch: main* and */ (root)*, then **Save**.
4. After about a minute the app is live at `https://<your-username>.github.io/bucato/`.
5. To update it, push or upload the changed files. Pages redeploys automatically, and the service worker fetches the new version when the app is next opened online.

### Install on the phone (Firefox for Android)
1. Open the GitHub Pages URL in Firefox.
2. Tap ⋮ → **Add to Home screen** (on newer versions it may say **Install**).
3. For GPS, allow location when Firefox asks. Also check that Android grants Firefox location access (*Settings → Apps → Firefox → Permissions*).

Chrome works too: ⋮ → *Install app*.

### Option B: on the phone itself with Termux
```sh
pkg install python
cd /sdcard/Download/bucato        # wherever you copied the folder
python -m http.server 8080
```
Open `http://localhost:8080` in Firefox and install it as above. `localhost` counts as a secure origin, so GPS works.

> Opening `index.html` directly as a `file://` URL also shows forecasts, but GPS and offline install won't work.

## How the score works
- **Drying window:** from about 1.5 h after sunrise (dew gone) to just before sunset. For today, it starts from the current hour.
- **Drying rate:** a Penman-type evaporation for a wet, hanging cloth, `E = W·Rn/λ + (1−W)·0.26(1+0.54u)·VPD`. It uses each model's temperature, VPD, wind (reduced to about 1.5 m height) and shortwave radiation, and is averaged across models with weights (ICON-2I 1.3, ECMWF 1.2, GFS 0.8, the others 1.0). A load counts as dry after about **1 mm** of evaporation (`DRY_TARGET` in `core.js`, an empirical value you can tune).
- **Rain chance:** the probability of ≥ 0.3 mm in the window, blended **40% ARPAV + 40% ensemble + 20% deterministic models**. ARPAV's "notte/mattina" slot is down-weighted (×0.8) because it includes the night. After the end of the ARPAV bulletin, only the models are used.
- **Score:** `100 × dryFraction^0.8 × (1 − P)^1.3`, multiplied by 0.8 for gusts over 60 km/h and by 0.85 for fog or low stratus (from the ARPAV sky text, or mean RH above 92%).
  - ≥ 70 and fully dry: *great*
  - ≥ 50: *good*. Shown as *"finish indoors"* if the load won't fully dry.
  - 30–49: *iffy*
  - < 30: *dry indoors*
- **Best day:** the highest score. An earlier day wins if two days are within 3 points.

The location is matched to the nearest of the 18 ARPAV zones. You can override the zone in the 📍 panel. Locations outside Veneto use the models only.

## Files
| File | Purpose |
|---|---|
| `core.js` | All meteorology and scoring (pure functions, no DOM) |
| `app.js` | Data fetching, ARPAV XML parsing, UI |
| `index.html`, `style.css` | Page (mobile-first, light and dark mode) |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA install and offline shell |
