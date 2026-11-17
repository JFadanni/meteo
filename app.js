// app.js — data fetching (ARPAV + Open-Meteo), ARPAV XML parsing, rendering.
'use strict';

const ARPAV_XML = 'https://www.arpa.veneto.it/risorse/data-bollettini/meteo/bollettini/it/xml/';
const OM = 'https://api.open-meteo.com/v1/forecast';
const OM_ENS = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const OM_GEO = 'https://geocoding-api.open-meteo.com/v1/search';
const LS_LOC = 'bucato.location';
const LS_CACHE = 'bucato.cache';

const DEFAULT_LOC = { name: 'Padova', lat: 45.4064, lon: 11.8768, zoneId: null };

const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'style') e.style.cssText = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
};

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* ignore */ } },
};

let loc = store.get(LS_LOC) || DEFAULT_LOC;

// ---------------- fetching ----------------
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}
async function getXML(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const doc = new DOMParser().parseFromString(await r.text(), 'text/xml');
  if (doc.querySelector('parsererror')) throw new Error('ARPAV XML parse error');
  return doc;
}

function fetchDeterministic({ lat, lon }) {
  const q = new URLSearchParams({
    latitude: lat, longitude: lon, hourly: Core.HOURLY_VARS.join(','),
    models: Core.MODELS.map(m => m.id).join(','), forecast_days: 6, timezone: Core.TZ,
  });
  return getJSON(`${OM}?${q}`);
}
function fetchEnsemble({ lat, lon }) {
  const q = new URLSearchParams({
    latitude: lat, longitude: lon, hourly: 'precipitation',
    models: Core.ENS_MODELS.join(','), forecast_days: 6, timezone: Core.TZ,
  });
  return getJSON(`${OM_ENS}?${q}`);
}
function fetchSun({ lat, lon }) {
  const q = new URLSearchParams({ latitude: lat, longitude: lon, daily: 'sunrise,sunset', forecast_days: 6, timezone: Core.TZ });
  return getJSON(`${OM}?${q}`);
}

// Strip HTML/entities from ARPAV CDATA safely (never injected as HTML).
const plain = s => new DOMParser().parseFromString(s || '', 'text/html').body.textContent.replace(/\s+/g, ' ').trim();

async function fetchArpav(zoneId) {
  const [widget, utenti] = await Promise.allSettled([getXML(ARPAV_XML + 'bollettino_widget.xml'), getXML(ARPAV_XML + 'bollettino_utenti.xml')]);
  if (widget.status !== 'fulfilled') throw widget.reason;
  const w = widget.value;
  const bul = w.querySelector('bulletin');
  const mg = w.querySelector(`meteogram[zoneid="${zoneId}"]`);
  const days = mg ? [...mg.querySelectorAll('day')].map(d => {
    const t = [...d.querySelectorAll('temp')].find(x => !x.getAttribute('meters')) || d.querySelector('temp');
    const sky = d.querySelector('sky'), rain = d.querySelector('rain');
    return {
      date: d.getAttribute('date'), time: d.getAttribute('time'),
      tmin: t?.getAttribute('min') || '', tmax: t?.getAttribute('max') || '',
      tLabel: t?.getAttribute('meters') ? `${t.getAttribute('meters')} m` : '',
      img: sky?.getAttribute('img') || '', sky: sky?.textContent.trim() || '',
      rainPerc: parseInt(rain?.getAttribute('perc') || '0', 10) || 0, rain: rain?.textContent.trim() || '',
    };
  }) : [];

  let text = null;
  if (utenti.status === 'fulfilled') {
    const id = zoneId <= 3 ? 'DM' : 'MV';
    const b = utenti.value.querySelector(`bollettino[bollettinoid="${id}"]`) || utenti.value.querySelector('bollettino');
    if (b) {
      text = {
        name: b.getAttribute('name'), title: b.getAttribute('title'),
        evol: plain(b.querySelector('evoluzionegenerale')?.textContent),
        avviso: plain(b.querySelector('avviso')?.textContent),
        days: [...b.querySelectorAll('giorno')].map(g => ({ data: g.getAttribute('data'), text: plain(g.querySelector('text')?.textContent) })),
      };
    }
  }
  return {
    issued: bul ? `${bul.getAttribute('date')} ${bul.getAttribute('time')}` : '',
    updated: w.querySelector('data_aggiornamento')?.getAttribute('date') || '',
    zoneName: mg?.getAttribute('name') || '', days, text,
  };
}

