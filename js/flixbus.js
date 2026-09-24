// Flixbus : horaires et prix réels via l'API publique (non documentée) qu'utilise leur site de
// réservation. Elle accepte les appels depuis un navigateur (CORS). On l'interroge avec parcimonie :
// seulement pour les meilleures destinations, ou à la demande, avec un cache en mémoire.

import { haversineKm } from './geo.js';

const BASE = 'https://global.api.flixbus.com/search';
const cache = new Map();

async function getJson(url, signal) {
  if (cache.has(url)) return cache.get(url);
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`Flixbus : erreur ${res.status}`);
  const data = await res.json();
  cache.set(url, data);
  return data;
}

/** Ville Flixbus la plus proche d'un lieu (≤ 40 km), ou null. */
export async function findFlixbusCity(place, signal) {
  const p = new URLSearchParams({ q: place.name, lang: 'fr', country: 'fr', flixbus_cities_only: 'false', stations: 'true' });
  const list = await getJson(`${BASE}/autocomplete/cities?${p}`, signal);
  const best = (Array.isArray(list) ? list : [])
    .filter((c) => c.is_flixbus_city && c.location)
    .map((c) => ({ cityId: c.id, name: c.name, lat: c.location.lat, lon: c.location.lon, km: haversineKm(place, c.location) }))
    .sort((a, b) => a.km - b.km)[0];
  return best && best.km <= 40 ? best : null;
}

const frDate = (iso) => iso.split('-').reverse().join('.'); // 2026-09-26 → 26.09.2026

/** Trajets d'une ville à une autre pour une date (AAAA-MM-JJ), déjà mis en forme par parseRides. */
export async function searchRides(fromId, toId, date, signal) {
  const p = new URLSearchParams({
    from_city_id: fromId,
    to_city_id: toId,
    departure_date: frDate(date),
    products: JSON.stringify({ adult: 1 }),
    currency: 'EUR',
    locale: 'fr',
    search_by: 'cities',
    include_after_midnight_rides: '1',
  });
  return parseRides(await getJson(`${BASE}/service/v4/search?${p}`, signal));
}

/**
 * Réponse brute de l'API → liste de trajets réservables.
 * Les dates restent des chaînes locales (« 2026-09-26T00:30:00+02:00 ») : on en lit directement
 * le jour et l'heure, sans conversion de fuseau.
 */
export function parseRides(json) {
  const stations = json?.stations ?? {};
  const cities = json?.cities ?? {};
  const place = (end) => stations[end.station_id]?.name ?? cities[end.city_id]?.name ?? '?';
  const rides = [];
  for (const trip of Array.isArray(json?.trips) ? json.trips : []) {
    for (const r of Object.values(trip?.results ?? {})) {
      if (r?.status !== 'available' || !r.departure?.date || !r.arrival?.date) continue;
      const price = r.price?.total_with_platform_fee ?? r.price?.total;
      if (price == null) continue;
      const legs = r.legs ?? [];
      rides.push({
        dep: r.departure.date,
        arr: r.arrival.date,
        from: place(r.departure),
        to: place(r.arrival),
        minutes: (r.duration?.hours ?? 0) * 60 + (r.duration?.minutes ?? 0),
        price,
        transfers: Math.max(0, legs.length - 1),
        via: legs.slice(0, -1).map((l) => cities[l.arrival.city_id]?.name ?? place(l.arrival)),
        seats: r.available?.seats ?? null,
        train: legs.some((l) => l.means_of_transport === 'train'),
      });
    }
  }
  return rides.sort((a, b) => a.dep.localeCompare(b.dep));
}

const dayOf = (s) => s.slice(0, 10);
const hourOf = (s) => Number(s.slice(11, 13)) + Number(s.slice(14, 16)) / 60;

