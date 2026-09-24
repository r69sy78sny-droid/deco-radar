// Tarifs SNCF de référence (open data, ODbL) : fourchette de prix d'un aller en 2de classe par
// couple de gares, pour TGV INOUI, OUIGO et Intercités. Ce ne sont pas des prix en temps réel.

import { haversineKm } from './geo.js';

export const FARE_PROFILES = {
  normal: 'Tarif normal',
  avantage: 'Carte Avantage',
  etudiant: 'Élève, étudiant, apprenti',
};

let loaded = null;

export async function loadFares() {
  if (!loaded) {
    loaded = fetch('data/fares.json')
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return loaded;
}

/**
 * Meilleure offre de train publiée entre la ville de départ et une destination.
 * Côté destination, on prend la gare tarifée la plus proche du site qui a un tarif (les
 * `fareStations` sont triées par distance) ; côté départ, la gare à ≤ `maxKm` qui donne le prix
 * minimum le plus bas, à égalité la plus proche.
 * @returns {null | {from, to, toUic, offers: [{carrier, min, max, profile}], min, max, mid}}
 */
export function trainFares(fares, origin, destination, profile = 'normal', maxKm = 40) {
  if (!fares?.pairs || !destination.fareStations?.length) return null;
  const origins = Object.entries(fares.stations ?? {})
    .map(([uic, s]) => ({ uic, ...s, km: haversineKm(origin, s) }))
    .filter((s) => s.km <= maxKm)
    .sort((a, b) => a.km - b.km);
  for (const d of destination.fareStations) {
    let best = null;
    for (const o of origins) {
      const rows = fares.pairs[`${o.uic}>${d}`];
      if (!rows?.length) continue;
      const offers = offersFor(rows, profile);
      if (!offers.length) continue;
      const min = Math.min(...offers.map((x) => x.min));
      const max = Math.max(...offers.map((x) => x.max));
      if (!best || min < best.min) {
        best = { from: o.name, to: fares.stations[d]?.name ?? d, toUic: d, offers, min, max, mid: (min + max) / 2 };
      }
    }
    if (best) return best;
  }
  return null;
}

/** Une offre par transporteur : le profil demandé s'il existe, sinon le tarif normal (OUIGO n'a que celui-là). */
function offersFor(rows, profile) {
  const byCarrier = new Map();
  for (const [carrier, p, min, max] of rows) {
    if (p !== profile && p !== 'normal') continue;
    const current = byCarrier.get(carrier);
    if (!current || (p === profile && current.profile !== profile)) byCarrier.set(carrier, { carrier, profile: p, min, max });
  }
  return [...byCarrier.values()];
}

/** Lien vers SNCF Connect (page d'accueil : le format de recherche pré-remplie n'est pas public). */
export const SNCF_CONNECT = 'https://www.sncf-connect.com/';
