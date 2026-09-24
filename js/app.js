// Orchestration : formulaire → présélection des spots → météo → trajets → score → affichage.

import { PROFILES, DEFAULTS, COST_DEFAULTS, SCORE_WEIGHTS, LIMITS } from './config.js';
import { haversineKm, SECTORS, SECTOR_ANGLE, formatOrientations } from './geo.js';
import { evaluateDay, travelScore, globalScore, verdictOf } from './scoring.js';
import { weatherKey, chooseModels, fetchWeather, dominantModel } from './weather.js';
import {
  searchCommunes,
  cityLabel,
  roadGuessHours,
  carRoutes,
  carCost,
  trainEstimate,
  sncfJourney,
  mapsLink,
} from './transport.js';

const $ = (id) => document.getElementById(id);
const TZ = 'Europe/Paris';
const VERDICT_LABEL = { go: 'Go', jouable: 'Jouable', non: 'Passe ton chemin' };
const MODE_LABEL = { car: 'voiture', train: 'train', best: 'le plus rapide' };
const REASON_SHORT = {
  rain: 'pluie',
  thunder: 'orage',
  fog: 'brouillard',
  wind: 'vent fort',
  gust: 'rafales',
  turbulence: 'turbulent',
  wind850: 'vent en altitude',
  cloud: 'dans le nuage',
  orientation: 'mal orienté',
  nodata: 'pas de données',
};
const PAGE_SIZE = 25;

const state = {
  spots: null,
  meta: null,
  origin: { ...DEFAULTS.city },
  cityOptions: [],
  run: null,
  map: null,
  markers: null,
  markerById: new Map(),
  last: null,
};

// ---------- Stockage local (toujours protégé : il peut être indisponible) ----------

const store = {
  get(k) {
    try {
      return JSON.parse(localStorage.getItem(k));
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      localStorage.setItem(k, JSON.stringify(v));
    } catch {
      /* navigation privée : on s'en passe */
    }
  },
};

// ---------- Dates et formats ----------

const isoDate = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);
const parisHour = () =>
  Number(new Intl.DateTimeFormat('fr-FR', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ }).format(new Date()));
const nf = new Intl.NumberFormat('fr-FR');

function dayOptions() {
  const fmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: TZ });
  const precision = ['haute précision', 'haute précision', 'haute précision le matin', 'précision moyenne', 'précision moyenne', 'tendance', 'tendance'];
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.now() + i * 86400000);
    const prefix = i === 0 ? "Aujourd'hui, " : i === 1 ? 'Demain, ' : '';
    return { value: isoDate(d), label: `${prefix}${fmt.format(d)} · ${precision[i]}` };
  });
}

function longDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  );
}

function fmtDuration(h) {
  const min = Math.round(h * 60);
  if (min < 60) return `${min}\u00a0min`;
  return `${Math.floor(min / 60)}\u00a0h\u00a0${String(min % 60).padStart(2, '0')}`;
}

const fmtEuro = (x) => `≈\u00a0${nf.format(Math.round(x))}\u00a0€`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Formulaire ----------

