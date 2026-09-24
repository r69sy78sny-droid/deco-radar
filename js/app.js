// Orchestration : formulaire → destinations candidates → météo de leurs décos → trajets (Flixbus,
// train, voiture) → score → affichage.

import { PROFILES, DEFAULTS, COST_DEFAULTS, SCORE_WEIGHTS, LIMITS, FLIXBUS_ESTIMATE } from './config.js';
import { haversineKm, SECTORS, SECTOR_ANGLE, formatOrientations } from './geo.js';
import { evaluateDay, travelScore, globalScore, verdictOf } from './scoring.js';
import { weatherKey, chooseModels, fetchWeather, dominantModel } from './weather.js';
import {
  searchCommunes,
  cityLabel,
  roadGuessHours,
  carRoutes,
  carCostDetail,
  railEstimate,
  accessTo,
  sncfJourney,
  mapsLink,
} from './transport.js';
import { summarizeDestination } from './destinations.js';
import { loadFares, trainFares, FARE_PROFILES, SNCF_CONNECT } from './fares.js';
import { findFlixbusCity, flixbusRoundTrip, flixbusLink, rideTime } from './flixbus.js';

const $ = (id) => document.getElementById(id);
const TZ = 'Europe/Paris';
const VERDICT_LABEL = { go: 'Go', jouable: 'Jouable', non: 'Passe ton chemin' };
const MODE_LABEL = { bus: 'Flixbus', train: 'train', car: 'voiture', best: 'le plus rapide' };
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

