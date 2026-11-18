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
const LS_LOAD = 'bucato.load';
let loadType = store.get(LS_LOAD) || 'misto';
let lastRender = null; // re-render without refetching when the load type changes

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
// Same models, forecast issued 24 h earlier for the same hours → run-to-run stability (D0–D2).
function fetchPrevious({ lat, lon }) {
  const q = new URLSearchParams({
    latitude: lat, longitude: lon, hourly: 'precipitation_previous_day1',
    models: Core.PREV_MODELS.join(','), forecast_days: 3, timezone: Core.TZ,
  });
  return getJSON(`https://previous-runs-api.open-meteo.com/v1/forecast?${q}`);
}
function fetchSun({ lat, lon }) {
  const q = new URLSearchParams({ latitude: lat, longitude: lon, daily: 'sunrise,sunset', forecast_days: 6, timezone: Core.TZ });
  return getJSON(`${OM}?${q}`);
}

// Strip HTML/entities from ARPAV CDATA safely (never injected as HTML).
const plain = s => new DOMParser().parseFromString(s || '', 'text/html').body.textContent.replace(/\s+/g, ' ').trim();

// ARPAV day text is HTML like "<b>Tempo atteso: </b>…<br /><b>Precipitazioni: </b>…".
// Split it into labelled sections (as plain text, never injected as HTML).
function splitSections(html) {
  const body = new DOMParser().parseFromString(html || '', 'text/html').body;
  const sections = []; let cur = null;
  for (const n of body.childNodes) {
    if (n.nodeName === 'B' || n.nodeName === 'STRONG') {
      cur = { label: n.textContent.replace(/[:\s]+$/, '').trim(), text: '' }; sections.push(cur);
    } else if (n.nodeName !== 'BR') {
      if (!cur) { cur = { label: '', text: '' }; sections.push(cur); }
      cur.text += n.textContent;
    }
  }
  let previsore = null, attendibilita = null;
  const out = [];
  for (const s of sections) {
    s.text = s.text.replace(/\s*Previsore:\s*([^\n]+)/i, (_, p) => { previsore = p.trim(); return ''; }).replace(/\s+/g, ' ').trim();
    if (/^attendibilit/i.test(s.label)) { attendibilita = s.text; continue; }
    if (s.label || s.text) out.push(s);
  }
  return { sections: out, previsore, attendibilita };
}