function initForm() {
  const days = dayOptions();
  $('date').innerHTML = days.map((d) => `<option value="${d.value}">${esc(d.label)}</option>`).join('');
  $('profile').innerHTML = Object.entries(PROFILES)
    .map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`)
    .join('');
  const hours = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  $('windowStart').innerHTML = hours(6, 20).map((h) => `<option value="${h}">${h}h</option>`).join('');
  $('windowEnd').innerHTML = hours(8, 22).map((h) => `<option value="${h}">${h}h</option>`).join('');

  // Priorité : lien partagé (#…) > derniers réglages > valeurs par défaut.
  const saved = { ...(store.get('deco-radar-settings') ?? {}), ...fromHash() };
  const s = { ...DEFAULTS, ...COST_DEFAULTS, points: LIMITS.weatherPointsPerRun, meteoWeight: 60, ...saved };
  if (saved.city?.lat) state.origin = saved.city;
  $('city').value = cityLabel(state.origin);
  const defaultDay = parisHour() < 15 ? days[0].value : days[1].value;
  $('date').value = days.some((d) => d.value === s.date) ? s.date : defaultDay;
  $('mode').value = s.mode;
  $('maxHours').value = s.maxHours;
  $('profile').value = PROFILES[s.profile] ? s.profile : DEFAULTS.profile;
  $('windowStart').value = s.windowStart;
  $('windowEnd').value = s.windowEnd;
  $('passengers').value = s.passengers;
  $('fuelPrice').value = s.fuelPrice;
  $('consumption').value = s.consumption;
  $('tolls').checked = s.tolls;
  $('meteoWeight').value = s.meteoWeight;
  $('points').value = s.points;
  $('sncfKey').value = store.get('deco-radar-sncf-key') ?? '';
  syncOutputs();

  $('maxHours').addEventListener('input', syncOutputs);
  $('meteoWeight').addEventListener('input', syncOutputs);
  $('city').addEventListener('input', onCityInput);
  $('search').addEventListener('submit', (e) => {
    e.preventDefault();
    analyse();
  });
}

function syncOutputs() {
  $('maxHours-out').textContent = `${String($('maxHours').value).replace('.', ',')} h`;
  $('meteoWeight-out').textContent = `${$('meteoWeight').value} %`;
}

function readForm() {
  let windowStart = Number($('windowStart').value);
  let windowEnd = Number($('windowEnd').value);
  if (windowEnd <= windowStart) [windowStart, windowEnd] = [windowEnd, windowStart + 1];
  const num = (id, min, max, dflt) => {
    const v = Number($(id).value);
    return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
  };
  return {
    date: $('date').value,
    mode: $('mode').value,
    maxHours: Number($('maxHours').value),
    profile: $('profile').value,
    windowStart,
    windowEnd,
    passengers: Math.round(num('passengers', 1, 5, 1)),
    fuelPrice: num('fuelPrice', 0.5, 4, COST_DEFAULTS.fuelPrice),
    consumption: num('consumption', 2, 20, COST_DEFAULTS.consumption),
    tolls: $('tolls').checked,
    meteoWeight: Number($('meteoWeight').value),
    points: Math.round(num('points', 30, 600, LIMITS.weatherPointsPerRun)),
    sncfKey: $('sncfKey').value.trim(),
  };
}

function fromHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  if (!p.size) return {};
  const out = {};
  if (p.get('lat') && p.get('lon')) {
    out.city = { name: p.get('ville') ?? '?', dept: p.get('dep') ?? '', lat: Number(p.get('lat')), lon: Number(p.get('lon')) };
  }
  if (p.get('date')) out.date = p.get('date');
  if (p.get('mode')) out.mode = p.get('mode');
  if (p.get('max')) out.maxHours = Number(p.get('max'));
  if (p.get('niveau')) out.profile = p.get('niveau');
  if (p.get('de')) out.windowStart = Number(p.get('de'));
  if (p.get('a')) out.windowEnd = Number(p.get('a'));
  return out;
}

function saveSettings(s) {
  const { sncfKey, ...rest } = s;
  store.set('deco-radar-settings', { ...rest, city: state.origin });
  store.set('deco-radar-sncf-key', sncfKey);
  const p = new URLSearchParams({
    ville: state.origin.name,
    dep: state.origin.dept,
    lat: state.origin.lat.toFixed(4),
    lon: state.origin.lon.toFixed(4),
    date: s.date,
    mode: s.mode,
    max: s.maxHours,
    niveau: s.profile,
    de: s.windowStart,
    a: s.windowEnd,
  });
  history.replaceState(null, '', `#${p}`);
}

let cityTimer;
function onCityInput() {
  clearTimeout(cityTimer);
  const q = $('city').value.trim();
  const picked = state.cityOptions.find((c) => cityLabel(c) === q);
  if (picked) {
    state.origin = picked;
    return;
  }
  if (q.length < 2) return;
  cityTimer = setTimeout(async () => {
    try {
      state.cityOptions = await searchCommunes(q);
      $('city-list').innerHTML = state.cityOptions.map((c) => `<option value="${esc(cityLabel(c))}"></option>`).join('');
    } catch {
      /* l'autocomplétion est un confort : on ignore ses erreurs */
    }
  }, 250);
}

async function resolveOrigin(signal) {
  const q = $('city').value.trim();
  if (q === cityLabel(state.origin)) return state.origin;
  const picked = state.cityOptions.find((c) => cityLabel(c).toLowerCase() === q.toLowerCase());
  if (picked) return (state.origin = picked);
  const found = await searchCommunes(q.replace(/\s*\(\w+\)$/, ''), signal);
  if (!found.length) throw new Error(`Ville introuvable : « ${q} ». Choisis une commune dans la liste.`);
  state.origin = found[0];
  $('city').value = cityLabel(found[0]);
  return found[0];
}

