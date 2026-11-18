// core.js — pure meteorological logic (no DOM). Loaded before app.js.
// Everything here is deterministic given the fetched data, so it can be reasoned about / tested.
'use strict';

const Core = (() => {
  const TZ = 'Europe/Rome';
  const DAYS = 5;

  // ---------------------------------------------------------------------------
  // SOURCES
  // Deterministic models. `w` = blending weight by lead day [oggi, +1, +2, +3, +4].
  // At D0–D1 the kilometre-scale limited-area models (LAM) dominate: they resolve the
  // Prealps/Euganei orography, Po-valley fog/low stratus, sea breeze and convection far
  // better than global models. From D+2 their advantage fades (and most stop) and the
  // ECMWF HRES/AIFS global forecasts become the reference.
  const MODELS = [
    { id: 'meteoswiss_icon_ch1',        name: 'MeteoSwiss ICON-CH1', res: '1 km',   w: [1.5, 1.5, 1.0, 1.0, 1.0] },
    { id: 'italia_meteo_arpae_icon_2i', name: 'ItaliaMeteo ICON-2I', res: '2,2 km', w: [1.5, 1.5, 1.2, 1.0, 1.0] },
    { id: 'icon_d2',                    name: 'DWD ICON-D2',         res: '2,2 km', w: [1.3, 1.3, 1.0, 1.0, 1.0] },
    { id: 'meteoswiss_icon_ch2',        name: 'MeteoSwiss ICON-CH2', res: '2,1 km', w: [1.3, 1.3, 1.0, 0.9, 0.9] },
    { id: 'meteofrance_arome_france',   name: 'Météo-France AROME',  res: '2,5 km', w: [1.2, 1.2, 1.0, 1.0, 1.0] },
    { id: 'ecmwf_ifs',                  name: 'ECMWF IFS HRES',      res: '9 km',   w: [1.2, 1.2, 1.5, 1.5, 1.5] },
    { id: 'ecmwf_aifs025_single',       name: 'ECMWF AIFS (IA)',     res: '28 km',  w: [0.6, 0.6, 1.0, 1.2, 1.2] },
    { id: 'icon_eu',                    name: 'DWD ICON-EU',         res: '7 km',   w: [0.8, 0.8, 1.0, 1.0, 1.0] },
    { id: 'meteofrance_arpege_europe',  name: 'Météo-France ARPEGE', res: '11 km',  w: [0.6, 0.6, 0.8, 0.8, 0.8] },
    { id: 'ukmo_seamless',              name: 'UK Met Office',       res: '10 km',  w: [0.7, 0.7, 1.0, 1.0, 1.0] },
    { id: 'gfs_seamless',               name: 'NOAA GFS',            res: '13 km',  w: [0.4, 0.4, 0.6, 0.7, 0.7] },
  ];
  // Models also queried 24 h earlier (Open-Meteo previous-runs) to measure run-to-run stability.
  const PREV_MODELS = ['italia_meteo_arpae_icon_2i', 'icon_d2', 'meteoswiss_icon_ch2', 'meteofrance_arome_france', 'ecmwf_ifs'];

  // Ensembles. Probabilities are computed per system and then blended with lead-dependent
  // weights (pooling members would let the biggest ensemble dominate regardless of skill).
  const ENSEMBLES = [
    { id: 'icon_d2',             name: 'ICON-D2-EPS',  w: [0.30, 0.30, 0.25, 0.25, 0.25] },
    { id: 'meteoswiss_icon_ch1', name: 'ICON-CH1-EPS', w: [0.25, 0.25, 0.20, 0.20, 0.20] },
    { id: 'meteoswiss_icon_ch2', name: 'ICON-CH2-EPS', w: [0.20, 0.20, 0.25, 0.25, 0.25] },
    { id: 'ecmwf_ifs025',        name: 'ECMWF ENS',    w: [0.15, 0.15, 0.50, 0.50, 0.50] },
    { id: 'icon_eu',             name: 'ICON-EU-EPS',  w: [0.10, 0.10, 0.25, 0.25, 0.25] },
  ];
  const ENS_MODELS = ENSEMBLES.map(e => e.id);

  const HOURLY_VARS = ['temperature_2m', 'relative_humidity_2m', 'vapour_pressure_deficit',
    'precipitation', 'wind_speed_10m', 'wind_gusts_10m', 'shortwave_radiation',
    'direct_normal_irradiance', 'diffuse_radiation', 'cloud_cover'];

  // ARPAV weight in the rain blend, from the forecaster's own reliability ("attendibilità").
  const ARPAV_W = { ottima: 0.55, buona: 0.45, discreta: 0.35, sufficiente: 0.30, scarsa: 0.25, bassa: 0.25 };
  const ENS_W = 0.4, DET_W = 0.2;

  // ---------------------------------------------------------------------------
  // THRESHOLDS AND LAUNDRY
  const RAIN_DAY_MM = 0.3;   // rain in the drying window that re-wets the laundry (sum, mm)
  const RAIN_HOUR_MM = 0.1;  // hourly "wet" threshold for the hourly strip
  // Water to evaporate per m² of exposed fabric after a 1000–1200 rpm spin, items hung
  // single or folded over the line (kg/m² = mm).
  const LOADS = {
    leggero: { label: 'Leggero', desc: 'magliette, camicie, intimo', target: 0.3 },
    misto:   { label: 'Misto',   desc: 'carico tipico',              target: 0.5 },
    pesante: { label: 'Pesante', desc: 'asciugamani, jeans, lenzuola', target: 0.8 },
  };
  const DRY_TARGET = LOADS.misto.target;
  const HYGRO_START = 0.75;  // fraction of water after which cotton enters the hygroscopic (falling-rate) stage

  // ARPAV forecast zones: approximate centroids used to pick the nearest zone.
  const ZONES = [
    { id: 1,  name: 'Dolomiti Nord-Est',            lat: 46.55, lon: 12.35 },
    { id: 2,  name: 'Dolomiti Sud-Ovest',           lat: 46.40, lon: 11.90 },
    { id: 3,  name: 'Belluno e Prealpi orientali',  lat: 46.14, lon: 12.22 },
    { id: 4,  name: 'Prealpi centrali',             lat: 45.97, lon: 11.80 },
    { id: 5,  name: 'Pedemontana orientale',        lat: 45.84, lon: 12.15 },
    { id: 6,  name: 'Treviso e pianura orientale',  lat: 45.67, lon: 12.25 },
    { id: 7,  name: 'Veneziano orientale',          lat: 45.72, lon: 12.78 },
    { id: 8,  name: 'Prealpi occidentali',          lat: 45.85, lon: 11.40 },
    { id: 9,  name: 'Vicenza e pedemontana',        lat: 45.60, lon: 11.55 },
    { id: 10, name: 'Padova e pianura centrale',    lat: 45.40, lon: 11.88 },
    { id: 11, name: 'Venezia e laguna',             lat: 45.46, lon: 12.25 },
    { id: 12, name: 'Delta del Po',                 lat: 44.98, lon: 12.30 },
    { id: 13, name: 'Rovigo e pianura meridionale', lat: 45.07, lon: 11.70 },
    { id: 14, name: 'Verona e pedemontana',         lat: 45.42, lon: 11.00 },
    { id: 15, name: 'Area del Garda',               lat: 45.58, lon: 10.72 },
    { id: 16, name: 'Litorale nord',                lat: 45.52, lon: 12.68 },
    { id: 17, name: 'Litorale centrale',            lat: 45.33, lon: 12.33 },
    { id: 18, name: 'Litorale sud',                 lat: 45.12, lon: 12.33 },
  ];

  function nearestZone(lat, lon) {
    const k = Math.cos(lat * Math.PI / 180);
    let best = ZONES[0], bd = Infinity;
    for (const z of ZONES) {
      const d = (z.lat - lat) ** 2 + ((z.lon - lon) * k) ** 2;
      if (d < bd) { bd = d; best = z; }
    }
    // > ~70 km from any centroid → outside Veneto, ARPAV not meaningful
    return { zone: best, distKm: Math.sqrt(bd) * 111 };
  }

  // ---- dates in Europe/Rome ----
  const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  function todayYMD(now = new Date()) { return ymdFmt.format(now); }
  function nowHourFloat(now = new Date()) {
    const [h, m] = hourFmt.format(now).split(':').map(Number);
    return (h % 24) + m / 60;
  }
  function addDays(ymd, n) {
    const [y, m, d] = ymd.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.toISOString().slice(0, 10);
  }
  const hourOf = iso => { const [h, m] = iso.slice(11, 16).split(':').map(Number); return h + m / 60; };

  // ---------------------------------------------------------------------------
  // PHYSICS — evaporation from wet fabric hanging vertically on a line.
  //
  // Penman combination equation for a saturated surface (no surface resistance),
  // written per m² of fabric with BOTH faces evaporating:
  //     λE = [ Δ·Rn + 2·h_c·VPD ] / (Δ + γ)
  //   Δ   slope of the saturation curve (kPa/K), γ psychrometric constant 0.066 kPa/K
  //   h_c convective heat-transfer coefficient per face, Watmuff et al. (1977):
  //       h_c = 2.8 + 3.0·u  (W m⁻² K⁻¹), u wind at line height (~1.5 m)
  //       u = 0.6·u10 (log profile, z0 ≈ 0.1 m: suburban garden/balcony), min 0.3 m/s (free convection)
  //   Rn  net radiation absorbed by the fabric (both faces):
  //       shortwave on a vertical sheet of random orientation:
  //         direct  = DNI·cos(elev)·2/π   (mean |cos azimuth| = 2/π; low winter sun favours vertical cloth)
  //         diffuse = DIF                 (each face sees half the sky)
  //         ground-reflected = 0.2·GHI
  //       absorbed with a_s = 0.6 (wet, mixed-colour fabric);
  //       longwave: each face sees half sky / half surroundings at air temperature:
  //         LWnet = 0.95·σT⁴·(ε_sky − 1), ε_sky = c + (1−c)·1.24·(e_a/T)^(1/7) (Brutsaert 1975, cloud c)
  //   η = 0.7 efficiency for crowding/shading between items on the line.
  // Returns mm/h (= kg m⁻² h⁻¹ of fabric).
  const SIGMA = 5.67e-8, ETA = 0.7, ABS_SW = 0.6, GROUND_ALB = 0.2;
  function dryingRate(o) {
    const { T, RH } = o;
    if (T == null || RH == null) return null;
    const es = 0.6108 * Math.exp(17.27 * T / (T + 237.3));          // kPa
    const vpd = o.vpd != null ? o.vpd : Math.max(0, es * (1 - RH / 100));
    const delta = 4098 * es / (T + 237.3) ** 2;                        // kPa/K
    const gamma = 0.066;
    const u = Math.max(0.3, ((o.wind ?? 5) / 3.6) * 0.6);
    const hc = 2.8 + 3.0 * Math.min(u, 10);

    // shortwave on the cloth
    const ghi = Math.max(0, o.ghi ?? 0);
    let sw;
    if (o.dni != null && o.dif != null) {
      const dni = Math.max(0, o.dni), dif = Math.max(0, o.dif);
      let sinEl = dni > 20 ? (ghi - dif) / dni : 0;
      sinEl = Math.min(1, Math.max(0, sinEl));
      const direct = dni > 20 ? dni * Math.sqrt(1 - sinEl * sinEl) * (2 / Math.PI) : 0;
      sw = direct + dif + GROUND_ALB * ghi;
    } else {
      sw = 1.1 * ghi;                                                   // fallback: typical cloth/horizontal ratio
    }
    // longwave
    const TK = T + 273.15, ea = es * RH / 100 * 10;                    // hPa
    const c = Math.min(1, Math.max(0, (o.cc ?? 50) / 100));
    const epsSky = c + (1 - c) * 1.24 * Math.pow(ea / TK, 1 / 7);
    const lw = 0.95 * SIGMA * TK ** 4 * (epsSky - 1);
    const Rn = ABS_SW * sw + lw;

    const lambda = 2.501e6 - 2361 * T;                                  // J/kg
    const LE = (delta * Rn + 2 * hc * vpd) / (delta + gamma);           // W/m²
    let E = Math.max(0, LE) / lambda * 3600 * ETA;
    if (T < 0) E *= 0.5;                                                // frozen fabric: slow sublimation
    return E;
  }
  // Hygroscopic stage: the last ~25% of water is bound in the cotton fibres; its vapour pressure
  // falls below saturation (sorption isotherm), so drying slows strongly in humid air.
  const hygroFactor = rh => Math.min(1, Math.max(0.1, (100 - (rh ?? 70)) / 35));

  // ---------------------------------------------------------------------------
  // PARSING Open-Meteo
  function indexByTime(times) { const m = new Map(); times.forEach((t, i) => m.set(t, i)); return m; }

  function parseDeterministic(json) {
    const h = json.hourly, idx = indexByTime(h.time);
    const models = MODELS.map(m => {
      const s = {};
      for (const v of HOURLY_VARS) s[v] = h[`${v}_${m.id}`] || null;
      return { ...m, s };
    }).filter(m => m.s.precipitation && m.s.precipitation.some(v => v != null));
    return { time: h.time, idx, models };
  }

  function parseEnsemble(json) {
    const h = json.hourly, idx = indexByTime(h.time);
    // longest id first so "meteoswiss_icon_ch1" is not mistaken for another system
    const ids = [...ENS_MODELS].sort((a, b) => b.length - a.length);
    const members = Object.keys(h).filter(k => k.startsWith('precipitation')).map(k => {
      const src = ids.find(id => k.endsWith(id) || k.includes(`_${id}_`) || k.includes(`${id}_ensemble`) || k.includes(`${id}_eps`)) || 'other';
      return { src, data: h[k] };
    });
    return { time: h.time, idx, members };
  }

  function parsePrevious(json) {
    const h = json.hourly, idx = indexByTime(h.time);
    const models = PREV_MODELS.map(id => ({ id, rain: h[`precipitation_previous_day1_${id}`] || null })).filter(m => m.rain);
    return { idx, models };
  }

  // ---- ARPAV rain probability and reliability for a date ----
  function arpavRainProb(entries) {
    if (!entries || !entries.length) return null;
    const p = t => { const e = entries.find(x => x.time === t); return e ? e.rainPerc / 100 : null; };
    const all = p('all'), am = p('am'), pm = p('pm');
    if (all != null) return all;
    // "am" = night/morning (includes the night, less relevant); "pm" = afternoon/evening
    const vals = [am != null ? 0.8 * am : null, pm].filter(v => v != null);
    return vals.length ? Math.max(...vals) : null;
  }
  function arpavWeight(entries) {
    const atts = (entries || []).map(e => (e.att || '').toLowerCase()).filter(Boolean);
    if (!atts.length) return { w: 0.4, att: null };
    // most conservative slot of the day
    let worst = atts[0];
    for (const a of atts) if ((ARPAV_W[a] ?? 0.4) < (ARPAV_W[worst] ?? 0.4)) worst = a;
    return { w: ARPAV_W[worst] ?? 0.4, att: worst };
  }

  // ---------------------------------------------------------------------------
  // MAIN per-day analysis
  function analyse({ det, ens, prev, sun, arpav, load = 'misto', now = new Date() }) {
    const today = todayYMD(now);
    const nowH = nowHourFloat(now);
    const target = (LOADS[load] || LOADS.misto).target;
    const days = [];

    for (let d = 0; d < DAYS; d++) {
      const date = addDays(today, d);
      const sIdx = sun ? sun.daily.time.indexOf(date) : -1;
      const sunrise = sIdx >= 0 ? hourOf(sun.daily.sunrise[sIdx]) : 7.5;
      const sunset = sIdx >= 0 ? hourOf(sun.daily.sunset[sIdx]) : 17;

      // Drying window: ~1.5 h after sunrise (dew gone) until ~15 min before sunset.
      let start = Math.round(sunrise + 1.5);
      const end = Math.floor(sunset - 0.25);
      let lateToday = false;
      if (d === 0) { const s = Math.ceil(nowH); if (s > start) start = s; }
      if (end - start < 3) lateToday = true;

      // Hour intervals [H, H+1) are represented by Open-Meteo time H+1 (precip/radiation are
      // sums/means over the preceding hour).
      const hours = [];
      for (let H = start; H < end; H++) hours.push({ H, key: `${date}T${String(H + 1).padStart(2, '0')}:00` });

      // --- deterministic multimodel ---
      const perModel = [];
      if (det && hours.length) {
        for (const m of det.models) {
          const rates = [], rain = [], gust = [], rh = [], temp = [];
          for (const { key } of hours) {
            const i = det.idx.get(key);
            const g = v => (i != null && m.s[v] ? m.s[v][i] : null);
            rates.push(dryingRate({
              T: g('temperature_2m'), RH: g('relative_humidity_2m'), vpd: g('vapour_pressure_deficit'),
              wind: g('wind_speed_10m'), ghi: g('shortwave_radiation'), dni: g('direct_normal_irradiance'),
              dif: g('diffuse_radiation'), cc: g('cloud_cover'),
            }));
            rain.push(g('precipitation')); gust.push(g('wind_gusts_10m')); rh.push(g('relative_humidity_2m'));
            temp.push(g('temperature_2m'));
          }
          const valid = rates.filter(r => r != null).length;
          const validRain = rain.filter(r => r != null).length;
          if (valid < 0.8 * hours.length || validRain < 0.8 * hours.length) continue; // model doesn't cover this day
          const rainSum = rain.reduce((a, b) => a + (b || 0), 0);
          const cum = rates.reduce((a, b) => a + (b || 0), 0) * hours.length / valid;
          const ts = temp.filter(x => x != null);
          perModel.push({
            id: m.id, name: m.name, res: m.res, w: m.w[Math.min(d, m.w.length - 1)], rates, rain, rh, rainSum, cum,
            gustMax: Math.max(...gust.filter(x => x != null), 0),
            rhMean: avg(rh), tMax: Math.max(...ts), tMin: Math.min(...ts),
          });
        }
      }
      const W = perModel.reduce((a, m) => a + m.w, 0);
      const wavg = f => (W ? perModel.reduce((a, m) => a + m.w * f(m), 0) / W : null);
      const hourWavg = (k, f) => {
        let s = 0, ww = 0;
        for (const m of perModel) { const v = f(m, k); if (v != null) { s += m.w * v; ww += m.w; } }
        return ww ? s / ww : null;
      };
      const meanRates = hours.map((_, k) => hourWavg(k, (m, j) => m.rates[j]));
      const meanRH = hours.map((_, k) => hourWavg(k, (m, j) => m.rh[j]));

      // integrate drying with the hygroscopic slowdown (15-min steps)
      let cum = 0, dryAt = null;
      hours.forEach(({ H }, k) => {
        const r = meanRates[k]; if (r == null) return;
        const f = hygroFactor(meanRH[k]);
        for (let s = 0; s < 4; s++) {
          const inc = (cum >= HYGRO_START * target ? r * f : r) / 4;
          if (dryAt == null && inc > 0 && cum + inc >= target) dryAt = H + (s + (target - cum) / inc) / 4;
          cum += inc;
        }
      });
      const dryFrac = Math.min(1, cum / target);

      const Pdet = W ? wavg(m => (m.rainSum >= RAIN_DAY_MM ? 1 : 0)) : null;
      const rainMean = wavg(m => m.rainSum);
      const gust = wavg(m => m.gustMax);
      const rhMean = wavg(m => m.rhMean ?? 0);
      const cums = perModel.map(m => m.cum);
      const spread = cums.length > 1 ? std(cums) / Math.max(avg(cums), 0.02) : null;
      const lamShare = W ? perModel.filter(m => /icon_2i|icon_d2|icon_ch|arome/.test(m.id)).reduce((a, m) => a + m.w, 0) / W : 0;

      // --- ensembles: probability per system, then lead-dependent blend ---
      let Pens = null, nMem = 0, nWet = 0, wetMeanMm = null, hourlyEns = hours.map(() => null);
      const ensBy = [];
      if (ens && hours.length) {
        const by = new Map(); let wetSum = 0;
        for (const mem of ens.members) {
          const vals = hours.map(({ key }) => { const i = ens.idx.get(key); return i == null ? null : mem.data[i]; });
          if (vals.some(v => v == null)) continue;           // member doesn't reach this day
          const sum = vals.reduce((a, b) => a + b, 0), wet = sum >= RAIN_DAY_MM;
          if (!by.has(mem.src)) by.set(mem.src, { id: mem.src, n: 0, wet: 0, hw: hours.map(() => 0) });
          const b = by.get(mem.src); b.n++; if (wet) b.wet++;
          vals.forEach((v, k) => { if (v >= RAIN_HOUR_MM) b.hw[k]++; });
          nMem++; if (wet) { nWet++; wetSum += sum; }
        }
        let ws = 0, ps = 0; const hp = hours.map(() => 0);
        for (const sys of ENSEMBLES) {
          const b = by.get(sys.id);
          if (!b || b.n < 5) continue;
          const w = sys.w[Math.min(d, sys.w.length - 1)];
          ensBy.push({ id: sys.id, name: sys.name, n: b.n, wet: b.wet, p: b.wet / b.n, w });
          ws += w; ps += w * b.wet / b.n;
          b.hw.forEach((c, k) => { hp[k] += w * c / b.n; });
        }
        if (ws > 0) {
          Pens = ps / ws; hourlyEns = hp.map(v => v / ws);
          wetMeanMm = nWet ? wetSum / nWet : null;
          ensBy.forEach(e => { e.wn = e.w / ws; });
        }
      }

      // --- run-to-run consistency (forecast issued 24 h earlier for the same hours) ---
      let PdetPrev = null, jump = null;
      if (prev && d <= 2 && hours.length) {
        let s = 0, ww = 0, sNow = 0;
        for (const pm of prev.models) {
          const now = perModel.find(m => m.id === pm.id); if (!now) continue;
          const vals = hours.map(({ key }) => { const i = prev.idx.get(key); return i == null ? null : pm.rain[i]; });
          if (vals.some(v => v == null)) continue;
          const wetPrev = vals.reduce((a, b) => a + b, 0) >= RAIN_DAY_MM ? 1 : 0;
          s += now.w * wetPrev; sNow += now.w * (now.rainSum >= RAIN_DAY_MM ? 1 : 0); ww += now.w;
        }
        if (ww > 0) { PdetPrev = s / ww; jump = Math.abs(sNow / ww - PdetPrev); }
      }

      // --- ARPAV ---
      const arpavDay = arpav ? arpav.days.filter(e => e.date === date) : [];
      const Parpav = arpavRainProb(arpavDay);
      const { w: wArpav, att: arpavAtt } = arpavWeight(arpavDay);
      const fogArpav = arpavDay.some(e => /nebbi|nubi basse|foschi/i.test(e.sky));

      // --- blend rain probability ---
      const parts = [[Parpav, wArpav], [Pens, ENS_W], [Pdet, DET_W]].filter(([p]) => p != null);
      const wsum = parts.reduce((a, [, w]) => a + w, 0);
      const P = wsum ? parts.reduce((a, [p, w]) => a + p * w, 0) / wsum : null;
      const shares = wsum ? { arpav: Parpav != null ? wArpav / wsum : 0, ens: Pens != null ? ENS_W / wsum : 0, det: Pdet != null ? DET_W / wsum : 0 } : null;

      // --- score ---
      let score = null;
      if (P != null && perModel.length && !lateToday) {
        let s = 100 * Math.pow(dryFrac, 0.8) * Math.pow(1 - P, 1.3);
        if (gust > 60) s *= 0.8;                        // laundry blown off the line
        if (fogArpav || rhMean > 92) s *= 0.85;         // fog / low stratus → damp
        score = Math.round(s);
      }

      // confidence: agreement on rain, model spread on drying, lead time, run-to-run jumps, ARPAV reliability
      let conf = null, confNotes = [];
      if (score != null) {
        const rainAmb = 1 - Math.abs(2 * P - 1);           // 0 = sure, 1 = coin flip
        let c = 1 - 0.5 * rainAmb - 0.3 * Math.min(1, spread ?? 0.5) - 0.05 * d;
        if (jump != null) c -= 0.3 * jump;
        if (arpavAtt && ARPAV_W[arpavAtt] <= 0.35) c -= 0.1;
        conf = c > 0.7 ? 'alta' : c > 0.45 ? 'media' : 'bassa';
        if (jump != null) confNotes.push(jump < 0.2 ? 'stabile rispetto a ieri' : jump < 0.4 ? 'un po’ cambiata rispetto a ieri' : 'cambiata molto rispetto a ieri');
      }

      // first likely-rain hour
      let rainFrom = null;
      const hourlyDet = hours.map((_, k) => (W ? wavg(m => ((m.rain[k] ?? 0) >= RAIN_HOUR_MM ? 1 : 0)) : null));
      const hourlyP = hours.map((_, k) => (hourlyEns[k] != null ? hourlyEns[k] : hourlyDet[k]));
      hours.forEach(({ H }, k) => {
        if (rainFrom == null && hourlyP[k] != null && hourlyP[k] >= 0.4) rainFrom = H;
      });

      days.push({
        date, d, start, end, sunrise, sunset, lateToday, hours, meanRates, hourlyP, target,
        perModel, cumE: cum, dryFrac, dryAt, Pdet, Pens, nMem, nWet, wetMeanMm, ensBy,
        tMax: wavg(m => m.tMax), tMin: wavg(m => m.tMin), Parpav, arpavAtt, P, shares, rainMean, gust, rhMean,
        spread, lamShare, PdetPrev, jump, arpavDay, fogArpav, score, conf, confNotes, rainFrom,
      });
    }

    // best day: highest score, earlier day wins ties (within 3 points)
    let best = null;
    for (const day of days) {
      if (day.score == null) continue;
      if (!best || day.score > best.score + 3) best = day;
    }
    return { days, best, target };
  }

  // dryFrac < 0.9 → the load won't fully dry outdoors, so never call it "great"
  function verdict(score, dryFrac = 1) {
    if (score == null) return { key: 'na', label: 'Dati insufficienti' };
    if (score >= 70 && dryFrac >= 0.9) return { key: 'great', label: 'Ottimo — stendi fuori' };
    if (score >= 50 && dryFrac < 0.9) return { key: 'good', label: 'Buono, ma finisci in casa' };
    if (score >= 50) return { key: 'good', label: 'Buona giornata per asciugare' };
    if (score >= 30) return { key: 'iffy', label: 'Incerto — al riparo, tieni d’occhio il cielo' };
    return { key: 'bad', label: 'Asciuga in casa / asciugatrice' };
  }

  function avg(a) { const v = a.filter(x => x != null); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }
  function std(a) { const m = avg(a); return Math.sqrt(avg(a.map(x => (x - m) ** 2))); }

  return { TZ, MODELS, PREV_MODELS, ENSEMBLES, ENS_MODELS, HOURLY_VARS, ZONES, DAYS, LOADS, DRY_TARGET,
    nearestZone, todayYMD, addDays, dryingRate, hygroFactor,
    parseDeterministic, parseEnsemble, parsePrevious, analyse, verdict };
})();

if (typeof module !== 'undefined') module.exports = Core;
