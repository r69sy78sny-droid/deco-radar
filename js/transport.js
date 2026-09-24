// Trajets depuis la ville de départ : voiture (OSRM, gratuit et sans clé), train (estimation, ou
// horaires réels via l'API SNCF si l'utilisateur fournit sa clé gratuite).

import { API, LIMITS, TRAIN_MODEL, ROAD_GUESS } from './config.js';
import { haversineKm } from './geo.js';

/** Recherche de communes françaises (API Découpage administratif, sans clé). */
export async function searchCommunes(q, signal) {
  const p = new URLSearchParams({ nom: q, boost: 'population', limit: '7', fields: 'nom,centre,codeDepartement,population' });
  const res = await fetch(`${API.communes}?${p}`, { signal });
  if (!res.ok) throw new Error(`Recherche de commune : erreur ${res.status}`);
  const list = await res.json();
  return list
    .filter((c) => c.centre)
    .map((c) => ({
      name: c.nom,
      dept: c.codeDepartement,
      lon: c.centre.coordinates[0],
      lat: c.centre.coordinates[1],
      population: c.population,
    }));
}

export const cityLabel = (c) => `${c.name} (${c.dept})`;

/** Temps de route grossier (h), sans réseau : sert seulement à présélectionner les spots. */
export function roadGuessHours(km) {
  return (km * ROAD_GUESS.detour) / ROAD_GUESS.speed + ROAD_GUESS.overhead;
}

/**
 * Durées et distances routières depuis `origin` vers chaque spot (service table d'OSRM).
 * @returns {Promise<Map<string, {hours:number, km:number}|null>>}
 */
export async function carRoutes(origin, spots, signal) {
  const out = new Map();
  for (let i = 0; i < spots.length; i += LIMITS.osrmBatch) {
    const batch = spots.slice(i, i + LIMITS.osrmBatch);
    const coords = [origin, ...batch].map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
    const res = await fetch(`${API.osrmTable}${coords}?sources=0&annotations=duration,distance`, { signal });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.code !== 'Ok') throw new Error(`Calcul d'itinéraire (OSRM) : ${data.message ?? res.status}`);
    batch.forEach((s, j) => {
      const sec = data.durations[0][j + 1];
      const m = data.distances[0][j + 1];
      out.set(s.id, sec == null ? null : { hours: sec / 3600, km: m / 1000 });
    });
  }
  return out;
}

/** Coût aller-retour en voiture, détaillé : carburant, péages estimés, total, part de chacun. */
export function carCostDetail(km, cost) {
  const fuel = 2 * km * (cost.consumption / 100) * cost.fuelPrice;
  const motorwayKm = km > 100 ? (km - 50) * 0.8 : 0; // hypothèse : 80 % d'autoroute au-delà des 50 premiers km
  const tolls = cost.tolls ? 2 * motorwayKm * cost.tollPerKm : 0;
  const total = fuel + tolls;
  return { fuel, tolls, total, euros: total / Math.max(1, cost.passengers) };
}

/** Coût aller-retour par personne en voiture. */
export const carCost = (km, cost) => carCostDetail(km, cost).euros;

/** Train sans horaires réels : durée d'un aller jusqu'à une gare et prix aller-retour estimés. */
export function railEstimate(origin, station, cost, m = TRAIN_MODEL) {
  const crow = haversineKm(origin, station);
  const long = crow >= m.longThresholdKm;
  const railKm = crow * m.railDetour;
  return {
    hours: railKm / (long ? m.longSpeed : m.shortSpeed) + (long ? m.longOverhead : m.shortOverhead),
    euros: 2 * railKm * (long ? cost.trainLongPerKm : cost.trainShortPerKm),
  };
}

/** Accès au déco depuis une gare ou un arrêt de bus : à pied si c'est tout près, sinon taxi ou navette. */
export function accessTo(from, target, cost, m = TRAIN_MODEL) {
  const km = haversineKm(from, target) * m.roadDetour;
  if (km <= m.walkMaxKm) return { km, hours: km / 4.5, taxi: 0, walk: true };
  return {
    km,
    hours: km / m.lastMileSpeed + m.lastMileWait,
    taxi: (2 * (cost.taxiBase + km * cost.taxiPerKm)) / Math.max(1, cost.passengers),
    walk: false,
  };
}

const SNCF_BASE = API.sncf.replace('/journeys', '');
const stopAreas = new Map();