// ---------- Données des spots ----------

async function ensureSpots() {
  if (state.spots) return;
  const res = await fetch('data/spots.json');
  if (!res.ok) throw new Error('Impossible de charger la base des décollages (data/spots.json).');
  const data = await res.json();
  state.meta = data;
  state.spots = data.spots.filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lon));
  $('spots-attribution').textContent = data.attribution ?? `Décollages : ${data.source}`;
  const when = data.generatedAt ? new Date(data.generatedAt).toLocaleDateString('fr-FR') : '?';
  $('spots-meta').textContent = `${nf.format(state.spots.length)} décollages en base · source ${data.source} · mise à jour du ${when}`;
}

// ---------- Analyse ----------

function setStatus(text, pct, count = '') {
  $('status').hidden = false;
  $('status-text').textContent = text;
  $('status-count').textContent = count;
  if (pct != null) $('progress').value = pct;
}

/** Nouvelle analyse complète à partir du formulaire. */
async function analyse() {
  const s = readForm();
  const ctx = {
    s,
    cost: { ...COST_DEFAULTS, passengers: s.passengers, fuelPrice: s.fuelPrice, consumption: s.consumption, tolls: s.tolls },
    weights: { ...SCORE_WEIGHTS, meteo: s.meteoWeight / 100, trajet: 1 - s.meteoWeight / 100 },
    profile: PROFILES[s.profile],
    win: { start: s.windowStart, end: s.windowEnd },
    analysed: [],
    queue: [],
    routeNote: '',
    sncfDone: 0,
  };
  await run('Relancer', async (signal) => {
    setStatus('Chargement des décollages…', 2);
    await ensureSpots();
    setStatus('Ville de départ…', 5);
    ctx.origin = await resolveOrigin(signal);
    saveSettings(s);

    ctx.isToday = s.date === isoDate(new Date());
    ctx.fromHour = ctx.isToday ? parisHour() : 0;
    if (ctx.isToday && ctx.fromHour >= ctx.win.end - 1) {
      throw new Error("Le créneau de vol d'aujourd'hui est presque terminé : choisis demain.");
    }

    // 1. Présélection grossière par distance, puis regroupement par maille météo (du plus proche au plus loin).
    const cands = [];
    for (const spot of state.spots) {
      const crow = haversineKm(ctx.origin, spot);
      const carGuess = roadGuessHours(crow);
      const trainGuess = spot.station ? trainEstimate(ctx.origin, spot, ctx.cost).hours : Infinity;
      const guess = s.mode === 'car' ? carGuess : s.mode === 'train' ? trainGuess : Math.min(carGuess, trainGuess);
      if (guess <= s.maxHours * 1.15) cands.push({ spot, crow, guess });
    }
    if (!cands.length) {
      throw new Error(`Aucun décollage à moins de ${String(s.maxHours).replace('.', ',')} h de ${cityLabel(ctx.origin)} en ${MODE_LABEL[s.mode]}.`);
    }
    cands.sort((a, b) => a.guess - b.guess);
    const groups = new Map();
    for (const c of cands) {
      c.key = weatherKey(c.spot);
      if (!groups.has(c.key)) groups.set(c.key, { point: { key: c.key, lat: c.spot.lat, lon: c.spot.lon, alt: c.spot.alt }, cands: [] });
      groups.get(c.key).cands.push(c);
    }
    ctx.queue = [...groups.values()];

    // 2. Choix des modèles météo disponibles pour cette date, puis premier lot de spots.
    setStatus('Choix du modèle météo…', 8);
    ctx.chain = await chooseModels(ctx.queue[0].point, s.date, ctx.win, signal, (sec) =>
      setStatus(`Quota gratuit d'Open-Meteo : reprise dans ${sec} s…`, null),
    );
    await processNext(ctx, signal);
    state.last = ctx;
  });
}

/** Lot suivant : spots plus lointains laissés de côté par la limite de points météo. */
async function analyseMore() {
  const ctx = state.last;
  if (!ctx?.queue.length) return;
  await run('Relancer', (signal) => processNext(ctx, signal));
}