// ---------------- main flow ----------------
async function load() {
  const nz = Core.nearestZone(loc.lat, loc.lon);
  const zone = loc.zoneId ? Core.ZONES.find(z => z.id === loc.zoneId) : nz.zone;
  const inVeneto = loc.zoneId || nz.distKm < 70;
  renderHeader(zone, inVeneto);
  setStatus('Caricamento previsioni…');

  const [det, ens, sun, arp] = await Promise.allSettled([
    fetchDeterministic(loc), fetchEnsemble(loc), fetchSun(loc), inVeneto ? fetchArpav(zone.id) : Promise.reject(new Error('Fuori dal Veneto')),
  ]);
  const ok = r => (r.status === 'fulfilled' ? r.value : null);
  if (!ok(det) && !ok(ens)) {
    const cached = store.get(LS_CACHE);
    if (cached && cached.locName === loc.name) {
      setStatus(`Offline — dati salvati il ${new Date(cached.at).toLocaleString('it-IT')}`, true);
      return render(cached.raw, zone, inVeneto);
    }
    return setStatus('Impossibile caricare le previsioni. Controlla la connessione e riprova.', true);
  }
  const raw = { det: ok(det), ens: ok(ens), sun: ok(sun), arpav: ok(arp) };
  store.set(LS_CACHE, { at: Date.now(), locName: loc.name, raw });
  const warn = [];
  if (!raw.arpav && inVeneto) warn.push('bollettino ARPAV non disponibile');
  if (!raw.ens) warn.push('ensemble non disponibile');
  setStatus(warn.length ? `Dati parziali: ${warn.join(', ')}` : '', !!warn.length);
  render(raw, zone, inVeneto);
}

function render(raw, zone, inVeneto) {
  const det = raw.det ? Core.parseDeterministic(raw.det) : null;
  const ens = raw.ens ? Core.parseEnsemble(raw.ens) : null;
  const res = Core.analyse({ det, ens, sun: raw.sun, arpav: raw.arpav });
  renderHero(res);
  renderDays(res, raw.arpav);
  renderArpavText(raw.arpav, inVeneto);
  $('#updated').textContent = `Aggiornato alle ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` +
    (raw.arpav ? ` · Bollettino ARPAV ${raw.arpav.issued}${raw.arpav.updated ? `, aggiornamento ${raw.arpav.updated}` : ''}` : '');
}

// ---------------- rendering ----------------
const fmtH = h => { if (h == null) return '–'; const H = Math.floor(h), M = Math.round((h - H) * 60 / 15) * 15; return `${String(H + (M === 60 ? 1 : 0)).padStart(2, '0')}:${String(M % 60).padStart(2, '0')}`; };
const pct = p => (p == null ? '–' : `${Math.round(p * 100)}%`);
const dayName = (ymd, d) => {
  if (d === 0) return 'Oggi';
  if (d === 1) return 'Domani';
  const [y, m, dd] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd, 12)).toLocaleDateString('it-IT', { weekday: 'long', timeZone: 'UTC' }).replace(/^./, c => c.toUpperCase());
};
const dateShort = ymd => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', timeZone: 'UTC' }); };
const arpavIcon = img => (img ? `https://www.arpa.veneto.it/risorse/data-bollettini/meteo/icone/meteo/${img}` : null);

function setStatus(msg, warn = false) {
  const s = $('#status'); s.textContent = msg; s.hidden = !msg; s.classList.toggle('warn', warn);
}