const state = {
  spotById: null,
  destinations: null,
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
const nf2 = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

const fmtEuro = (x) => `${nf.format(Math.round(x))} €`;
const fmtPrice = (x) => `${nf2.format(x)} €`;
const fmtRange = (a, b) => (Math.round(a) === Math.round(b) ? fmtEuro(a) : `${nf.format(Math.round(a))}–${fmtEuro(b)}`);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Formulaire ----------

function initForm() {
  const days = dayOptions();
  $('date').innerHTML = days.map((d) => `<option value="${d.value}">${esc(d.label)}</option>`).join('');
  $('profile').innerHTML = Object.entries(PROFILES)
    .map(([k, p]) => `<option value="${k}">${esc(p.label)}</option>`)
    .join('');
  $('fareProfile').innerHTML = Object.entries(FARE_PROFILES)
    .map(([k, label]) => `<option value="${k}">${esc(label)}</option>`)
    .join('');
  const hours = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
  $('windowStart').innerHTML = hours(6, 20).map((h) => `<option value="${h}">${h}h</option>`).join('');
  $('windowEnd').innerHTML = hours(8, 22).map((h) => `<option value="${h}">${h}h</option>`).join('');

  // Priorité : lien partagé (#…) > derniers réglages > valeurs par défaut.
  const saved = { ...(store.get('deco-radar-settings-v2') ?? {}), ...fromHash() };
  const s = { ...DEFAULTS, ...COST_DEFAULTS, points: LIMITS.weatherPointsPerRun, meteoWeight: 60, ...saved };
  if (saved.city?.lat) state.origin = saved.city;
  $('city').value = cityLabel(state.origin);
  const defaultDay = parisHour() < 15 ? days[0].value : days[1].value;
  $('date').value = days.some((d) => d.value === s.date) ? s.date : defaultDay;
  $('mode').value = MODE_LABEL[s.mode] ? s.mode : DEFAULTS.mode;
  $('maxHours').value = s.maxHours;
  $('profile').value = PROFILES[s.profile] ? s.profile : DEFAULTS.profile;
  $('fareProfile').value = FARE_PROFILES[s.fareProfile] ? s.fareProfile : DEFAULTS.fareProfile;
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
    fareProfile: $('fareProfile').value,
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
  if (p.get('tarif')) out.fareProfile = p.get('tarif');
  if (p.get('de')) out.windowStart = Number(p.get('de'));
  if (p.get('a')) out.windowEnd = Number(p.get('a'));
  return out;
}

function saveSettings(s) {
  const { sncfKey, ...rest } = s;
  store.set('deco-radar-settings-v2', { ...rest, city: state.origin });
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
    tarif: s.fareProfile,
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

// ---------- Données ----------

async function ensureData() {
  if (state.destinations) return;
  const [spotsRes, destRes] = await Promise.all([fetch('data/spots.json'), fetch('data/destinations.json')]);
  if (!spotsRes.ok || !destRes.ok) throw new Error('Impossible de charger la base des sites (data/*.json).');
  const spots = await spotsRes.json();
  const dests = await destRes.json();
  state.spotById = new Map(spots.spots.map((s) => [s.id, s]));
  state.destinations = dests.destinations;
  $('spots-attribution').textContent = spots.attribution ?? `Décollages : ${spots.source}`;
  const when = spots.generatedAt ? new Date(spots.generatedAt).toLocaleDateString('fr-FR') : '?';
  $('spots-meta').textContent = `${state.destinations.length} sites de vol, ${nf.format(
    state.destinations.reduce((n, d) => n + d.spots.length, 0),
  )} décollages · source ${spots.source} · mise à jour du ${when}`;
}

// ---------- Analyse ----------

function setStatus(text, pct, count = '') {
  $('status').hidden = false;
  $('status-text').textContent = text;
  $('status-count').textContent = count;
  if (pct != null) $('progress').value = pct;
}

/** Enveloppe commune : annulation de l'analyse précédente, bouton, erreurs, rendu. */
async function run(job) {
  state.run?.abort();
  const ctrl = new AbortController();
  state.run = ctrl;
  $('error').hidden = true;
  // Le bouton reste actif : un nouvel envoi annule l'analyse en cours et repart des réglages du moment.
  $('go-btn').textContent = 'Relancer';
  try {
    await job(ctrl.signal);
    setStatus('Terminé', 100);
    render();
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    $('error').hidden = false;
    $('error').textContent = err.message || 'Erreur inattendue.';
  } finally {
    if (state.run === ctrl) {
      $('go-btn').textContent = 'Analyser';
      setTimeout(() => ($('status').hidden = true), 600);
    }
  }
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
    dests: [],
    skipped: [],
    notes: [],
    today: isoDate(new Date()),
  };
  await run(async (signal) => {
    setStatus('Chargement des sites…', 2);
    await ensureData();
    setStatus('Ville de départ…', 5);
    ctx.origin = await resolveOrigin(signal);
    saveSettings(s);

    ctx.isToday = s.date === ctx.today;
    ctx.fromHour = ctx.isToday ? parisHour() : 0;
    if (ctx.isToday && ctx.fromHour >= ctx.win.end - 1) {
      throw new Error("Le créneau de vol d'aujourd'hui est presque terminé : choisis demain.");
    }
    const [fares, originFlix] = await Promise.all([loadFares(), findFlixbusCity(ctx.origin, signal).catch(() => null)]);
    ctx.fares = fares;
    ctx.originFlix = originFlix;
    if (!originFlix) ctx.notes.push(`Pas d'arrêt Flixbus à moins de 40 km de ${cityLabel(ctx.origin)}.`);

    // 1. Destinations candidates (de la plus proche à la plus lointaine), puis points météo à demander.
    const cands = [];
    for (const dest of state.destinations) {
      const spots = dest.spots.map((id) => state.spotById.get(id)).filter(Boolean);
      if (!spots.length) continue;
      const c = { dest, spots, crow: haversineKm(ctx.origin, dest.hub) };
      c.guess = guessHours(ctx, c);
      if (c.guess <= s.maxHours * 1.15) cands.push(c);
      else ctx.skipped.push({ dest, why: `à plus de ${String(s.maxHours).replace('.', ',')} h en ${MODE_LABEL[s.mode]}` });
    }
    if (!cands.length) {
      throw new Error(`Aucun site de vol à moins de ${String(s.maxHours).replace('.', ',')} h de ${cityLabel(ctx.origin)} en ${MODE_LABEL[s.mode]} : augmente le trajet maximum.`);
    }
    cands.sort((a, b) => a.guess - b.guess);
    const points = new Map();
    for (const c of cands) {
      const fresh = new Set(c.spots.map(weatherKey).filter((k) => !points.has(k)));
      if (points.size && points.size + fresh.size > s.points) {
        ctx.skipped.push({ dest: c.dest, why: 'limite de points météo atteinte' });
        continue;
      }
      for (const sp of c.spots) {
        const k = weatherKey(sp);
        if (!points.has(k)) points.set(k, { key: k, lat: sp.lat, lon: sp.lon, alt: sp.alt });
      }
      ctx.dests.push(c);
    }

    // 2. Météo de tous les décos de ces destinations.
    setStatus('Choix du modèle météo…', 8);
    const pts = [...points.values()];
    const onWait = (sec) => setStatus(`Quota gratuit d'Open-Meteo : reprise dans ${sec} s…`, null);
    ctx.chain = await chooseModels(pts[0], s.date, ctx.win, signal, onWait);
    const chainLabel = ctx.chain.map((m) => `${m.label} ${m.res}`).join(' + ');
    let progress = `0 / ${pts.length} points`;
    const weather = await fetchWeather(pts, s.date, ctx.chain, {
      signal,
      onProgress: (done, total) => {
        progress = `${done} / ${total} points`;
        setStatus(`Prévisions ${chainLabel}…`, 10 + (50 * done) / total, progress);
      },
      onWait: (sec) => setStatus(`Quota gratuit d'Open-Meteo : reprise dans ${sec} s…`, null, progress),
    });
    for (const c of ctx.dests) {
      c.results = c.spots.map((spot) => {
        const hours = (weather.get(weatherKey(spot)) ?? []).filter(
          (h) => h.hour >= ctx.win.start && h.hour < ctx.win.end && h.hour >= ctx.fromHour,
        );
        return { spot, day: evaluateDay(hours, spot, ctx.profile), model: dominantModel(hours) };
      });
      Object.assign(c, summarizeDestination(c.results));
      // Déco visé pour le trajet : le meilleur volable, sinon le plus proche du hub.
      c.target = c.best?.spot ?? [...c.spots].sort((a, b) => haversineKm(c.dest.hub, a) - haversineKm(c.dest.hub, b))[0];
    }

    // 3. Trajets : voiture (OSRM), train (tarifs SNCF + estimation), Flixbus (estimation).
    setStatus('Itinéraires routiers…', 65);
    try {
      const routes = await carRoutes(ctx.origin, ctx.dests.map((c) => c.target), signal);
      for (const c of ctx.dests) {
        const r = routes.get(c.target.id);
        c.car = r ? { ...r, ...carCostDetail(r.km, ctx.cost), estimated: false } : null;
      }
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      ctx.notes.push("Le serveur d'itinéraires ne répond pas : temps de route estimés à vol d'oiseau.");
      for (const c of ctx.dests) {
        const km = haversineKm(ctx.origin, c.target) * 1.3;
        c.car = { hours: roadGuessHours(km / 1.3), km, ...carCostDetail(km, ctx.cost), estimated: true };
      }
    }
    for (const c of ctx.dests) {
      c.train = trainOption(ctx, c);
      c.bus = busEstimate(ctx, c);
      scoreDest(ctx, c);
    }

    // 4. Horaires et prix Flixbus réels pour les meilleures destinations.
    const top = ctx.dests
      .filter((c) => c.day.flyable && c.dest.flixbus && ctx.originFlix)
      .sort((a, b) => b.score - a.score)
      .slice(0, LIMITS.flixbusAuto);
    for (const [i, c] of top.entries()) {
      setStatus(`Horaires Flixbus : ${c.dest.name}…`, 70 + (20 * i) / top.length, `${i} / ${top.length}`);
      await loadFlixbus(ctx, c, signal);
    }

    // 5. Horaires SNCF réels si l'utilisateur a fourni sa clé.
    if (s.sncfKey) {
      const trains = ctx.dests
        .filter((c) => c.day.flyable && c.train)
        .sort((a, b) => b.score - a.score)
        .slice(0, LIMITS.sncfTop);
      for (const [i, c] of trains.entries()) {
        setStatus('Horaires SNCF…', 90 + (8 * i) / trains.length, `${i} / ${trains.length}`);
        try {
          const j = await sncfJourney(ctx.origin, c.dest.station, s.date, s.sncfKey, signal, c.train.fares?.fromUics);
          if (j) c.train = { ...c.train, real: j, hours: j.hours + c.train.access.hours, estimated: false };
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          ctx.notes.push(`API SNCF : ${err.message}.`);
          break;
        }
        scoreDest(ctx, c);
      }
    }
    state.last = ctx;
  });
}

/** Durée aller grossière selon le mode, sans réseau : sert à écarter les destinations trop lointaines. */
function guessHours(ctx, c) {
  const car = roadGuessHours(c.crow);
  const train = c.dest.station ? railEstimate(ctx.origin, c.dest.station, ctx.cost).hours : Infinity;
  const bus = c.dest.flixbus ? flixbusGuess(ctx.origin, c.dest.flixbus).hours : Infinity;
  const byMode = { car, train, bus, best: Math.min(car, train, bus) };
  // Mode impossible (pas d'arrêt Flixbus, pas de gare) : on juge la distance sur les autres modes, et
  // la fiche expliquera pourquoi le site est écarté.
  return Number.isFinite(byMode[ctx.s.mode]) ? byMode[ctx.s.mode] : byMode.best;
}

function flixbusGuess(origin, stop, e = FLIXBUS_ESTIMATE) {
  const km = haversineKm(origin, stop) * e.detour;
  return { hours: km / e.speed + e.overhead, euros: 2 * (e.base + km * e.perKm) };
}

function trainOption(ctx, c) {
  const st = c.dest.station;
  if (!st) return null;
  const est = railEstimate(ctx.origin, st, ctx.cost);
  const fares = trainFares(ctx.fares, ctx.origin, c.dest, ctx.s.fareProfile);
  const access = accessTo(st, c.target, ctx.cost);
  return {
    hours: est.hours + access.hours,
    railHours: est.hours,
    euros: fares ? 2 * fares.mid : est.euros,
    fares,
    access,
    estimated: true,
  };
}

function busEstimate(ctx, c) {
  if (!c.dest.flixbus || !ctx.originFlix) return null;
  const guess = flixbusGuess(ctx.origin, c.dest.flixbus);
  const access = accessTo(c.dest.flixbus, c.target, ctx.cost);
  return { hours: guess.hours + access.hours, euros: guess.euros, access, estimated: true };
}

/** Vrais horaires Flixbus pour une destination, puis mise à jour de son score. */
async function loadFlixbus(ctx, c, signal) {
  if (!ctx.originFlix || !c.dest.flixbus) return;
  try {
    const plan = await flixbusRoundTrip(ctx.originFlix.cityId, c.dest.flixbus.cityId, ctx.s.date, ctx.today, signal, {
      leaveAfter: Math.max(14, ctx.s.windowEnd - 1),
    });
    const access = accessTo(c.dest.flixbus, c.target, ctx.cost);
    c.bus = plan.out
      ? { hours: plan.out.minutes / 60 + access.hours, euros: plan.total ?? 2 * plan.out.price, access, plan, estimated: false }
      : { none: true, access, plan };
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    c.busError = err.message;
  }
  scoreDest(ctx, c);
}

function scoreDest(ctx, c) {
  const { s, weights } = ctx;
  const options = { car: c.car, train: c.train, bus: c.bus?.none ? null : c.bus };
  c.travelKind =
    s.mode === 'best'
      ? (Object.entries(options)
          .filter(([, v]) => v)
          .sort((a, b) => a[1].hours - b[1].hours)[0]?.[0] ?? null)
      : s.mode;
  c.travel = c.travelKind ? options[c.travelKind] : null;
  c.outOfRange = !c.travel || c.travel.hours > s.maxHours;
  c.travelScore = travelScore(c.travel ?? {}, weights);
  c.score = globalScore(c.day, c.travelScore, weights);
  c.verdict = c.outOfRange ? 'non' : verdictOf(c.score, c.day);
}

/** Motif affiché pour une destination « Passe ton chemin ». */
function reasonOf(ctx, c) {
  if (!c.day.flyable) return c.day.mainReason;
  if (!c.travel) {
    if (c.travelKind === 'bus') {
      if (!c.dest.flixbus) return 'Pas d’arrêt Flixbus près du site : essaie le train ou la voiture';
      if (!ctx.originFlix) return 'Pas d’arrêt Flixbus près de ta ville';
      return 'Aucun Flixbus trouvé pour ce jour-là';
    }
    if (c.travelKind === 'train') return 'Pas de gare près du site';
    return `Pas de trajet en ${MODE_LABEL[c.travelKind]}`;
  }
  if (c.outOfRange) return `Trop loin : ${fmtDuration(c.travel.hours)} en ${MODE_LABEL[c.travelKind]} (max ${String(ctx.s.maxHours).replace('.', ',')} h)`;
  return `Volable, mais score ${c.score}/100 (météo ${c.day.meteoScore}, trajet ${c.travelScore})`;
}

// ---------- Affichage ----------

function render() {
  const ctx = state.last;
  const { s, origin, dests, chain } = ctx;
  const ok = dests.filter((c) => c.verdict !== 'non').sort((a, b) => b.score - a.score);
  const ko = dests.filter((c) => c.verdict === 'non').sort((a, b) => a.crow - b.crow);
  const n = { go: ok.filter((c) => c.verdict === 'go').length, jouable: ok.filter((c) => c.verdict === 'jouable').length, non: ko.length };

  const notes = [
    `${dests.length} sites de vol analysés (${nf.format(dests.reduce((k, c) => k + c.spots.length, 0))} décollages).`,
    ctx.skipped.length ? `Non analysés : ${ctx.skipped.map((x) => `${x.dest.name} (${x.why})`).join(', ')}.` : '',
    ctx.isToday ? `Aujourd'hui : seules les heures à partir de ${Math.max(ctx.fromHour, s.windowStart)}h comptent.` : '',
    ...ctx.notes,
  ].filter(Boolean);
  $('summary').innerHTML = `
    <div class="counts">
      <span class="pill go">${n.go} Go</span>
      <span class="pill jouable">${n.jouable} Jouable</span>
      <span class="pill non">${n.non} Passe ton chemin</span>
    </div>
    <div class="meta">${esc(longDate(s.date))} · ${s.windowStart}h–${s.windowEnd}h · départ ${esc(cityLabel(origin))} · ${MODE_LABEL[s.mode]} · ${esc(PROFILES[s.profile].label)}</div>
    <span class="pill model" title="Modèles Open-Meteo utilisés, du plus précis au plus grossier">Météo : ${esc(chain.map((m) => `${m.label} ${m.res}`).join(' → '))}</span>
    <p class="note">${esc(notes.join(' '))}</p>`;

  const cards = $('cards');
  cards.innerHTML = ok.length
    ? ''
    : `<p class="panel empty">Aucun site volable pour ces critères. Essaie un autre jour, un trajet plus long ou un autre mode de transport.</p>`;
  for (const c of ok) cards.append(destinationCard(ctx, c));

  $('eliminated').hidden = !ko.length;
  $('eliminated-title').textContent = `Passe ton chemin (${ko.length})`;
  $('eliminated-list').innerHTML = ko
    .map(
      (c) => `<li>
        <span><button type="button" data-id="${esc(c.dest.id)}">${esc(c.dest.name)}</button>
        <span class="muted"> · ${c.travel ? `${fmtDuration(c.travel.hours)} en ${MODE_LABEL[c.travelKind]}` : 'trajet ?'}</span></span>
        <span class="reason">${esc(reasonOf(ctx, c))}</span>
      </li>`,
    )
    .join('');

  $('results').hidden = false;
  renderMap(ctx);
}

const CAR_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 17h14v-5l-2-5H7l-2 5v5z"/><path d="M5 12h14"/><circle cx="8" cy="17" r="1.6"/><circle cx="16" cy="17" r="1.6"/></svg>';
const TRAIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="3" width="12" height="13" rx="3"/><path d="M6 10h12M9 20l-2 2M15 20l2 2M9 16v4M15 16v4"/></svg>';
const BUS_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="13" rx="2.5"/><path d="M4 11h16M8 17v3M16 17v3M9 4v7M15 4v7"/></svg>';

function destinationCard(ctx, c) {
  const { dest, day } = c;
  const node = document.createElement('article');
  node.className = `card ${c.verdict}`;
  node.id = `dest-${dest.id}`;
  const best = c.best;
  const spot = best.spot;
  const b = day.block;
  const orient = formatOrientations(spot.orient) || '?';
  node.innerHTML = `
    <header class="card-head">
      <div class="score" aria-label="Score">${c.score}</div>
      <div class="title">
        <h3>${esc(dest.name)} <span class="muted">(${esc(dest.dept)})</span></h3>
        <p class="where muted">${c.flyable.length} déco${c.flyable.length > 1 ? 's' : ''} volable${c.flyable.length > 1 ? 's' : ''} sur ${c.total} · meilleur : <b>${esc(spot.name)}</b>${spot.alt != null ? `, ${nf.format(spot.alt)} m` : ''}, déco ${orient}</p>
      </div>
      <span class="pill ${c.verdict}">${VERDICT_LABEL[c.verdict]}</span>
    </header>
    <div class="card-body">
      <div class="rose">${roseSvg(spot, b.dirDeg)}</div>
      <ul class="facts">
        <li>Volable <b>${flyableRanges(day.evaluated)}</b> · <span class="nw">idéal ${b.start}h–${b.end}h</span></li>
        <li>Vent <b>${b.wind} km/h</b> de ${b.dir} · rafales ${b.gust}</li>
        <li>Nuages ${b.cloud} %${b.wind850 != null ? ` · ${b.wind850} km/h vers 1 500 m` : ''}</li>
        ${best.model ? `<li class="muted">Prévision ${esc(best.model.label)} ${esc(best.model.res)}</li>` : ''}
      </ul>
    </div>
    ${day.warnings.length ? `<p class="warn">${esc(day.warnings.join(' · '))}</p>` : ''}
    <div class="bars">${bar('Météo', day.meteoScore)}${bar('Trajet', c.travelScore)}</div>
    <section class="trips" aria-label="Trajets aller-retour">
      <h4>Aller-retour depuis ${esc(cityLabel(ctx.origin))}</h4>
      ${busBlock(ctx, c)}
      ${trainBlock(ctx, c)}
      ${carBlock(ctx, c)}
      ${accessLine(c)}
    </section>
    <details class="spots-list">
      <summary>Les ${c.total} décos du site</summary>
      <ul>${c.results
        .slice()
        .sort((x, y) => Number(y.day.flyable) - Number(x.day.flyable) || y.day.meteoScore - x.day.meteoScore)
        .map((r) => spotLine(r))
        .join('')}</ul>
    </details>
    <details class="hourly">
      <summary>Heure par heure · ${esc(spot.name)}</summary>
      <div class="table-wrap">${hourlyTable(day.evaluated)}</div>
    </details>
    <nav class="links">
      <a href="${mapsLink(ctx.origin, spot, 'car')}" target="_blank" rel="noopener">Itinéraire voiture</a>
      ${spot.url ? `<a href="${esc(spot.url)}" target="_blank" rel="noopener">Fiche du déco</a>` : ''}
      <a href="https://www.windy.com/?arome,${spot.lat.toFixed(3)},${spot.lon.toFixed(3)},12" target="_blank" rel="noopener">Windy (AROME)</a>
      <a href="https://www.meteoblue.com/fr/meteo/semaine/${spot.lat.toFixed(3)}N${spot.lon.toFixed(3)}E" target="_blank" rel="noopener">Meteoblue</a>
    </nav>`;
  return node;
}

function tripHead(icon, label, kind, c, total, detail) {
  return `<div class="trip-head">${icon}<b>${label}</b>${total ? `<span class="trip-total">${total}</span>` : ''}${
    detail ? `<span class="muted">${detail}</span>` : ''
  }${c.travelKind === kind ? '<span class="tag chosen-tag">pris en compte dans le score</span>' : ''}</div>`;
}

function rideLine(label, r, flags = '') {
  const via = r.via.length ? ` via ${esc(r.via.join(', '))}` : '';
  const seats = r.seats != null && r.seats <= 5 ? ` · <span class="warn-inline">${r.seats} place${r.seats > 1 ? 's' : ''}</span>` : '';
  return `<li><span class="leg">${label}</span><span>${rideTime(r.dep, true)} ${esc(r.from)} → ${rideTime(r.arr, r.dep.slice(0, 10) !== r.arr.slice(0, 10))} ${esc(r.to)} · ${fmtDuration(r.minutes / 60)}${
    r.transfers ? ` · ${r.transfers} corresp.${via}` : ' · direct'
  }${seats}${flags}</span><b>${fmtPrice(r.price)}</b></li>`;
}

function busBlock(ctx, c) {
  const kind = 'bus';
  if (!c.dest.flixbus) return `<div class="trip">${tripHead(BUS_ICON, 'Flixbus', kind, c, '', 'pas d’arrêt Flixbus près du site')}</div>`;
  if (!ctx.originFlix) return `<div class="trip">${tripHead(BUS_ICON, 'Flixbus', kind, c, '', 'pas d’arrêt Flixbus près de ta ville')}</div>`;
  const link = flixbusLink(ctx.originFlix.cityId, c.dest.flixbus.cityId, ctx.s.date);
  if (c.busError) return `<div class="trip">${tripHead(BUS_ICON, 'Flixbus', kind, c, '', `horaires indisponibles (${esc(c.busError)})`)}<a href="${link}" target="_blank" rel="noopener">Chercher sur Flixbus</a></div>`;
  const bus = c.bus;
  if (bus?.estimated) {
    return `<div class="trip ${c.travelKind === kind ? 'chosen' : ''}">
      ${tripHead(BUS_ICON, 'Flixbus', kind, c, `≈ ${fmtEuro(bus.euros)}`, `≈ ${fmtDuration(bus.hours - bus.access.hours)} l’aller · estimation`)}
      <button type="button" class="ghost" data-flix="${esc(c.dest.id)}">Voir les vrais horaires et prix</button>
    </div>`;
  }
  const p = bus.plan;
  if (bus.none || !p.out) {
    return `<div class="trip">${tripHead(BUS_ICON, 'Flixbus', kind, c, '', 'aucun trajet trouvé pour ce jour-là')}<a href="${link}" target="_blank" rel="noopener">Chercher sur Flixbus</a></div>`;
  }
  const outFlag = p.outNight ? ' · <span class="warn-inline">arrivée en pleine nuit</span>' : p.outLate ? ' · <span class="warn-inline">arrivée tardive</span>' : '';
  const backFlag = p.backNextDay ? ' · <span class="warn-inline">le lendemain</span>' : '';
  const others = (list, chosen) => list.filter((r) => r !== chosen).map((r) => rideLine('', r)).join('');
  const moreOut = others(p.outOptions, p.out);
  const moreBack = others(p.backOptions, p.back);
  return `<div class="trip ${c.travelKind === kind ? 'chosen' : ''}">
    ${tripHead(BUS_ICON, 'Flixbus', kind, c, p.total != null ? fmtPrice(p.total) : '', p.total != null ? 'aller-retour, frais inclus' : 'retour introuvable')}
    <ul class="rides">
      ${rideLine('Aller', p.out, outFlag)}
      ${p.back ? rideLine('Retour', p.back, backFlag) : '<li><span class="leg">Retour</span><span>aucun bus trouvé le soir même ni le lendemain</span></li>'}
    </ul>
    ${moreOut || moreBack ? `<details class="more"><summary>Autres horaires</summary>${moreOut ? `<p class="muted">Aller</p><ul class="rides">${moreOut}</ul>` : ''}${moreBack ? `<p class="muted">Retour</p><ul class="rides">${moreBack}</ul>` : ''}</details>` : ''}
    <a href="${link}" target="_blank" rel="noopener">Réserver sur Flixbus</a>
  </div>`;
}

function trainBlock(ctx, c) {
  const kind = 'train';
  const t = c.train;
  if (!t) return `<div class="trip">${tripHead(TRAIN_ICON, 'Train', kind, c, '', 'pas de gare connue près du site')}</div>`;
  const station = c.dest.station;
  const time = t.real
    ? `${t.real.departure.slice(0, 2)}h${t.real.departure.slice(2)} → ${t.real.arrival.slice(0, 2)}h${t.real.arrival.slice(2)} · ${fmtDuration(t.real.hours)} · ${
        t.real.transfers ? `${t.real.transfers} corresp.` : 'direct'
      }${t.real.modes?.length ? ` (${esc(t.real.modes.join(', '))})` : ''}${t.real.from ? ` depuis ${esc(t.real.from)}` : ''} · horaires SNCF`
    : `≈ ${fmtDuration(t.railHours)} jusqu’à ${esc(station.name)}`;
  if (!t.fares) {
    return `<div class="trip ${c.travelKind === kind ? 'chosen' : ''}">
      ${tripHead(TRAIN_ICON, 'Train', kind, c, `≈ ${fmtEuro(t.euros)}`, `${time} · prix estimé`)}
      <p class="muted small">Pas de tarif TGV, OUIGO ou Intercités publié pour ce trajet (souvent du TER) : prix estimé au kilomètre. <a href="${SNCF_CONNECT}" target="_blank" rel="noopener">SNCF Connect</a></p>
    </div>`;
  }
  const f = t.fares;
  const profileNote = (o) => (o.profile !== ctx.s.fareProfile ? ' (tarif normal)' : '');
  return `<div class="trip ${c.travelKind === kind ? 'chosen' : ''}">
    ${tripHead(TRAIN_ICON, 'Train', kind, c, fmtRange(2 * f.min, 2 * f.max), `${time}`)}
    <ul class="rides">
      ${f.offers
        .map((o) => `<li><span class="leg">${esc(o.carrier)}</span><span>${esc(titleCase(f.from))} → ${esc(titleCase(f.to))}, l’aller${profileNote(o)}</span><b>${fmtRange(o.min, o.max)}</b></li>`)
        .join('')}
    </ul>
    ${f.toUic !== station.uic ? `<p class="small">Puis TER ou car jusqu’à ${esc(station.name)}, non compté.</p>` : ''}
    <p class="muted small">Fourchettes officielles SNCF en 2de classe (${esc(FARE_PROFILES[ctx.s.fareProfile].toLowerCase())}), pas de prix en temps réel. <a href="${SNCF_CONNECT}" target="_blank" rel="noopener">Réserver sur SNCF Connect</a></p>
  </div>`;
}

function carBlock(ctx, c) {
  const kind = 'car';
  const car = c.car;
  if (!car) return `<div class="trip">${tripHead(CAR_ICON, 'Voiture', kind, c, '', 'pas d’itinéraire routier')}</div>`;
  const share = ctx.s.passengers > 1 ? ` · ${fmtEuro(car.euros)} chacun à ${ctx.s.passengers}` : '';
  return `<div class="trip ${c.travelKind === kind ? 'chosen' : ''}">
    ${tripHead(CAR_ICON, 'Voiture', kind, c, fmtEuro(car.total), `${fmtDuration(car.hours)} l’aller · ${nf.format(Math.round(car.km))} km${car.estimated ? ' · estimation' : ''}`)}
    <p class="muted small">Carburant ${fmtEuro(car.fuel)} + péages ≈ ${fmtEuro(car.tolls)} (aller-retour jusqu’au déco)${share}</p>
  </div>`;
}

function accessLine(c) {
  const spot = c.best.spot;
  const a = c.travelKind === 'train' ? c.train?.access : c.bus?.access ?? c.train?.access;
  const from = c.travelKind === 'train' ? 'la gare' : c.dest.flixbus && c.bus ? 'l’arrêt Flixbus' : 'la gare';
  const how = a
    ? a.walk
      ? `${esc(spot.name)} est à ${nf.format(Math.round(a.km * 10) / 10)} km de ${from}, à pied.`
      : `${esc(spot.name)} est à ≈ ${nf.format(Math.round(a.km))} km de ${from} (≈ ${fmtDuration(a.hours)}) : taxi ≈ ${fmtEuro(a.taxi)} aller-retour, sinon navette ou stop.`
    : '';
  const note = c.dest.note ? ` ${esc(c.dest.note)}` : '';
  return how || note ? `<p class="access"><b>Accès au déco</b> ${how}${note} <span class="muted">(non compté dans les prix ci-dessus)</span></p>` : '';
}

function spotLine(r) {
  const d = r.day;
  const orient = formatOrientations(r.spot.orient) || '?';
  const status = d.flyable ? `volable ${flyableRanges(d.evaluated)} · météo ${d.meteoScore}` : esc(d.mainReason ?? '');
  return `<li class="${d.flyable ? 'ok' : 'ko'}"><i class="dot ${d.flyable ? 'go' : 'non'}"></i><span><b>${esc(r.spot.name)}</b> <span class="muted">${
    r.spot.alt != null ? `${nf.format(r.spot.alt)} m · ` : ''
  }déco ${orient}</span></span><span class="status">${status}</span></li>`;
}

/** « PARIS GARE DE LYON » → « Paris Gare de Lyon », « LA ROCHE SUR FORON » → « La Roche sur Foron ». */
const SMALL_WORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'sur', 'sous', 'en', 'et', 'aux', 'au']);
const titleCase = (s) =>
  s
    .toLowerCase()
    .split(/([\s-]+)/)
    .map((w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w.replace(/^\p{L}/u, (c) => c.toUpperCase())))
    .join('')
    .replace(/\bSt\b/g, 'Saint')
    .replace(/\bTgv\b/g, 'TGV');

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
      const st = e.ok ? 'volable' : e.reasons.map((r) => REASON_SHORT[r]).join(', ');
      const dir = e.dir == null ? '–' : SECTORS[Math.round(e.dir / 45) % 8];
      const v = (x) => (x == null ? '–' : Math.round(x));
      return `<tr class="${e.ok ? 'ok' : 'ko'}"><td>${e.hour}h</td><td>${v(e.wind)}</td><td>${v(e.gust)}</td><td>${dir}</td><td>${v(e.wind850)}</td><td>${v(e.cloud)} %</td><td>${e.rain == null ? '–' : String(Math.round(e.rain * 10) / 10).replace('.', ',')}</td><td>${st}</td></tr>`;
    })
    .join('');
  return `<table><thead><tr><th>Heure</th><th>Vent</th><th>Rafales</th><th>Dir.</th><th>1 500 m</th><th>Nuages</th><th>Pluie mm</th><th>État</th></tr></thead><tbody>${rows}</tbody></table>`;
}

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