/** Date ISO décalée de n jours (AAAA-MM-JJ, calcul en UTC pour éviter les changements d'heure). */
export function shiftDate(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * Coût ressenti d'un trajet : prix + valeur du temps passé dans le bus + pénalité par
 * correspondance. Évite de retenir un trajet de 12 h pour économiser 50 centimes sur un direct de 9 h.
 */
export const rideCost = (r, { timeValue = 4, transferPenalty = 3 } = {}) => r.price + (timeValue * r.minutes) / 60 + transferPenalty * r.transfers;
const byCostThenTime = (key, opts) => (a, b) => rideCost(a, opts) - rideCost(b, opts) || a[key].localeCompare(b[key]);

/**
 * Choisit l'aller et le retour pour voler le jour `date` :
 * - aller : arrivée le jour J entre 5 h et `arriveBy` h (bus de nuit la veille compris), au plus
 *   faible coût ressenti (voir rideCost) ; à défaut une arrivée en pleine nuit (signalée), sinon
 *   l'arrivée la plus tôt du jour J (signalée « tardive ») ;
 * - retour : départ le soir même après `leaveAfter` h, au plus faible coût ressenti ; à défaut, le lendemain.
 * @param {object} rides { outPrev, outDay, backDay, backNext } : listes issues de parseRides
 */
export function planRoundTrip(rides, date, { arriveBy = 12, leaveAfter = 16, timeValue = 4, transferPenalty = 3 } = {}) {
  const costOpts = { timeValue, transferPenalty };
  // Les bus d'après minuit du jour J sont renvoyés par la recherche de la veille ET par celle du jour :
  // on ne garde qu'un exemplaire de chaque trajet.
  const seen = new Set();
  const outAll = [...(rides.outPrev ?? []), ...(rides.outDay ?? [])].filter((r) => {
    const key = `${r.dep}|${r.arr}|${r.from}|${r.to}`;
    if (dayOf(r.arr) !== date || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const outOk = outAll.filter((r) => hourOf(r.arr) >= 5 && hourOf(r.arr) <= arriveBy);
  const outNight = outAll.filter((r) => hourOf(r.arr) < 5);
  const outLater = [...outAll].filter((r) => hourOf(r.arr) > arriveBy).sort((a, b) => a.arr.localeCompare(b.arr)).slice(0, 1);
  const outPick = outOk.length ? outOk : outNight.length ? outNight : outLater;
  const out = outPick.length ? [...outPick].sort(byCostThenTime('arr', costOpts))[0] : null;

  // Jamais de retour avant l'arrivée de l'aller (cas d'un aller tardif).
  const sameDay = (rides.backDay ?? []).filter(
    (r) => dayOf(r.dep) === date && hourOf(r.dep) >= leaveAfter && (!out || hourOf(r.dep) > hourOf(out.arr)),
  );
  const nextDay = (rides.backNext ?? []).filter((r) => dayOf(r.dep) === shiftDate(date, 1));
  const backPool = sameDay.length ? sameDay : nextDay;
  const back = backPool.length ? [...backPool].sort(byCostThenTime('dep', costOpts))[0] : null;

  return {
    out,
    outNight: Boolean(out && !outOk.length && outNight.length),
    outLate: Boolean(out && !outOk.length && !outNight.length),
    outOptions: outPick.slice().sort((a, b) => a.dep.localeCompare(b.dep)).slice(0, 5),
    back,
    backNextDay: Boolean(back && !sameDay.length),
    backOptions: backPool.slice().sort((a, b) => a.dep.localeCompare(b.dep)).slice(0, 5),
    total: out && back ? Math.round((out.price + back.price) * 100) / 100 : null,
  };
}

/** Aller-retour Flixbus complet entre deux villes pour voler le jour `date` (4 recherches au plus). */
export async function flixbusRoundTrip(fromId, toId, date, today, signal, options) {
  const prev = shiftDate(date, -1);
  const [outPrev, outDay, backDay, backNext] = await Promise.all([
    prev >= today ? searchRides(fromId, toId, prev, signal) : [],
    searchRides(fromId, toId, date, signal),
    searchRides(toId, fromId, date, signal),
    searchRides(toId, fromId, shiftDate(date, 1), signal),
  ]);
  return planRoundTrip({ outPrev, outDay, backDay, backNext }, date, options);
}

/** Lien vers la recherche Flixbus pré-remplie. */
export function flixbusLink(fromId, toId, date) {
  const p = new URLSearchParams({ departureCity: fromId, arrivalCity: toId, rideDate: frDate(date), adult: '1' });
  return `https://shop.flixbus.fr/search?${p}`;
}

/** « ven. 25 · 22h15 » à partir d'une date locale Flixbus. */
export function rideTime(s, withDay = false) {
  const hm = `${s.slice(11, 13)}h${s.slice(14, 16)}`;
  if (!withDay) return hm;
  const [y, m, d] = dayOf(s).split('-').map(Number);
  const day = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(Date.UTC(y, m - 1, d, 12)));
  return `${day} · ${hm}`;
}