/** Enveloppe commune : annulation de l'analyse précédente, bouton, erreurs, rendu. */
async function run(busyLabel, job) {
  state.run?.abort();
  const ctrl = new AbortController();
  state.run = ctrl;
  $('error').hidden = true;
  // Le bouton reste actif : un nouvel envoi annule l'analyse en cours et repart des réglages du moment.
  $('go-btn').textContent = busyLabel;
  document.querySelectorAll('.analyse-more').forEach((b) => (b.disabled = true));
  try {
    await job(ctrl.signal);
    setStatus('Terminé', 100);
    render();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    $('error').hidden = false;
    $('error').textContent = err.message || 'Erreur inattendue.';
    document.querySelectorAll('.analyse-more').forEach((b) => (b.disabled = false));
  } finally {
    if (state.run === ctrl) {
      $('go-btn').textContent = 'Analyser';
      setTimeout(() => ($('status').hidden = true), 600);
    }
  }
}

/** Météo, trajets et score pour les `points` prochaines mailles de la file d'attente. */
async function processNext(ctx, signal) {
  const { s, cost, weights, profile, win, origin, chain } = ctx;
  const chunk = ctx.queue.slice(0, s.points);
  const pts = chunk.map((g) => g.point);
  const batch = chunk.flatMap((g) => g.cands);

  const chainLabel = chain.map((m) => `${m.label} ${m.res}`).join(' + ');
  let progress = `0 / ${pts.length} points`;
  setStatus(`Prévisions ${chainLabel}…`, 10, progress);
  const weather = await fetchWeather(pts, s.date, chain, {
    signal,
    onProgress: (done, total) => {
      progress = `${done} / ${total} points`;
      setStatus(`Prévisions ${chainLabel}…`, 10 + (60 * done) / total, progress);
    },
    onWait: (sec) => setStatus(`Quota gratuit d'Open-Meteo : reprise dans ${sec} s…`, null, progress),
  });

  for (const c of batch) {
    const hours = (weather.get(c.key) ?? []).filter((h) => h.hour >= win.start && h.hour < win.end && h.hour >= ctx.fromHour);
    c.day = evaluateDay(hours, c.spot, profile);
    c.model = dominantModel(hours);
  }

  // Trajets : route réelle (OSRM), train estimé, puis horaires SNCF réels si clé fournie.
  if (s.mode !== 'train') {
    setStatus('Itinéraires routiers…', 75);
    try {
      const routes = await carRoutes(origin, batch.map((c) => c.spot), signal);
      for (const c of batch) {
        const r = routes.get(c.spot.id);
        c.car = r ? { ...r, euros: carCost(r.km, cost), estimated: false } : null;
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      ctx.routeNote = "Le serveur d'itinéraires ne répond pas : temps de route estimés à vol d'oiseau.";
      for (const c of batch) {
        const km = c.crow * 1.3;
        c.car = { hours: roadGuessHours(c.crow), km, euros: carCost(km, cost), estimated: true };
      }
    }
  }
  for (const c of batch) {
    c.train = trainEstimate(origin, c.spot, cost);
    scoreSpot(c, s, weights);
  }
  // La file n'est vidée qu'une fois le lot entièrement traité : une analyse annulée peut reprendre.
  ctx.queue.splice(0, chunk.length);
  ctx.analysed.push(...batch);

  if (s.sncfKey && s.mode !== 'car' && ctx.sncfDone < LIMITS.sncfTop) {
    const top = ctx.analysed
      .filter((c) => c.day.flyable && c.train?.estimated && !c.sncfTried && !c.outOfRange)
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMITS.sncfTop - ctx.sncfDone);
    let done = 0;
    for (const c of top) {
      setStatus('Horaires SNCF…', 85 + (10 * done) / top.length, `${done} / ${top.length}`);
      c.sncfTried = true;
      try {
        c.train = (await sncfJourney(origin, c.spot, s.date, s.sncfKey, cost, signal)) ?? c.train;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        ctx.routeNote = `${ctx.routeNote} API SNCF : ${err.message}.`.trim();
        ctx.sncfDone = LIMITS.sncfTop;
        break;
      }
      scoreSpot(c, s, weights);
      ctx.sncfDone++;
      done++;
    }
  }
}

/** Motif affiché pour un spot « Passe ton chemin ». */
function reasonOf(c) {
  if (c.day.mainReason) return c.day.mainReason;
  return `Volable, mais score ${c.score}/100 (météo ${c.day.meteoScore}, trajet ${c.travelScore})`;
}