function renderHeader(zone, inVeneto) {
  $('#place').textContent = loc.name;
  $('#zone').textContent = inVeneto ? `Zona ARPAV: ${zone.name}${loc.zoneId ? ' (manuale)' : ''}` : 'Fuori dal Veneto — solo modelli';
}

function renderHero({ best, days }) {
  const h = $('#hero'); h.replaceChildren();
  if (!best) { h.append(el('p', {}, 'Dati insufficienti per consigliare un giorno.')); return; }
  const v = Core.verdict(best.score, best.dryFrac);
  const allBad = days.every(d => d.score == null || d.score < 30);
  h.className = `hero v-${v.key}`;
  h.append(
    el('div', { class: 'hero-kicker' }, allBad ? 'Nessun giorno buono all’aperto — il meno peggio' : 'Giorno migliore per il bucato'),
    el('div', { class: 'hero-day' }, `${dayName(best.date, best.d)} `, el('span', { class: 'hero-date' }, dateShort(best.date))),
    el('div', { class: 'hero-row' },
      scoreRing(best.score, 64, best.dryFrac),
      el('div', {},
        el('div', { class: 'hero-verdict' }, v.label),
        el('div', { class: 'hero-detail' }, plan(best)))),
  );
}

function plan(day) {
  const parts = [`Stendi alle ${fmtH(day.start)}`];
  if (day.dryAt) parts.push(`asciutto verso le ${fmtH(day.dryAt)}`);
  else parts.push(`asciutto al ~${Math.round(day.dryFrac * 100)}% al tramonto`);
  if (day.rainFrom != null) parts.push(`ritira prima delle ${fmtH(day.rainFrom)} (probabile pioggia)`);
  else parts.push(`ritira entro le ${fmtH(day.end)}`);
  return parts.join(' · ');
}

function scoreRing(score, size = 48, dryFrac = 1) {
  const r = 15.9, c = 2 * Math.PI * r, v = Core.verdict(score, dryFrac);
  const svg = `<svg viewBox="0 0 36 36" width="${size}" height="${size}" aria-hidden="true">
    <circle cx="18" cy="18" r="${r}" fill="none" stroke="var(--ring-bg)" stroke-width="3.2"/>
    <circle cx="18" cy="18" r="${r}" fill="none" stroke="var(--c-${v.key})" stroke-width="3.2" stroke-linecap="round"
      stroke-dasharray="${(c * (score ?? 0)) / 100} ${c}" transform="rotate(-90 18 18)"/>
    <text x="18" y="18" text-anchor="middle" dominant-baseline="central" font-size="11" font-weight="700" fill="currentColor">${score ?? '–'}</text></svg>`;
  const s = el('div', { class: 'ring', role: 'img', 'aria-label': `Punteggio ${score ?? 'n.d.'} su 100` });
  s.innerHTML = svg; // static template, numeric values only
  return s;
}

