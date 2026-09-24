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

/** Coût aller-retour par personne en voiture : carburant + péages estimés, partagés entre passagers. */
export function carCost(km, cost) {
  const fuel = 2 * km * (cost.consumption / 100) * cost.fuelPrice;
  const motorwayKm = km > 100 ? (km - 50) * 0.8 : 0; // hypothèse : 80 % d'autoroute au-delà des 50 premiers km
  const tolls = cost.tolls ? 2 * motorwayKm * cost.tollPerKm : 0;
  return (fuel + tolls) / Math.max(1, cost.passengers);
}

/** Train sans clé API : estimation à partir des distances (gare la plus proche du déco). */
export function trainEstimate(origin, spot, cost, m = TRAIN_MODEL) {
  if (!spot.station) return null;
  const crow = haversineKm(origin, spot.station);
  const long = crow >= m.longThresholdKm;
  const railKm = crow * m.railDetour;
  const railHours = railKm / (long ? m.longSpeed : m.shortSpeed) + (long ? m.longOverhead : m.shortOverhead);
  const last = lastMile(spot, cost, m);
  return {
    hours: railHours + last.hours,
    euros: 2 * railKm * (long ? cost.trainLongPerKm : cost.trainShortPerKm) + last.euros,
    station: spot.station,
    lastMile: last.mode,
    estimated: true,
  };
}

function lastMile(spot, cost, m) {
  const km = spot.station.km;
  if (km <= m.walkMaxKm) return { mode: 'à pied', hours: km / 4.5, euros: 0 };
  const roadKm = km * m.roadDetour;
  return {
    mode: 'taxi ou navette',
    hours: roadKm / m.lastMileSpeed + m.lastMileWait,
    euros: (2 * (cost.taxiBase + roadKm * cost.taxiPerKm)) / Math.max(1, cost.passengers),
  };
}

/**
 * Horaires réels via l'API SNCF (Navitia) : trajet départ → gare la plus proche du déco, le matin
 * du jour choisi. Clé gratuite : https://numerique.sncf.com/startup/api/token-developpeur/
 */
export async function sncfJourney(origin, spot, date, key, cost, signal) {
  if (!spot.station) return null;
  const p = new URLSearchParams({
    from: `${origin.lon};${origin.lat}`,
    to: `${spot.station.lon};${spot.station.lat}`,
    datetime: `${date.replaceAll('-', '')}T060000`,
    datetime_represents: 'departure',
    count: '4',
    max_walking_duration_to_pt: '1800',
  });
  const res = await fetch(`${API.sncf}?${p}`, { headers: { Authorization: key }, signal });
  if (res.status === 401 || res.status === 403) throw new Error('Clé API SNCF refusée');
  if (!res.ok) return null;
  const data = await res.json();
  const journeys = (data.journeys ?? []).filter((j) => j.duration);
  if (!journeys.length) return null;
  // On privilégie une arrivée avant midi, puis la durée la plus courte.
  const morning = journeys.filter((j) => Number(j.arrival_date_time.slice(9, 11)) < 12);
  const best = (morning.length ? morning : journeys).sort((a, b) => a.duration - b.duration)[0];
  const estimate = trainEstimate(origin, spot, cost);
  const last = lastMile(spot, cost, TRAIN_MODEL);
  return {
    ...estimate,
    hours: best.duration / 3600 + last.hours,
    departure: best.departure_date_time.slice(9, 13),
    arrival: best.arrival_date_time.slice(9, 13),
    transfers: best.nb_transfers,
    estimated: false,
  };
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