function scoreSpot(c, s, weights) {
  const options = [c.car, c.train].filter(Boolean);
  c.travel = s.mode === 'car' ? c.car : s.mode === 'train' ? c.train : options.sort((a, b) => a.hours - b.hours)[0] ?? null;
  c.travelKind = c.travel === c.car ? 'car' : 'train';
  c.outOfRange = !c.travel || c.travel.hours > s.maxHours;
  c.travelScore = travelScore(c.travel ?? {}, weights);
  c.score = globalScore(c.day, c.travelScore, weights);
  c.verdict = verdictOf(c.score, c.day);
}

// ---------- Affichage ----------

function render() {
  const { s, origin, analysed, queue, chain, routeNote, fromHour, isToday } = state.last;
  const skipped = queue.reduce((n, g) => n + g.cands.length, 0);
  const inRange = analysed.filter((c) => !c.outOfRange);
  const outCount = analysed.length - inRange.length;
  const ok = inRange.filter((c) => c.verdict !== 'non').sort((a, b) => b.score - a.score);
  const ko = inRange.filter((c) => c.verdict === 'non').sort((a, b) => a.travel.hours - b.travel.hours);
  const n = { go: ok.filter((c) => c.verdict === 'go').length, jouable: ok.filter((c) => c.verdict === 'jouable').length, non: ko.length };

  const notes = [
    `${nf.format(inRange.length)} décollages analysés à moins de ${String(s.maxHours).replace('.', ',')} h.`,
    skipped ? `${nf.format(skipped)} plus lointains pas encore analysés (limite de ${s.points} points météo par lot).` : '',
    outCount ? `${nf.format(outCount)} écartés car le trajet réel dépasse ${String(s.maxHours).replace('.', ',')} h.` : '',
    isToday ? `Aujourd'hui : seules les heures à partir de ${Math.max(fromHour, s.windowStart)}h comptent.` : '',
    routeNote,
  ].filter(Boolean);
  $('summary').innerHTML = `
    <div class="counts">
      <span class="pill go">${n.go} Go</span>
      <span class="pill jouable">${n.jouable} Jouable</span>
      <span class="pill non">${n.non} Passe ton chemin</span>
    </div>
    <div class="meta">${esc(longDate(s.date))} · ${s.windowStart}h–${s.windowEnd}h · départ ${esc(cityLabel(origin))} · ${MODE_LABEL[s.mode]} · ${esc(PROFILES[s.profile].label)}</div>
    <span class="pill model" title="Modèles Open-Meteo utilisés, du plus précis au plus grossier">Météo : ${esc(chain.map((m) => `${m.label} ${m.res}`).join(' → '))}</span>
    <p class="note">${esc(notes.join(' '))}</p>
    ${skipped ? `<button type="button" class="ghost analyse-more">Analyser plus loin (${nf.format(Math.min(skipped, queue.slice(0, s.points).reduce((n, g) => n + g.cands.length, 0)))} décos)</button>` : ''}`;
  $('summary').querySelector('.analyse-more')?.addEventListener('click', analyseMore);

  const cards = $('cards');
  cards.innerHTML = '';
  if (!ok.length) {
    cards.innerHTML = `<p class="panel empty">Aucun décollage volable pour ces critères. Essaie un autre jour, un trajet plus long ou un créneau différent.</p>`;
  }
  const showPage = (from) => {
    ok.slice(from, from + PAGE_SIZE).forEach((c) => cards.append(card(c, origin, s)));
    if (from + PAGE_SIZE < ok.length) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'ghost more';
      more.textContent = `Afficher ${Math.min(PAGE_SIZE, ok.length - from - PAGE_SIZE)} spots de plus`;
      more.style.marginTop = '16px';
      more.addEventListener('click', () => {
        more.remove();
        showPage(from + PAGE_SIZE);
      });
      cards.append(more);
    }
  };
  showPage(0);

  $('eliminated').hidden = !ko.length;
  $('eliminated-title').textContent = `Passe ton chemin (${ko.length})`;
  $('eliminated-list').innerHTML = ko
    .map(
      (c) => `<li>
        <span><button type="button" data-id="${esc(c.spot.id)}">${esc(c.spot.name)}</button>
        <span class="muted"> · ${esc(c.spot.city ?? '')} · ${fmtDuration(c.travel.hours)}</span></span>
        <span class="reason">${esc(reasonOf(c))}</span>
      </li>`,
    )
    .join('');

  $('results').hidden = false;
  renderMap(origin, inRange);
}