function renderDays({ days, best }) {
  const box = $('#days'); box.replaceChildren();
  for (const day of days) {
    const v = Core.verdict(day.score, day.dryFrac);
    const card = el('article', { class: `day v-${v.key}${best && day.date === best.date ? ' best' : ''}` });

    card.append(el('header', { class: 'day-head' },
      el('div', {},
        el('h3', {}, dayName(day.date, day.d), ' ', el('span', { class: 'muted' }, dateShort(day.date))),
        el('div', { class: `verdict t-${v.key}` }, day.lateToday ? 'Troppo tardi per oggi' : v.label)),
      day.lateToday ? null : scoreRing(day.score, 48, day.dryFrac)));

    if (!day.lateToday) {
      // ARPAV row
      if (day.arpavDay.length) {
        card.append(el('div', { class: 'arpav' },
          el('span', { class: 'src' }, 'ARPAV'),
          ...day.arpavDay.map(e => el('div', { class: 'arpav-slot', title: e.sky },
            arpavIcon(e.img) ? el('img', { src: arpavIcon(e.img), alt: e.sky, width: 34, height: 34, loading: 'lazy' }) : null,
            el('div', {},
              el('div', { class: 'slot-t' }, e.time === 'am' ? 'Mattina' : e.time === 'pm' ? 'Pomeriggio' : 'Giornata'),
              el('div', { class: 'slot-s' }, e.sky),
              el('div', { class: 'slot-r' }, `Pioggia ${e.rainPerc}%`, e.tmax && !e.tLabel ? ` · ${e.tmin ? e.tmin + '…' : ''}${e.tmax}°` : '')))),
        ));
      } else {
        card.append(el('div', { class: 'arpav none' }, el('span', { class: 'src' }, 'ARPAV'), 'Bollettino ufficiale non ancora disponibile per questo giorno'));
      }

      // metrics
      card.append(el('dl', { class: 'metrics' },
        metric('Prob. pioggia', pct(day.P), 'ARPAV + ensemble + modelli'),
        metric('Ensemble', day.Pens != null ? pct(day.Pens) : '–', day.nMem ? `${day.nMem} membri` : 'n.d.'),
        metric('Modelli con pioggia', day.Pdet != null ? pct(day.Pdet) : '–', `${day.perModel.length} modelli`),
        metric('Asciugatura', day.dryAt ? `entro le ${fmtH(day.dryAt)}` : `${Math.round(day.dryFrac * 100)}%`, `finestra ${fmtH(day.start)}–${fmtH(day.end)}`),
        metric('Umidità', day.rhMean != null ? `${Math.round(day.rhMean)}%` : '–', 'media nella finestra'),
        metric('Raffiche', day.gust != null ? `${Math.round(day.gust)} km/h` : '–', 'max nella finestra'),
      ));

      card.append(hourStrip(day));
      if (day.conf) card.append(el('div', { class: 'conf' }, `Affidabilità: ${day.conf}`, day.fogArpav ? ' · prevista nebbia/nubi basse' : ''));

      // details per model
      const tbl = el('table', { class: 'models' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Modello'), el('th', {}, 'Pioggia (mm)'), el('th', {}, 'Asciugatura'), el('th', {}, 'Raffica max'))),
        el('tbody', {}, day.perModel.map(m => el('tr', {},
          el('td', {}, m.name), el('td', {}, m.rainSum.toFixed(1)),
          el('td', {}, `${Math.round(Math.min(1, m.cum / Core.DRY_TARGET) * 100)}%`),
          el('td', {}, `${Math.round(m.gustMax)} km/h`)))));
      card.append(el('details', {}, el('summary', {}, 'Dettaglio modello per modello'), el('div', { class: 'tbl-wrap' }, tbl)));
    }
    box.append(card);
  }
}

function metric(label, value, hint) {
  return el('div', { class: 'metric' }, el('dt', {}, label), el('dd', {}, value), el('small', {}, hint));
}

function hourStrip(day) {
  const maxRate = 0.25; // mm/h → full bar
  const strip = el('div', { class: 'strip', 'aria-label': 'Velocità di asciugatura e probabilità di pioggia orarie' });
  day.hours.forEach(({ H }, k) => {
    const r = day.meanRates[k], p = day.hourlyP[k];
    const hgt = r == null ? 0 : Math.min(100, (r / maxRate) * 100);
    strip.append(el('div', { class: 'hr', title: `${fmtH(H)}–${fmtH(H + 1)}: asciugatura ${r?.toFixed(2) ?? '–'} mm/h, pioggia ${pct(p)}` },
      el('div', { class: 'hr-rain', style: `opacity:${p == null ? 0 : Math.max(0.08, p)}` }, p != null && p >= 0.2 ? `${Math.round(p * 100)}` : ''),
      el('div', { class: 'hr-bar' }, el('div', { style: `height:${hgt}%` })),
      el('div', { class: 'hr-h' }, String(H))));
  });
  return el('div', {}, strip, el('div', { class: 'legend' },
    el('span', {}, el('i', { class: 'lg-dry' }), 'velocità di asciugatura'), el('span', {}, el('i', { class: 'lg-rain' }), 'prob. pioggia %')));
}

function renderArpavText(arpav, inVeneto) {
  const box = $('#arpav-text'); box.replaceChildren();
  if (!inVeneto) { box.append(el('p', { class: 'muted' }, 'ARPAV copre solo il Veneto: per questa località si usano solo i modelli.')); return; }
  if (!arpav?.text) { box.hidden = true; return; }
  box.hidden = false;
  const t = arpav.text;
  box.append(el('h2', {}, `ARPAV — ${t.name}`), el('p', { class: 'muted' }, t.title));
  if (t.avviso) box.append(el('p', { class: 'avviso' }, t.avviso));
  if (t.evol) box.append(el('p', {}, el('b', {}, 'Evoluzione generale: '), t.evol));
  for (const g of t.days) if (g.text) box.append(el('p', {}, el('b', {}, `${g.data}: `), g.text.replace(/^Previsione:\s*/i, '')));
}

// ---------------- location UI ----------------
function setupLocationUI() {
  const panel = $('#loc-panel');
  $('#change-loc').addEventListener('click', () => { panel.hidden = !panel.hidden; if (!panel.hidden) $('#q').focus(); });
  $('#refresh').addEventListener('click', () => load());

  const sel = $('#zone-sel');
  sel.append(el('option', { value: '' }, 'Automatica (la più vicina)'), ...Core.ZONES.map(z => el('option', { value: z.id }, `${z.id}. ${z.name}`)));
  sel.value = loc.zoneId || '';
  sel.addEventListener('change', () => { loc.zoneId = sel.value ? Number(sel.value) : null; store.set(LS_LOC, loc); load(); });

  $('#gps').addEventListener('click', () => {
    if (!navigator.geolocation) return setStatus('Geolocalizzazione non disponibile in questo browser.', true);
    setStatus('Rilevamento posizione…');
    navigator.geolocation.getCurrentPosition(async pos => {
      const { latitude: lat, longitude: lon } = pos.coords;
      loc = { name: `La mia posizione (${lat.toFixed(3)}, ${lon.toFixed(3)})`, lat, lon, zoneId: loc.zoneId };
      store.set(LS_LOC, loc); panel.hidden = true; load();
    }, err => setStatus(`Errore di posizione: ${err.message}. Su Android la pagina deve essere aperta via https o localhost, e Firefox deve avere il permesso di posizione.`, true),
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  });

  let timer;
  $('#q').addEventListener('input', e => {
    clearTimeout(timer);
    const q = e.target.value.trim();
    const list = $('#results');
    if (q.length < 2) { list.replaceChildren(); return; }
    timer = setTimeout(async () => {
      try {
        const r = await getJSON(`${OM_GEO}?${new URLSearchParams({ name: q, count: 8, language: 'it', countryCode: 'IT' })}`);
        list.replaceChildren(...(r.results || []).map(p => el('li', {}, el('button', {
          type: 'button',
          onclick: () => {
            loc = { name: p.name, lat: p.latitude, lon: p.longitude, zoneId: null };
            sel.value = ''; store.set(LS_LOC, loc); panel.hidden = true; e.target.value = ''; list.replaceChildren(); load();
          },
        }, p.name, el('span', { class: 'muted' }, ` ${[p.admin3, p.admin2, p.admin1].filter(Boolean).join(', ')}`)))));
        if (!r.results) list.append(el('li', { class: 'muted' }, 'Nessuna località trovata'));
      } catch { list.replaceChildren(el('li', { class: 'muted' }, 'Ricerca non riuscita (offline?)')); }
    }, 300);
  });
}

// ---------------- boot ----------------
setupLocationUI();
load();
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