const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
function italianDateToYMD(s) {
  const m = /(\d{1,2})\s+([a-zà]+)/i.exec(s || ''); if (!m) return null;
  const mon = MESI.indexOf(m[2].toLowerCase()); if (mon < 0) return null;
  const today = Core.todayYMD(); let y = Number(today.slice(0, 4));
  if (mon === 0 && today.slice(5, 7) === '12') y++;            // bulletin crossing new year
  return `${y}-${String(mon + 1).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
}

async function fetchArpav(zoneId) {
  const [widget, utenti, bot] = await Promise.allSettled([getXML(ARPAV_XML + 'bollettino_widget.xml'),
    getXML(ARPAV_XML + 'bollettino_utenti.xml'), getXML(ARPAV_XML + 'bollettino_bot.xml')]);
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

  // forecaster's reliability ("attendibilità") for each slot of this zone
  if (bot.status === 'fulfilled') {
    const mz = bot.value.querySelector(`meteogramma[zoneid="${zoneId}"]`);
    for (const sc of mz ? mz.querySelectorAll('scadenza') : []) {
      const lab = sc.getAttribute('data') || '';
      const date = italianDateToYMD(lab);
      const time = /notte|mattin/i.test(lab) ? 'am' : /pomerig|sera/i.test(lab) ? 'pm' : 'all';
      const att = sc.querySelector('ATTENDIBILITA')?.textContent.trim();
      const e = days.find(x => x.date === date && x.time === time);
      if (e && att) e.att = att;
    }
  }

  let text = null;
  if (utenti.status === 'fulfilled') {
    // Dolomiti Meteo for mountains/prealps, Meteo Pianura for plain and coast, Meteo Veneto otherwise
    const id = [1, 2, 3, 4, 8].includes(zoneId) ? 'DM' : zoneId === 5 ? 'MV' : 'MP';
    const b = utenti.value.querySelector(`bollettino[bollettinoid="${id}"]`) ||
      utenti.value.querySelector('bollettino[bollettinoid="MV"]') || utenti.value.querySelector('bollettino');
    if (b) {
      text = {
        name: b.getAttribute('name'), title: b.getAttribute('title'),
        evol: plain(b.querySelector('evoluzionegenerale')?.textContent),
        avviso: plain(b.querySelector('avviso')?.textContent),
        fenomeni: plain(b.querySelector('fenomeniparticolari')?.textContent),
        days: [...b.querySelectorAll('giorno')].map(g => ({
          data: g.getAttribute('data'),
          date: italianDateToYMD(g.getAttribute('data')),
          maps: [...g.querySelectorAll('img')].map(i => ({ src: i.getAttribute('src'), caption: i.getAttribute('caption') || '' }))
            .filter(m => /^https:\/\//.test(m.src)),
          ...splitSections(g.querySelector('text')?.textContent),
        })),
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

  const [det, ens, sun, arp, prev] = await Promise.allSettled([
    fetchDeterministic(loc), fetchEnsemble(loc), fetchSun(loc), inVeneto ? fetchArpav(zone.id) : Promise.reject(new Error('Fuori dal Veneto')), fetchPrevious(loc),
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
  const raw = { det: ok(det), ens: ok(ens), sun: ok(sun), arpav: ok(arp), prev: ok(prev) };
  store.set(LS_CACHE, { at: Date.now(), locName: loc.name, raw });
  const warn = [];
  if (!raw.arpav && inVeneto) warn.push('bollettino ARPAV non disponibile');
  if (!raw.ens) warn.push('ensemble non disponibile');
  setStatus(warn.length ? `Dati parziali: ${warn.join(', ')}` : '', !!warn.length);
  render(raw, zone, inVeneto);
}

function render(raw, zone, inVeneto) {
  lastRender = [raw, zone, inVeneto];
  const det = raw.det ? Core.parseDeterministic(raw.det) : null;
  const ens = raw.ens ? Core.parseEnsemble(raw.ens) : null;
  const prev = raw.prev ? Core.parsePrevious(raw.prev) : null;
  const res = Core.analyse({ det, ens, prev, sun: raw.sun, arpav: raw.arpav, load: loadType });
  renderLoadPicker();
  renderDayBar(res);
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
    const card = el('article', { id: `day-${day.date}`, class: `day v-${v.key}${best && day.date === best.date ? ' best' : ''}` });

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
              el('div', { class: 'slot-r' }, `Pioggia ${e.rainPerc}%`, e.tmax && !e.tLabel ? ` · ${e.tmin ? e.tmin + '…' : ''}${e.tmax}°` : ''),
              e.att ? el('div', { class: 'slot-a' }, `attendibilità ${e.att.toLowerCase()}`) : null))),
        ));
      } else {
        card.append(el('div', { class: 'arpav none' }, el('span', { class: 'src' }, 'ARPAV'), 'Bollettino ufficiale non ancora disponibile per questo giorno'));
      }

      // metrics
      card.append(el('dl', { class: 'metrics' },
        metric('Prob. pioggia', pct(day.P), day.shares ? sharesText(day.shares) : '–'),
        metric('Temperatura', day.tMax != null ? `${Math.round(day.tMin)}–${Math.round(day.tMax)}°` : '–', 'min–max nella finestra'),
        metric('Modelli con pioggia', day.Pdet != null ? pct(day.Pdet) : '–', `${day.perModel.length} modelli`),
        metric('Asciugatura', day.dryAt ? `entro le ${fmtH(day.dryAt)}` : `${Math.round(day.dryFrac * 100)}%`, `finestra ${fmtH(day.start)}–${fmtH(day.end)}`),
        metric('Umidità', day.rhMean != null ? `${Math.round(day.rhMean)}%` : '–', 'media nella finestra'),
        metric('Raffiche', day.gust != null ? `${Math.round(day.gust)} km/h` : '–', 'max nella finestra'),
      ));

      card.append(ensembleBox(day));
      card.append(hourStrip(day));
      if (day.conf) card.append(confLine(day));

      // details per model
      const tbl = el('table', { class: 'models' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Modello'), el('th', {}, 'Ris.'), el('th', {}, 'Peso'), el('th', {}, 'Pioggia (mm)'), el('th', {}, 'Asciug.'), el('th', {}, 'Raffica'))),
        el('tbody', {}, [...day.perModel].sort((a, b) => b.w - a.w).map(m => el('tr', {},
          el('td', {}, m.name), el('td', {}, m.res), el('td', {}, m.w.toFixed(1).replace('.', ',')), el('td', {}, m.rainSum.toFixed(1)),
          el('td', {}, `${Math.round(Math.min(1, m.cum / day.target) * 100)}%`),
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
  if (!inVeneto) { box.hidden = false; box.append(el('p', { class: 'muted' }, 'ARPAV copre solo il Veneto: per questa località si usano solo i modelli.')); return; }
  if (!arpav?.text) { box.hidden = true; return; }
  box.hidden = false;
  const t = arpav.text, today = Core.todayYMD();
  box.append(el('div', { class: 'ab-head' },
    el('span', { class: 'src' }, 'ARPAV · PREVISIONE UFFICIALE'),
    el('h2', {}, t.name),
    el('p', { class: 'muted small' }, [t.title, arpav.updated ? `aggiornamento ${arpav.updated}` : null].filter(Boolean).join(' · '))));
  if (t.avviso) box.append(el('div', { class: 'ab-alert' }, el('b', {}, '⚠ Avviso: '), t.avviso));
  if (t.fenomeni) box.append(el('div', { class: 'ab-alert warn' }, el('b', {}, 'Fenomeni particolari: '), t.fenomeni));
  if (t.evol) box.append(el('div', { class: 'ab-evol' }, el('h3', {}, 'Situazione generale'), el('p', {}, t.evol)));

  let shown = 0;
  for (const g of t.days) {
    if (g.date && g.date < today) continue;                     // yesterday's afternoon slot
    const d = g.date ? Math.round((Date.parse(g.date) - Date.parse(today)) / 864e5) : null;
    const secs = g.sections || [];
    const lead = secs[0];
    const det = el('details', { class: 'ab-day' });
    if (shown++ < 2) det.open = true;
    det.append(el('summary', {},
      el('div', { class: 'ab-sum' },
        el('span', { class: 'ab-dayname' }, g.date ? `${dayName(g.date, d)} ${dateShort(g.date)}` : g.data),
        g.attendibilita ? el('span', { class: `badge ${reliabilityClass(g.attendibilita)}` }, `Attendibilità ${g.attendibilita.toLowerCase()}`) : null),
      lead ? el('div', { class: 'ab-preview' }, lead.text) : null));
    if (g.maps?.length) {
      det.append(el('div', { class: 'ab-maps' }, g.maps.map(m => el('a', { href: m.src, target: '_blank', rel: 'noopener' },
        el('img', { src: m.src, alt: `Mappa ARPAV ${m.caption}`, loading: 'lazy' }),
        el('span', {}, m.caption.replace(/^\d+\s+\S+\s*/, '') || 'mappa')))));
    }
    det.append(el('dl', { class: 'ab-secs' }, secs.map(sx => el('div', { class: 'ab-sec' },
      el('dt', {}, el('span', { class: 'ab-ico', 'aria-hidden': 'true' }, sectionIcon(sx.label)), shortLabel(sx.label)),
      el('dd', {}, sx.text)))));
    if (g.previsore) det.append(el('p', { class: 'muted small' }, `Previsore: ${g.previsore}`));
    box.append(det);
  }
}

function sectionIcon(label) {
  const l = label.toLowerCase();
  if (/precip/.test(l)) return '🌧';
  if (/temperat/.test(l)) return '🌡';
  if (/vent/.test(l)) return '💨';
  if (/mare/.test(l)) return '🌊';
  if (/neve|zero termico/.test(l)) return '❄';
  return '🌤';
}
const shortLabel = l => (/^tendenza/i.test(l) ? 'Tendenza' : /^previsione/i.test(l) ? 'Previsione' : l || 'Previsione');
const reliabilityClass = a => (/ottima|buona|alta/i.test(a) ? 'ok' : /discreta|media/i.test(a) ? 'mid' : 'low');

// Sticky top bar: the 5 days with their scores, always visible.
function renderDayBar({ days, best }) {
  const bar = $('#daybar'); bar.replaceChildren();
  for (const day of days) {
    const v = day.lateToday ? { key: 'na' } : Core.verdict(day.score, day.dryFrac);
    const isBest = best && day.date === best.date;
    const label = day.d === 0 ? 'Oggi' : day.d === 1 ? 'Domani' : shortWeekday(day.date);
    bar.append(el('button', {
      type: 'button', class: `db-item v-${v.key}${isBest ? ' best' : ''}`,
      'aria-label': `${label} ${dateShort(day.date)}: punteggio ${day.lateToday ? 'non disponibile' : day.score}`,
      onclick: () => document.getElementById(`day-${day.date}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
    },
      el('span', { class: 'db-day' }, label),
      el('span', { class: 'db-date' }, dateShort(day.date)),
      el('span', { class: 'db-score' }, day.lateToday || day.score == null ? '–' : String(day.score)),
      el('span', { class: 'db-best' }, isBest ? '★ migliore' : ' ')));
  }
}
const shortWeekday = ymd => { const [y, m, d] = ymd.split('-').map(Number); const s = new Date(Date.UTC(y, m - 1, d, 12)).toLocaleDateString('it-IT', { weekday: 'short', timeZone: 'UTC' }); return s.charAt(0).toUpperCase() + s.slice(1).replace('.', ''); };