function card(c, origin, s) {
  const node = $('card-tpl').content.firstElementChild.cloneNode(true);
  const { spot, day } = c;
  node.id = `spot-${cssId(spot.id)}`;
  node.classList.add(c.verdict);
  node.querySelector('.score').textContent = c.score;
  node.querySelector('h3').textContent = spot.name;
  const orient = formatOrientations(spot.orient) || '?';
  node.querySelector('.where').textContent = [
    spot.city && `${spot.city}${spot.dept ? ` (${spot.dept})` : ''}`,
    spot.alt != null && `${nf.format(spot.alt)}\u00a0m`,
    `déco ${orient}${spot.orientOk?.length ? ` (${formatOrientations(spot.orientOk)} possible)` : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');
  const pill = node.querySelector('.verdict');
  pill.textContent = VERDICT_LABEL[c.verdict];
  pill.classList.add(c.verdict);

  const b = day.block;
  node.querySelector('.rose').innerHTML = roseSvg(spot, b.dirDeg);
  node.querySelector('.facts').innerHTML = [
    `<li>Volable <b>${flyableRanges(day.evaluated)}</b> · <span class="nw">idéal ${b.start}h–${b.end}h</span></li>`,
    `<li>Vent <b>${b.wind}\u00a0km/h</b> de ${b.dir} · rafales ${b.gust}</li>`,
    `<li>Nuages ${b.cloud}\u00a0%${b.wind850 != null ? ` · ${b.wind850}\u00a0km/h vers 1\u00a0500\u00a0m` : ''}</li>`,
    c.model ? `<li class="muted">Prévision ${esc(c.model.label)} ${esc(c.model.res)}</li>` : '',
  ].join('');

  node.querySelector('.travel').innerHTML = travelLines(c, s);
  if (day.warnings.length) {
    const w = node.querySelector('.warn');
    w.hidden = false;
    w.textContent = day.warnings.join(' · ');
  }
  node.querySelector('.bars').innerHTML = bar('Météo', day.meteoScore) + bar('Trajet', c.travelScore);
  node.querySelector('.table-wrap').innerHTML = hourlyTable(day.evaluated);

  const links = [
    `<a href="${mapsLink(origin, spot, c.travelKind)}" target="_blank" rel="noopener">Itinéraire</a>`,
    spot.url ? `<a href="${esc(spot.url)}" target="_blank" rel="noopener">Fiche du site</a>` : '',
    `<a href="https://www.windy.com/?arome,${spot.lat.toFixed(3)},${spot.lon.toFixed(3)},12" target="_blank" rel="noopener">Windy (AROME)</a>`,
    `<a href="https://www.meteoblue.com/fr/meteo/semaine/${spot.lat.toFixed(3)}N${spot.lon.toFixed(3)}E" target="_blank" rel="noopener">Meteoblue</a>`,
  ];
  node.querySelector('.links').innerHTML = links.join('');
  return node;
}

const CAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 17h14v-5l-2-5H7l-2 5v5z"/><path d="M5 12h14"/><circle cx="8" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/></svg>';
const TRAIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3" width="12" height="13" rx="3"/><path d="M6 10h12M9 20l-2 2M15 20l2 2M9 16v4M15 16v4"/></svg>';

function travelLines(c, s) {
  const perPers = s.passengers > 1 ? ' / pers.' : '';
  const lines = [];
  if (s.mode !== 'train') {
    lines.push(
      c.car
        ? `<li class="${c.travelKind === 'car' ? 'chosen' : ''}">${CAR_ICON}<span><b>${fmtDuration(c.car.hours)}</b> · ${nf.format(Math.round(c.car.km))}\u00a0km · ${fmtEuro(c.car.euros)} A/R${perPers}${c.car.estimated ? '<span class="tag">estimation</span>' : ''}</span></li>`
        : `<li>${CAR_ICON}<span>Pas d'itinéraire routier trouvé</span></li>`,
    );
  }
  if (c.train) {
    const t = c.train;
    const detail = t.estimated
      ? '<span class="tag">estimation</span>'
      : `<span class="tag">SNCF ${t.departure.slice(0, 2)}h${t.departure.slice(2)} → ${t.arrival.slice(0, 2)}h${t.arrival.slice(2)}, ${t.transfers} corresp.</span>`;
    lines.push(
      `<li class="${c.travelKind === 'train' ? 'chosen' : ''}">${TRAIN_ICON}<span><b>${t.estimated ? '≈ ' : ''}${fmtDuration(t.hours)}</b> · gare de ${esc(t.station.name)} à ${String(t.station.km).replace('.', ',')}\u00a0km (${t.lastMile}) · ${fmtEuro(t.euros)} A/R${detail}</span></li>`,
    );
  } else if (s.mode !== 'car') {
    lines.push(`<li>${TRAIN_ICON}<span>Pas de gare connue à proximité</span></li>`);
  }
  return lines.join('');
}

