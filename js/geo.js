// Petite géométrie : distances, angles et secteurs de vent.

export const SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];
export const SECTOR_ANGLE = Object.fromEntries(SECTORS.map((s, i) => [s, i * 45]));

const R = 6371; // rayon terrestre (km)
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Écart angulaire le plus court entre deux directions (0 à 180°). */
export function angleDiff(a, b) {
  const d = Math.abs((((a - b) % 360) + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/** Secteur (N, NE…) d'une direction en degrés. */
export function sectorOf(deg) {
  return SECTORS[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/**
 * Qualité d'orientation d'un vent venant de `windDir` pour un déco orienté `good` (secteurs
 * favorables) et `ok` (secteurs possibles).
 * Renvoie 1 (dans l'axe), 0.6 (travers acceptable), 0 (mal orienté) ou null si orientation inconnue.
 */
export function orientationFactor(windDir, goodList, okList) {
  // Codes inconnus (ex. « W ») ignorés plutôt que de rendre le déco toujours mal orienté.
  const good = (goodList ?? []).filter((s) => SECTORS.includes(s));
  const ok = (okList ?? []).filter((s) => SECTORS.includes(s));
  if (!good.length && !ok.length) return null;
  const nearest = (list) => Math.min(...list.map((s) => angleDiff(windDir, SECTOR_ANGLE[s])));
  const dGood = good.length ? nearest(good) : Infinity;
  const dOk = ok.length ? nearest(ok) : Infinity;
  if (dGood <= 22.5) return 1;
  if (dGood <= 45 || dOk <= 22.5) return 0.6;
  return 0;
}

/** Libellé compact des orientations : ["NO","O","N"] → "N-NO-O" dans l'ordre de la rose. */
export function formatOrientations(list = []) {
  return SECTORS.filter((s) => list.includes(s)).join('-');
}