/**
 * Arrêt le plus proche d'un point (gare, RER…). L'API refuse un départ donné en coordonnées brutes
 * (« Public transport is not reachable from origin ») : on part donc d'un arrêt. Mis en cache.
 */
async function nearestStopArea(point, key, signal) {
  const k = `${point.lat.toFixed(4)},${point.lon.toFixed(4)}`;
  if (!stopAreas.has(k)) {
    const url = `${SNCF_BASE}/coords/${point.lon};${point.lat}/places_nearby?type[]=stop_area&distance=5000&count=1`;
    const res = await fetch(url, { headers: { Authorization: key }, signal });
    if (res.status === 401 || res.status === 403) throw new Error('Clé API SNCF refusée');
    const data = res.ok ? await res.json() : {};
    stopAreas.set(k, data.places_nearby?.[0]?.id ?? null);
  }
  return stopAreas.get(k);
}

/** Meilleur trajet pour voler : arrivée avant midi d'abord (le plus court), sinon l'arrivée la plus tôt. */
export function betterJourney(a, b) {
  const am = a.arrivalHour < 12;
  const bm = b.arrivalHour < 12;
  if (am !== bm) return am ? -1 : 1;
  return am ? a.hours - b.hours : a.arrivalAt.localeCompare(b.arrivalAt) || a.hours - b.hours;
}

/** Trajets renvoyés par l'API pour un départ donné, mis en forme. */
async function journeysFrom(from, station, date, key, signal) {
  const p = new URLSearchParams({
    from,
    to: station.uic ? `stop_area:SNCF:${station.uic}` : `${station.lon};${station.lat}`,
    datetime: `${date.replaceAll('-', '')}T050000`,
    datetime_represents: 'departure',
    count: '8',
    min_nb_journeys: '6',
  });
  const res = await fetch(`${SNCF_BASE}/journeys?${p}`, { headers: { Authorization: key }, signal });
  if (res.status === 401 || res.status === 403) throw new Error('Clé API SNCF refusée');
  if (!res.ok) return [];
  const data = await res.json();
  return (data.journeys ?? [])
    .filter((j) => j.duration)
    .map((j) => {
      const rides = j.sections.filter((sec) => sec.type === 'public_transport');
      return {
        hours: j.duration / 3600,
        departure: j.departure_date_time.slice(9, 13),
        arrival: j.arrival_date_time.slice(9, 13),
        arrivalAt: j.arrival_date_time,
        arrivalHour: Number(j.arrival_date_time.slice(9, 11)),
        transfers: j.nb_transfers,
        // « Paris - Gare de Lyon - Hall 1 & 2 (Paris) » → « Paris - Gare de Lyon »
        from: rides[0]?.from?.name?.replace(/\s*\([^)]*\)$/, '').replace(/\s+-\s+Hall.*$/, '') ?? null,
        modes: [...new Set(rides.map((sec) => sec.display_informations?.commercial_mode).filter(Boolean))],
      };
    });
}

/**
 * Horaires réels via l'API SNCF (Navitia) jusqu'à la gare de la destination (code UIC), le matin du
 * jour choisi. Départ : les gares qui ont un tarif SNCF vers ce site (`fromUics`, 3 au plus : à Paris,
 * Bercy pour Clermont, Gare de Lyon pour les Alpes), sinon l'arrêt le plus proche. Depuis un arrêt
 * quelconque, l'API rate souvent le train direct d'une autre gare. Pas de prix dans cette API.
 * Clé gratuite : https://numerique.sncf.com/startup/api/token-developpeur/
 */
export async function sncfJourney(origin, station, date, key, signal, fromUics = []) {
  const froms = fromUics.length
    ? fromUics.slice(0, 3).map((uic) => `stop_area:SNCF:${uic}`)
    : [(await nearestStopArea(origin, key, signal)) ?? `${origin.lon};${origin.lat}`];
  const all = (await Promise.all(froms.map((f) => journeysFrom(f, station, date, key, signal)))).flat();
  return all.length ? all.sort(betterJourney)[0] : null;
}

/** Liens d'itinéraire Google Maps (format d'URL public et documenté). */
export function mapsLink(origin, dest, mode) {
  const p = new URLSearchParams({
    api: '1',
    origin: `${origin.lat},${origin.lon}`,
    destination: `${dest.lat},${dest.lon}`,
    travelmode: mode === 'train' ? 'transit' : 'driving',
  });
  return `https://www.google.com/maps/dir/?${p}`;
}