/** Plages d'heures volables : « 10h–12h, 14h–18h ». */
function flyableRanges(evaluated) {
  const ranges = [];
  for (const e of evaluated) {
    const last = ranges[ranges.length - 1];
    if (!e.ok) continue;
    if (last && last.end === e.hour) last.end = e.hour + 1;
    else ranges.push({ start: e.hour, end: e.hour + 1 });
  }
  return ranges.map((r) => `${r.start}h–${r.end}h`).join(', ');
}

function bar(label, value) {
  return `<div class="bar">${label} ${value}<div class="track"><div class="fill" style="width:${value}%"></div></div></div>`;
}

function hourlyTable(evaluated) {
  const rows = evaluated
    .map((e) => {
      const state = e.ok ? 'volable' : e.reasons.map((r) => REASON_SHORT[r]).join(', ');
      const dir = e.dir == null ? '–' : SECTORS[Math.round(e.dir / 45) % 8];
      const v = (x) => (x == null ? '–' : Math.round(x));
      return `<tr class="${e.ok ? 'ok' : 'ko'}"><td>${e.hour}h</td><td>${v(e.wind)}</td><td>${v(e.gust)}</td><td>${dir}</td><td>${v(e.wind850)}</td><td>${v(e.cloud)} %</td><td>${e.rain == null ? '–' : String(Math.round(e.rain * 10) / 10).replace('.', ',')}</td><td>${state}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Heure</th><th>Vent</th><th>Rafales</th><th>Dir.</th><th>1 500 m</th><th>Nuages</th><th>Pluie mm</th><th>État</th></tr></thead><tbody>${rows}</tbody></table>`;
}

const cssId = (id) => id.replace(/[^a-z0-9_-]/gi, '-');

/** Rose des vents : secteurs favorables (vert), possibles (vert clair) et flèche du vent prévu. */
function roseSvg(spot, windDir) {
  const c = 50;
  const r = 36;
  const pt = (deg, rr) => [c + rr * Math.sin((deg * Math.PI) / 180), c - rr * Math.cos((deg * Math.PI) / 180)];
  const f = (n) => n.toFixed(1);
  let svg = '';
  for (const sec of SECTORS) {
    const a = SECTOR_ANGLE[sec];
    const [x1, y1] = pt(a - 22.5, r);
    const [x2, y2] = pt(a + 22.5, r);
    const cls = spot.orient?.includes(sec) ? 'good' : spot.orientOk?.includes(sec) ? 'ok' : 'none';
    svg += `<path class="${cls}" d="M${c} ${c}L${f(x1)} ${f(y1)}A${r} ${r} 0 0 1 ${f(x2)} ${f(y2)}Z" stroke="var(--surface)" stroke-width="1.5"/>`;
  }
  for (const [sec, a] of [['N', 0], ['E', 90], ['S', 180], ['O', 270]]) {
    const [x, y] = pt(a, 44);
    svg += `<text x="${f(x)}" y="${f(y)}" text-anchor="middle" dominant-baseline="central">${sec}</text>`;
  }
  if (windDir != null) {
    // Le vent vient de windDir : la flèche traverse la rose dans le sens où il souffle.
    const down = windDir + 180;
    const u = [Math.sin((down * Math.PI) / 180), -Math.cos((down * Math.PI) / 180)];
    const tip = [c + u[0] * 27, c + u[1] * 27];
    const base = [tip[0] - u[0] * 10, tip[1] - u[1] * 10];
    const p = [-u[1] * 5, u[0] * 5];
    svg += `<path class="wind" d="M${f(c - u[0] * 27)} ${f(c - u[1] * 27)}L${f(base[0])} ${f(base[1])}"/>`;
    svg += `<path class="head" d="M${f(tip[0])} ${f(tip[1])}L${f(base[0] + p[0])} ${f(base[1] + p[1])}L${f(base[0] - p[0])} ${f(base[1] - p[1])}Z"/>`;
  }
  const label = `Orientations favorables : ${formatOrientations(spot.orient) || 'inconnues'}`;
  return `<svg viewBox="0 0 100 100" role="img" aria-label="${esc(label)}">${svg}</svg>`;
}

// ---------- Carte ----------

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function renderMap(origin, list) {
  if (!window.L) {
    document.querySelector('.map-col').hidden = true;
    return;
  }
  if (!state.map) {
    state.map = L.map('map', { zoomControl: true, scrollWheelZoom: true });
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 17,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(state.map);
    state.markers = L.layerGroup().addTo(state.map);
  }
  state.markers.clearLayers();
  state.markerById.clear();
  const color = { go: cssVar('--go-mark'), jouable: cssVar('--mid-mark'), non: cssVar('--no-mark') };
  // Les spots éliminés d'abord, pour que les « Go » restent au-dessus.
  const order = { non: 0, jouable: 1, go: 2 };
  for (const c of [...list].sort((a, b) => order[a.verdict] - order[b.verdict] || a.score - b.score)) {
    const m = L.circleMarker([c.spot.lat, c.spot.lon], {
      radius: c.verdict === 'go' ? 8 : c.verdict === 'jouable' ? 7 : 4.5,
      color: cssVar('--surface'),
      weight: 1.5,
      fillColor: color[c.verdict],
      fillOpacity: c.verdict === 'non' ? 0.55 : 0.95,
    });
    const detail = c.verdict === 'non' ? esc(reasonOf(c)) : `Score ${c.score} · ${c.day.block.start}h–${c.day.block.end}h`;
    const btn = c.verdict === 'non' ? '' : `<br><button type="button" data-card="${esc(c.spot.id)}">Voir la fiche</button>`;
    m.bindPopup(`<b>${esc(c.spot.name)}</b> <span class="pill ${c.verdict}">${VERDICT_LABEL[c.verdict]}</span><br>${detail}<br>${fmtDuration(c.travel.hours)} de trajet${btn}`);
    m.addTo(state.markers);
    state.markerById.set(c.spot.id, m);
  }
  L.circleMarker([origin.lat, origin.lon], { radius: 7, color: cssVar('--surface'), weight: 2, fillColor: cssVar('--accent'), fillOpacity: 1 })
    .bindTooltip(`Départ : ${esc(cityLabel(origin))}`)
    .addTo(state.markers);

  const focus = list.filter((c) => c.verdict !== 'non');
  const pts = (focus.length ? focus : list).map((c) => [c.spot.lat, c.spot.lon]).concat([[origin.lat, origin.lon]]);
  state.map.invalidateSize();
  state.map.fitBounds(pts, { padding: [24, 24], maxZoom: 10 });
}

function openCard(id) {
  const el = document.getElementById(`spot-${cssId(id)}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

document.addEventListener('click', (e) => {
  const cardBtn = e.target.closest('[data-card]');
  if (cardBtn) openCard(cardBtn.dataset.card);
  const koBtn = e.target.closest('#eliminated-list [data-id]');
  if (koBtn && state.map) {
    const m = state.markerById.get(koBtn.dataset.id);
    if (m) {
      document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
      state.map.setView(m.getLatLng(), 11);
      m.openPopup();
    }
  }
});

// ---------- Thème ----------

const THEMES = ['auto', 'light', 'dark'];
const THEME_LABEL = { auto: 'auto', light: 'clair', dark: 'sombre' };
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $('theme-toggle').textContent = `Thème : ${THEME_LABEL[t]}`;
}
function initTheme() {
  let t = store.get('deco-radar-theme') ?? 'auto';
  if (!THEMES.includes(t)) t = 'auto';
  applyTheme(t);
  $('theme-toggle').addEventListener('click', () => {
    t = THEMES[(THEMES.indexOf(t) + 1) % THEMES.length];
    store.set('deco-radar-theme', t);
    applyTheme(t);
    if (state.last) renderMap(state.last.origin, state.last.analysed.filter((c) => !c.outOfRange));
  });
}

initTheme();
initForm();
analyse();