// Ensemble box: one dot per scenario, blue = rain while the laundry is out.
function ensembleBox(day) {
  const box = el('div', { class: 'ens' });
  if (day.Pens == null) {
    box.append(el('div', { class: 'ens-head' }, el('b', {}, 'Ensemble'), el('span', { class: 'muted' }, ' non disponibile per questo giorno')));
    return box;
  }
  const head = day.nWet === 0 ? `Nessuno dei ${day.nMem} scenari prevede pioggia`
    : day.nWet === day.nMem ? `Tutti i ${day.nMem} scenari prevedono pioggia`
    : `${day.nWet} scenari su ${day.nMem} prevedono pioggia`;
  box.append(el('div', { class: 'ens-head' },
    el('div', {}, el('div', { class: 'ens-kicker' }, 'ENSEMBLE · SCENARI POSSIBILI'), el('b', {}, head),
      el('div', { class: 'ens-sub' }, 'probabilità pesata per affidabilità del sistema a questa scadenza')),
    el('span', { class: `ens-pct ${day.Pens >= 0.5 ? 'hi' : day.Pens >= 0.2 ? 'mid' : 'lo'}` }, pct(day.Pens))));
  for (const src of day.ensBy) {
    const dots = el('div', { class: 'dots', 'aria-hidden': 'true' });
    for (let i = 0; i < src.n; i++) dots.append(el('i', { class: i < src.wet ? 'wet' : '' }));
    box.append(el('div', { class: 'ens-row' },
      el('span', { class: 'ens-src' }, src.name, el('small', {}, `${src.wet}/${src.n} · peso ${Math.round(src.wn * 100)}%`)), dots));
  }
  let amount = '';
  if (day.wetMeanMm != null) {
    const mm = day.wetMeanMm;
    const kind = mm < 1 ? 'qualche goccia' : mm < 5 ? 'pioggia debole' : mm < 15 ? 'pioggia moderata' : 'pioggia forte';
    amount = ` Negli scenari piovosi cadono in media ${mm.toFixed(1).replace('.', ',')} mm (${kind}).`;
  }
  box.append(el('p', { class: 'ens-note' },
    el('span', { class: 'legend-dot wet' }), 'pioggia mentre il bucato è steso  ',
    el('span', { class: 'legend-dot' }), 'asciutto.', amount));
  box.append(el('details', { class: 'ens-why' }, el('summary', {}, 'Cos’è un ensemble?'),
    el('p', {}, 'Invece di una sola previsione, i centri meteo fanno girare lo stesso modello decine di volte, ' +
      'ogni volta con condizioni iniziali leggermente diverse, per tener conto dell’incertezza. Ogni pallino è uno di questi scenari: ' +
      'blu se piove (≥0,3 mm) durante la finestra di stesura.'),
    el('p', {}, 'Per oggi e domani pesano di più gli ensemble ad alta risoluzione (ICON-D2 del servizio tedesco, ICON-CH1/CH2 di MeteoSvizzera, 1–2 km), ' +
      'che descrivono meglio rilievi, nebbie e rovesci locali; dal terzo giorno pesa di più l’ensemble ECMWF, il più affidabile a medio termine. ' +
      'La percentuale è la media pesata delle probabilità dei singoli sistemi.')));
  return box;
}

