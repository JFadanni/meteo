# Bucato — best day for laundry (Veneto)

A Progressive Web App that recommends the best day in the next 5 days to dry laundry outdoors. It combines:

- **ARPAV** (official Veneto forecast): zone meteograms (`bollettino_widget.xml`), the forecaster's reliability for each slot (`bollettino_bot.xml`) and the bulletin text (`bollettino_utenti.xml`). Open data under CC BY 4.0.
- **11 deterministic models** via Open-Meteo, weighted by lead time:
  - Kilometre-scale limited-area models, which carry most of the weight today and tomorrow: MeteoSwiss ICON-CH1 (1 km) and ICON-CH2 (2.1 km), ItaliaMeteo ICON-2I (2.2 km), DWD ICON-D2 (2.2 km), Météo-France AROME (2.5 km).
  - Global models, which carry most of the weight from day 3: ECMWF IFS HRES (9 km), ECMWF AIFS (AI model), ICON-EU, ARPEGE, UK Met Office, GFS.
- **5 ensemble systems, 143 members in total**: ICON-D2-EPS (20), ICON-CH1-EPS (11), ICON-CH2-EPS (21), ECMWF ENS (51), ICON-EU-EPS (40). The rain probability is computed for each system, then blended with lead-dependent weights.
- **Run-to-run consistency** via the Open-Meteo previous-runs API: today's forecast for D0–D2 is compared with the one issued 24 h earlier.

All of these sources send `Access-Control-Allow-Origin: *`, so the app is fully static.

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
- **Drying window:** from about 1.5 h after sunrise to just before sunset. For today, it starts from the current hour.
- **Drying rate:** the Penman combination equation for a saturated surface, written per m² of fabric with both faces evaporating: `λE = (Δ·Rn + 2·h_c·VPD)/(Δ+γ)`, multiplied by an efficiency η = 0.7 for crowding on the line.
  - *Wind:* `h_c = 2.8 + 3.0·u` W m⁻² K⁻¹ (Watmuff et al. 1977), with `u = 0.6·u10` (log profile, z0 ≈ 0.1 m) and a minimum of 0.3 m/s for free convection.
  - *Sun:* shortwave on a vertical sheet of random orientation is `DNI·cos(elev)·2/π + DIF + 0.2·GHI`, absorbed with a = 0.6. The sun elevation is derived from `(GHI−DIF)/DNI`. Low winter sun hits vertical laundry better than a horizontal surface; high summer sun hits it less.
  - *Longwave:* `0.95σT⁴(ε_sky−1)`, with `ε_sky = c + (1−c)·1.24(e_a/T)^(1/7)` (Brutsaert 1975, with cloud fraction c).
  - *Humidity:* enters through VPD. In addition, the last 25% of the water is in the hygroscopic (falling-rate) stage, where the rate is multiplied by `clamp((100−RH)/35, 0.1, 1)`.
- **Water to remove:** depends on the load type, per m² of fabric after the spin cycle: light 0.3, mixed 0.5, heavy 0.8 kg/m².
- **Rain chance:** the probability of ≥ 0.3 mm in the window.
  - The blend gives ARPAV a weight of 0.55, 0.45, 0.35 or 0.25 according to its *attendibilità* (ottima, buona, discreta, scarsa), plus 0.4 for the ensembles and 0.2 for the share of deterministic models showing rain.
  - Ensemble weights by lead time:
    - Today and tomorrow: D2 0.30, CH1 0.25, CH2 0.20, ECMWF 0.15, ICON-EU 0.10.
    - From day 3: ECMWF 0.50, CH2 0.25, ICON-EU 0.25.
- **Score:** `100 × dryFraction^0.8 × (1 − P)^1.3`, multiplied by 0.8 for gusts over 60 km/h and by 0.85 for fog or low stratus.
- **Confidence:** depends on how certain the rain signal is, the spread between models' drying estimates, the lead time, the forecast's change since 24 h earlier, and ARPAV's reliability.
- **Best day:** the highest score. An earlier day wins if two days are within 3 points.

## Files
| File | Purpose |
|---|---|
| `core.js` | All meteorology and scoring: sources and weights, drying physics, blending (pure functions, no DOM) |
| `app.js` | Data fetching, ARPAV XML parsing, UI |
| `index.html`, `style.css` | Page (mobile-first, light and dark mode) |
| `manifest.webmanifest`, `sw.js`, `icons/` | PWA install and offline shell |
