// Destinations de vol : un lieu connu (Annecy, Chamonix…) regroupe plusieurs décollages. Pour un
// jour donné, la destination vaut ce que vaut son meilleur déco volable. Fonctions pures, testées.

import { haversineKm } from './geo.js';

/**
 * Résumé météo d'une destination à partir des journées de ses décos.
 * @param {{spot: object, day: object}[]} results  un élément par déco (day = evaluateDay)
 * @returns {{best: object|null, flyable: object[], total: number, day: object}}
 *   best = déco retenu (meilleure note météo, à égalité le plus d'heures volables) ;
 *   day  = sa journée, ou pour une destination non volable celle du motif le plus fréquent.
 */
export function summarizeDestination(results) {
  const flyable = results
    .filter((r) => r.day.flyable)
    .sort((a, b) => b.day.meteoScore - a.day.meteoScore || b.day.flyableHours - a.day.flyableHours || a.spot.id.localeCompare(b.spot.id));
  if (flyable.length) return { best: flyable[0], flyable, total: results.length, day: flyable[0].day };
  return { best: null, flyable, total: results.length, day: commonNoGo(results) };
}

/** Journée non volable la plus représentative : celle dont le motif (sans les détails) revient le plus. */
function commonNoGo(results) {
  if (!results.length) return { flyable: false, mainReason: 'Aucun déco analysé', meteoScore: 0, evaluated: [], warnings: [] };
  const kind = (r) => (r.day.mainReason ?? '').split(' (')[0];
  const counts = new Map();
  for (const r of results) counts.set(kind(r), (counts.get(kind(r)) ?? 0) + 1);
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
  return results.find((r) => kind(r) === top).day;
}

/** Distance routière approximative (km) entre deux points, pour l'accès au déco. */
export const roadKm = (a, b, detour = 1.4) => haversineKm(a, b) * detour;