function renderMap(ctx) {
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
  const order = { non: 0, jouable: 1, go: 2 };
  for (const c of [...ctx.dests].sort((a, b) => order[a.verdict] - order[b.verdict] || a.score - b.score)) {
    const m = L.circleMarker([c.dest.center.lat, c.dest.center.lon], {
      radius: c.verdict === 'go' ? 11 : c.verdict === 'jouable' ? 9 : 7,
      color: cssVar('--surface'),
      weight: 2,
      fillColor: color[c.verdict],
      fillOpacity: c.verdict === 'non' ? 0.6 : 0.95,
    });
    const detail = c.verdict === 'non' ? esc(reasonOf(ctx, c)) : `Score ${c.score} · ${esc(c.best.spot.name)} ${c.day.block.start}h–${c.day.block.end}h`;
    const btn = c.verdict === 'non' ? '' : `<br><button type="button" data-card="${esc(c.dest.id)}">Voir la fiche</button>`;
    m.bindTooltip(esc(c.dest.name));
    m.bindPopup(`<b>${esc(c.dest.name)}</b> <span class="pill ${c.verdict}">${VERDICT_LABEL[c.verdict]}</span><br>${detail}${btn}`);
    m.addTo(state.markers);
    state.markerById.set(c.dest.id, m);
  }
  L.circleMarker([ctx.origin.lat, ctx.origin.lon], { radius: 7, color: cssVar('--surface'), weight: 2, fillColor: cssVar('--accent'), fillOpacity: 1 })
    .bindTooltip(`Départ : ${esc(cityLabel(ctx.origin))}`)
    .addTo(state.markers);
  const pts = ctx.dests.map((c) => [c.dest.center.lat, c.dest.center.lon]).concat([[ctx.origin.lat, ctx.origin.lon]]);
  state.map.invalidateSize();
  state.map.fitBounds(pts, { padding: [24, 24], maxZoom: 9 });
}

