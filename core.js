// core.js — pure meteorological logic (no DOM). Loaded before app.js.
// Everything here is deterministic given the fetched data, so it can be reasoned about / tested.
'use strict';

const Core = (() => {
  const TZ = 'Europe/Rome';

  // Deterministic models requested from Open-Meteo, with blending weights.
  // ICON-2I (ItaliaMeteo/ARPAE, 2.2 km) resolves Alps/Prealps/Po valley best at short range.
  const MODELS = [
    { id: 'italia_meteo_arpae_icon_2i', name: 'ItaliaMeteo ICON-2I', w: 1.3 },
    { id: 'ecmwf_ifs025',               name: 'ECMWF IFS',           w: 1.2 },
    { id: 'icon_seamless',              name: 'DWD ICON',            w: 1.0 },
    { id: 'meteofrance_seamless',       name: 'Météo-France',        w: 1.0 },
    { id: 'ukmo_seamless',              name: 'UK Met Office',       w: 1.0 },
    { id: 'gfs_seamless',               name: 'NOAA GFS',            w: 0.8 },
  ];
  const ENS_MODELS = ['ecmwf_ifs025', 'icon_eu']; // 51 + 40 members
  const HOURLY_VARS = ['temperature_2m', 'relative_humidity_2m', 'vapour_pressure_deficit',
    'precipitation', 'wind_speed_10m', 'wind_gusts_10m', 'shortwave_radiation', 'cloud_cover'];

  // Thresholds
  const RAIN_DAY_MM = 0.3;   // rain in the drying window that ruins it (sum, mm)
  const RAIN_HOUR_MM = 0.1;  // hourly "wet" threshold for the hourly strip
  const DRY_TARGET = 1.0;    // mm-equivalent evaporation to dry a typical cotton load (empirical)
  const DAYS = 5;

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

  // ---- physics ----
  // Penman-type evaporation from a wet, hanging textile (mm/h equivalent).
  // E = W·Rn/λ + (1−W)·Ea, W = Δ/(Δ+γ), Ea = 0.26(1+0.54u)·VPD[hPa] per day (Penman 1948 wind function).
  function dryingRate(T, RH, vpdKPa, windKmh, sw) {
    if (T == null || (RH == null && vpdKPa == null)) return null;
    const es = 0.6108 * Math.exp(17.27 * T / (T + 237.3));        // kPa
    const vpd = vpdKPa != null ? vpdKPa : Math.max(0, es * (1 - RH / 100));
    const delta = 4098 * es / (T + 237.3) ** 2;                      // kPa/K
    const gamma = 0.066;
    const W = delta / (delta + gamma);
    const u = Math.min((windKmh ?? 5) / 3.6, 8) * 0.75;               // 10 m → ~1.5 m height
    const Ea = 0.26 * (1 + 0.54 * u) * (vpd * 10) / 24;              // mm/h
    const Er = 0.5 * Math.max(0, sw ?? 0) / 681;                     // vertical cloth intercepts ~half; 681 W/m² = 1 mm/h
    let E = W * Er + (1 - W) * Ea;
    if (T < 0) E *= 0.5;                                              // freezing: slow sublimation
    return Math.max(0, E);
  }

  // ---- parsing Open-Meteo ----
  function indexByTime(times) { const m = new Map(); times.forEach((t, i) => m.set(t, i)); return m; }

  function parseDeterministic(json) {
    const h = json.hourly, idx = indexByTime(h.time);
    const models = MODELS.map(m => {
      const s = {};
      for (const v of HOURLY_VARS) s[v] = h[`${v}_${m.id}`] || null;
      return { ...m, s };
    }).filter(m => m.s.precipitation);
    return { time: h.time, idx, models };
  }

  const ENS_NAMES = { ecmwf_ifs025: 'ECMWF', icon_eu: 'ICON-EU' };
  function parseEnsemble(json) {
    const h = json.hourly, idx = indexByTime(h.time);
    const members = Object.keys(h).filter(k => k.startsWith('precipitation')).map(k => {
      const src = ENS_MODELS.find(id => k.includes(id)) || 'other';
      return { src, data: h[k] };
    });
    return { time: h.time, idx, members };
  }

  // ---- ARPAV rain probability for a date (from widget meteogram) ----
  function arpavRainProb(entries) {
    if (!entries || !entries.length) return null;
    const p = t => { const e = entries.find(x => x.time === t); return e ? e.rainPerc / 100 : null; };
    const all = p('all'), am = p('am'), pm = p('pm');
    if (all != null) return all;
    // "am" = night/morning (includes the night, less relevant); "pm" = afternoon/evening
    const vals = [am != null ? 0.8 * am : null, pm].filter(v => v != null);
    return vals.length ? Math.max(...vals) : null;
  }

  // ---- the main per-day analysis ----
  function analyse({ det, ens, sun, arpav, now = new Date() }) {
    const today = todayYMD(now);
    const nowH = nowHourFloat(now);
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
      const nHours = end - start;
      if (nHours < 3) lateToday = true;

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
            rates.push(dryingRate(g('temperature_2m'), g('relative_humidity_2m'), g('vapour_pressure_deficit'),
              g('wind_speed_10m'), g('shortwave_radiation')));
            rain.push(g('precipitation')); gust.push(g('wind_gusts_10m')); rh.push(g('relative_humidity_2m'));
            temp.push(g('temperature_2m'));
          }
          const valid = rates.filter(r => r != null).length;
          const validRain = rain.filter(r => r != null).length;
          if (valid < 0.8 * hours.length || validRain < 0.8 * hours.length) continue; // model doesn't cover this day
          const rainSum = rain.reduce((a, b) => a + (b || 0), 0);
          const cum = rates.reduce((a, b) => a + (b || 0), 0) * hours.length / valid;
          perModel.push({
            id: m.id, name: m.name, w: m.w, rates, rain, rainSum, cum,
            gustMax: Math.max(...gust.filter(x => x != null), 0),
            rhMean: avg(rh), tMax: Math.max(...temp.filter(x => x != null)), tMin: Math.min(...temp.filter(x => x != null)),
          });
        }
      }
      const W = perModel.reduce((a, m) => a + m.w, 0);
      const wavg = f => W ? perModel.reduce((a, m) => a + m.w * f(m), 0) / W : null;

      // mean hourly drying rate across models → time to dry
      const meanRates = hours.map((_, k) => {
        let s = 0, ww = 0;
        for (const m of perModel) if (m.rates[k] != null) { s += m.w * m.rates[k]; ww += m.w; }
        return ww ? s / ww : null;
      });
      let cum = 0, dryAt = null;
      meanRates.forEach((r, k) => {
        if (dryAt != null || r == null) return;
        if (cum + r >= DRY_TARGET) dryAt = hours[k].H + (DRY_TARGET - cum) / r;
        cum += r;
      });
      const cumE = meanRates.reduce((a, b) => a + (b || 0), 0);
      const Pdet = W ? wavg(m => (m.rainSum >= RAIN_DAY_MM ? 1 : 0)) : null;
      const rainMean = wavg(m => m.rainSum);
      const gust = wavg(m => m.gustMax);
      const rhMean = wavg(m => m.rhMean ?? 0);
      const cums = perModel.map(m => m.cum);
      const spread = cums.length > 1 ? std(cums) / Math.max(avg(cums), 0.05) : null;

      // --- ensemble ---
      // Each member is one plausible scenario; count those that are wet in the drying window.
      let Pens = null, nMem = 0, nWet = 0, wetMeanMm = null, hourlyEns = hours.map(() => null);
      const ensBy = [];
      if (ens && hours.length) {
        const hw = hours.map(() => [0, 0]), by = new Map(); let wetSum = 0;
        for (const mem of ens.members) {
          const vals = hours.map(({ key }) => { const i = ens.idx.get(key); return i == null ? null : mem.data[i]; });
          if (vals.some(v => v == null)) continue;           // member doesn't reach this day
          const sum = vals.reduce((a, b) => a + b, 0), wet = sum >= RAIN_DAY_MM;
          vals.forEach((v, k) => { hw[k][1]++; if (v >= RAIN_HOUR_MM) hw[k][0]++; });
          nMem++; if (wet) { nWet++; wetSum += sum; }
          if (!by.has(mem.src)) by.set(mem.src, { name: ENS_NAMES[mem.src] || mem.src, n: 0, wet: 0 });
          const b = by.get(mem.src); b.n++; if (wet) b.wet++;
        }
        if (nMem >= 10) {
          Pens = nWet / nMem; hourlyEns = hw.map(([a, b]) => (b ? a / b : null));
          wetMeanMm = nWet ? wetSum / nWet : null;
          ensBy.push(...by.values());
        }
      }

      // --- ARPAV ---
      const arpavDay = arpav ? arpav.days.filter(e => e.date === date) : [];
      const Parpav = arpavRainProb(arpavDay);
      const fogArpav = arpavDay.some(e => /nebbi|nubi basse|foschi/i.test(e.sky));

      // --- blend rain probability ---
      const parts = [[Parpav, 0.4], [Pens, 0.4], [Pdet, 0.2]].filter(([p]) => p != null);
      const wsum = parts.reduce((a, [, w]) => a + w, 0);
      const P = wsum ? parts.reduce((a, [p, w]) => a + p * w, 0) / wsum : null;

      // --- score ---
      const dryFrac = Math.min(1, cumE / DRY_TARGET);
      let score = null;
      if (P != null && perModel.length && !lateToday) {
        let s = 100 * Math.pow(dryFrac, 0.8) * Math.pow(1 - P, 1.3);
        if (gust > 60) s *= 0.8;                        // laundry blown off the line
        if (fogArpav || rhMean > 92) s *= 0.85;         // fog / low stratus → damp
        score = Math.round(s);
      }

      // confidence: agreement on rain (P near 0/1), model spread on drying, lead time
      let conf = null;
      if (score != null) {
        const rainAmb = 1 - Math.abs(2 * P - 1);           // 0 = sure, 1 = coin flip
        const c = 1 - 0.5 * rainAmb - 0.3 * Math.min(1, spread ?? 0.5) - 0.05 * d;
        conf = c > 0.7 ? 'alta' : c > 0.45 ? 'media' : 'bassa';
      }

      // first likely-rain hour (ensemble ≥ 40%, else deterministic mean ≥ 0.1 mm)
      let rainFrom = null;
      const hourlyDet = hours.map((_, k) => (W ? wavg(m => ((m.rain[k] ?? 0) >= RAIN_HOUR_MM ? 1 : 0)) : null));
      const hourlyP = hours.map((_, k) => (hourlyEns[k] != null ? hourlyEns[k] : hourlyDet[k]));
      hours.forEach(({ H }, k) => {
        if (rainFrom == null && hourlyP[k] != null && hourlyP[k] >= 0.4) rainFrom = H;
      });

      days.push({
        date, d, start, end, sunrise, sunset, lateToday, hours, meanRates, hourlyP,
        perModel, cumE, dryFrac, dryAt, Pdet, Pens, nMem, nWet, wetMeanMm, ensBy,
        tMax: wavg(m => m.tMax), tMin: wavg(m => m.tMin), Parpav, P, rainMean, gust, rhMean,
        spread, arpavDay, fogArpav, score, conf, rainFrom,
      });
    }

    // best day: highest score, earlier day wins ties (within 3 points)
    let best = null;
    for (const day of days) {
      if (day.score == null) continue;
      if (!best || day.score > best.score + 3) best = day;
    }
    return { days, best };
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

  return { TZ, MODELS, ENS_MODELS, HOURLY_VARS, ZONES, DAYS, DRY_TARGET, nearestZone, todayYMD, addDays,
    dryingRate, parseDeterministic, parseEnsemble, analyse, verdict };
})();

if (typeof module !== 'undefined') module.exports = Core;