function sharesText(sh) {
  const p = [];
  if (sh.arpav) p.push(`ARPAV ${Math.round(sh.arpav * 100)}%`);
  if (sh.ens) p.push(`ens. ${Math.round(sh.ens * 100)}%`);
  if (sh.det) p.push(`modelli ${Math.round(sh.det * 100)}%`);
  return p.join(' · ');
}

function confLine(day) {
  const notes = [...(day.confNotes || [])];
  if (day.lamShare > 0.5 && day.d <= 1) notes.push('modelli ad alta risoluzione');
  if (day.fogArpav) notes.push('prevista nebbia/nubi basse');
  const line = el('div', { class: `conf c-${day.conf}` }, el('b', {}, `Affidabilità ${day.conf}`), notes.length ? ` · ${notes.join(' · ')}` : '');
  if (day.jump != null && day.jump >= 0.2) {
    line.append(el('div', { class: 'conf-jump' },
      `Ieri i modelli davano pioggia nel ${pct(day.PdetPrev)} dei casi, oggi nel ${pct(day.Pdet)}: previsione in evoluzione, ricontrolla più tardi.`));
  }
  return line;
}

// Load type selector (changes the amount of water to evaporate)
function renderLoadPicker() {
  const box = $('#load'); if (!box) return;
  box.replaceChildren(el('span', { class: 'load-l' }, 'Bucato:'),
    ...Object.entries(Core.LOADS).map(([k, v]) => el('button', {
      type: 'button', class: k === loadType ? 'on' : '', 'aria-pressed': String(k === loadType), title: v.desc,
      onclick: () => { loadType = k; store.set(LS_LOAD, k); if (lastRender) render(...lastRender); },
    }, v.label)));
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