function openCard(id) {
  const el = document.getElementById(`dest-${id}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  el.classList.add('flash');
  setTimeout(() => el.classList.remove('flash'), 1600);
}

/** Bouton « Voir les vrais horaires et prix » d'une fiche : Flixbus à la demande. */
async function flixOnDemand(btn) {
  const ctx = state.last;
  const c = ctx?.dests.find((x) => x.dest.id === btn.dataset.flix);
  if (!c) return;
  btn.disabled = true;
  btn.textContent = 'Recherche des horaires Flixbus…';
  await loadFlixbus(ctx, c);
  if (state.last !== ctx) return;
  const old = document.getElementById(`dest-${c.dest.id}`);
  if (old && c.verdict !== 'non') old.replaceWith(destinationCard(ctx, c));
  else render();
}

document.addEventListener('click', (e) => {
  const cardBtn = e.target.closest('[data-card]');
  if (cardBtn) openCard(cardBtn.dataset.card);
  const flixBtn = e.target.closest('[data-flix]');
  if (flixBtn) flixOnDemand(flixBtn);
  const koBtn = e.target.closest('#eliminated-list [data-id]');
  if (koBtn && state.map) {
    const m = state.markerById.get(koBtn.dataset.id);
    if (m) {
      document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'center' });
      state.map.setView(m.getLatLng(), 9);
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
    if (state.last) renderMap(state.last);
  });
}

initTheme();
initForm();
analyse();
