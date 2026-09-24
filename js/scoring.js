// Algorithme de score : fonctions pures, sans accès réseau ni DOM (testées par tests/scoring.test.mjs).
//
// 1. Chaque heure du créneau est jugée volable ou non (critères éliminatoires).
// 2. La journée n'est volable que s'il existe au moins `minBlockHours` heures volables d'affilée
//    et aucun orage dans le créneau. Sinon : score 0, « Passe ton chemin ».
// 3. Sinon, score = 60 % qualité météo du meilleur créneau + 40 % score trajet (durée et coût).

import { WEATHER_RULES, SCORE_WEIGHTS, TRAVEL_SCALE, VERDICTS } from './config.js';
import { orientationFactor, sectorOf, formatOrientations } from './geo.js';

const clamp01 = (x) => Math.min(1, Math.max(0, x));
const round1 = (x) => Math.round(x * 10) / 10;
const fmtHour = (h) => `${h}h`;

/**
 * Juge une heure de prévision pour un spot.
 * @param {object} h  { hour, wind, gust, dir, rain, cloud, cloudLow, code, cape, wind850 }
 * @param {object} spot  { alt, orient, orientOk }
 * @param {object} profile  voir PROFILES dans config.js
 * @returns {{ok:boolean, reasons:string[], quality:number, orient:number|null}}
 */
export function evaluateHour(h, spot, profile, rules = WEATHER_RULES) {
  const reasons = [];
  if (h.wind == null || h.gust == null || h.dir == null) {
    // Un orage prévu compte même si le vent manque (sinon la journée pourrait rester volable).
    return { ok: false, reasons: rules.thunderCodes.includes(h.code) ? ['thunder', 'nodata'] : ['nodata'], quality: 0, orient: null };
  }
  if (rules.thunderCodes.includes(h.code)) reasons.push('thunder');
  if ((h.rain ?? 0) >= rules.rainMm) reasons.push('rain');
  if (rules.fogCodes.includes(h.code)) reasons.push('fog');
  if (h.wind > profile.windMax) reasons.push('wind');
  if (h.gust > profile.gustMax) reasons.push('gust');
  // Écart rafales/vent : n'est un signe de turbulence que si les rafales elles-mêmes sont fortes
  // (par vent faible, les rafales thermiques prévues à 10 m sont souvent 2 à 3 fois le vent moyen).
  if (h.gust - h.wind > profile.gustSpread && h.gust >= rules.turbulentGustRatio * profile.gustMax) {
    reasons.push('turbulence');
  }
  if (h.wind850 != null && h.wind850 > profile.wind850Max) reasons.push('wind850');
  // Altitude inconnue : on applique la règle par prudence.
  if ((spot.alt == null || spot.alt >= rules.lowCloudMinAlt) && (h.cloudLow ?? 0) > rules.lowCloudMax) reasons.push('cloud');

  const calm = h.wind < rules.calmWind;
  const orient = orientationFactor(h.dir, spot.orient, spot.orientOk);
  if (!calm && orient === 0) reasons.push('orientation');

  if (reasons.length) return { ok: false, reasons, quality: 0, orient };

  // Qualité (0 à 1) : produit de facteurs de confort, 1 = conditions idéales.
  const [idealMin, idealMax] = profile.idealWind;
  let fWind = 1;
  if (h.wind < idealMin) fWind = 0.85;
  else if (h.wind > idealMax) fWind = 1 - 0.5 * clamp01((h.wind - idealMax) / (profile.windMax - idealMax));
  // Rafales jugées sur leur valeur absolue, rapportée à la limite du profil.
  const fGust = 1 - 0.45 * clamp01((h.gust - 0.4 * profile.gustMax) / (0.6 * profile.gustMax));
  // Orientation inconnue : traitée comme un vent de travers. Vent calme : sa direction compte peu.
  const fOrient = orient == null ? 0.6 : calm ? (orient === 1 ? 1 : 0.85) : orient;
  const c = h.cloud;
  const fCloud = c == null ? 0.9 : c < 10 ? 0.95 : c <= 70 ? 1 : c <= 90 ? 0.8 : 0.6;
  const cape = h.cape ?? 0;
  const fCape = cape < 400 ? 1 : cape < 1000 ? 0.85 : cape < 2000 ? 0.65 : 0.45;
  const r850 = h.wind850 == null ? 0 : h.wind850 / profile.wind850Max;
  const f850 = r850 <= 0.6 ? 1 : 1 - 0.5 * clamp01((r850 - 0.6) / 0.4);
  const fRain = (h.rain ?? 0) > 0 ? 0.9 : 1;

  return { ok: true, reasons, quality: fWind * fGust * fOrient * fCloud * fCape * f850 * fRain, orient };
}

/** Bonus de durée d'un créneau : 0,85 pour 2 h, plein à partir de 4 h. */
export const durationFactor = (hours) => Math.min(1, 0.7 + 0.075 * hours);

/**
 * Meilleur créneau : la suite d'au moins `minHours` heures volables consécutives qui maximise
 * qualité moyenne × bonus de durée. (Prendre simplement la plus longue suite pénaliserait un
 * pilote confirmé, dont le créneau s'étend sur des heures ventées que le débutant n'a pas.)
 * À valeur égale, le créneau le plus long, puis le plus tôt.
 */
export function bestBlock(evaluated, minHours = 1) {
  let best = null;
  for (let i = 0; i < evaluated.length; i++) {
    let sum = 0;
    for (let j = i; j < evaluated.length && evaluated[j].ok; j++) {
      sum += evaluated[j].quality;
      const length = j - i + 1;
      if (length < minHours) continue;
      const mean = sum / length;
      const value = mean * durationFactor(length);
      if (!best || value > best.value + 1e-9 || (Math.abs(value - best.value) <= 1e-9 && length > best.length)) {
        best = { from: i, to: j + 1, length, mean, value };
      }
    }
  }
  return best;
}

/** Nombre maximal d'heures volables consécutives. */
function longestRun(evaluated) {
  let run = 0;
  let max = 0;
  for (const e of evaluated) {
    run = e.ok ? run + 1 : 0;
    max = Math.max(max, run);
  }
  return max;
}

/**
 * Juge une journée pour un spot à partir des heures du créneau de vol.
 * @param {object[]} hours  heures déjà filtrées sur le créneau (voir evaluateHour pour le format)
 */
export function evaluateDay(hours, spot, profile, rules = WEATHER_RULES) {
  const evaluated = hours.map((h) => ({ ...h, ...evaluateHour(h, spot, profile, rules) }));
  // Même critère que orientationFactor (qui ignore les codes de secteur inconnus).
  const orientationUnknown = orientationFactor(0, spot.orient, spot.orientOk) === null;
  const warnings = [];
  if (orientationUnknown) warnings.push("Orientation du déco inconnue : vérifie-la avant d'y aller");

  const base = { evaluated, orientationUnknown, warnings, block: null, meteoScore: 0 };
  if (!evaluated.length || evaluated.every((e) => e.reasons.includes('nodata'))) {
    return { ...base, flyable: false, mainReason: 'Pas de prévision disponible pour ce créneau' };
  }

  const thunder = evaluated.filter((e) => e.reasons.includes('thunder'));
  if (thunder.length) {
    return { ...base, flyable: false, mainReason: `Orage prévu (${thunder.map((e) => fmtHour(e.hour)).join(', ')})` };
  }

  const block = bestBlock(evaluated, rules.minBlockHours);
  if (!block) {
    const run = longestRun(evaluated);
    return { ...base, flyable: false, mainReason: explainNoGo(evaluated, spot, run ? { length: run } : null) };
  }

  const inBlock = evaluated.slice(block.from, block.to);
  const meteoScore = Math.round(100 * block.value);
  const maxCape = Math.max(...inBlock.map((e) => e.cape ?? 0));
  if (maxCape >= 1000) warnings.push(`Air instable (CAPE ${Math.round(maxCape)} J/kg) : surveille le développement des cumulus`);
  const rainLater = evaluated.slice(block.to).find((e) => e.reasons.includes('rain'));
  if (rainLater) warnings.push(`Pluie attendue à partir de ${fmtHour(rainLater.hour)}`);

  return {
    ...base,
    flyable: true,
    mainReason: null,
    meteoScore,
    flyableHours: evaluated.filter((e) => e.ok).length,
    block: {
      start: inBlock[0].hour,
      end: inBlock[inBlock.length - 1].hour + 1,
      hours: block.length,
      wind: Math.round(mean(inBlock.map((e) => e.wind))),
      gust: Math.round(Math.max(...inBlock.map((e) => e.gust))),
      dirDeg: Math.round(circularMean(inBlock.map((e) => e.dir))),
      dir: sectorOf(circularMean(inBlock.map((e) => e.dir))),
      cloud: Math.round(mean(inBlock.map((e) => e.cloud ?? 0))),
      wind850: inBlock.some((e) => e.wind850 != null) ? Math.round(Math.max(...inBlock.map((e) => e.wind850 ?? 0))) : null,
    },
  };
}

/** Phrase courte expliquant pourquoi la journée est éliminée (la cause la plus fréquente). */
export function explainNoGo(evaluated, spot, block) {
  const counts = {};
  for (const e of evaluated) for (const r of e.reasons) counts[r] = (counts[r] ?? 0) + 1;
  const order = ['rain', 'wind', 'gust', 'orientation', 'wind850', 'turbulence', 'cloud', 'fog', 'nodata'];
  const top = order.filter((r) => counts[r]).sort((a, b) => counts[b] - counts[a])[0];
  const hit = evaluated.filter((e) => e.reasons.includes(top));
  const max = (k) => Math.round(Math.max(...hit.map((e) => e[k] ?? 0)));
  const span = hit.length ? `${fmtHour(hit[0].hour)}–${fmtHour(hit[hit.length - 1].hour + 1)}` : '';
  switch (top) {
    case 'rain':
      return `Pluie (${span}, ${round1(hit.reduce((s, e) => s + (e.rain ?? 0), 0)).toString().replace('.', ',')} mm)`;
    case 'wind':
      return `Vent trop fort (jusqu'à ${max('wind')} km/h)`;
    case 'gust':
      return `Rafales trop fortes (jusqu'à ${max('gust')} km/h)`;
    case 'orientation': {
      const dir = sectorOf(circularMean(hit.map((e) => e.dir)));
      return `Vent mal orienté (${dir} pour un déco ${formatOrientations([...(spot.orient ?? []), ...(spot.orientOk ?? [])])})`;
    }
    case 'wind850':
      return `Vent trop fort en altitude (${max('wind850')} km/h vers 1 500 m)`;
    case 'turbulence':
      return `Air turbulent (rafales jusqu'à +${Math.round(Math.max(...hit.map((e) => e.gust - e.wind)))} km/h)`;
    case 'cloud':
      return `Déco probablement dans le nuage (nuages bas ${max('cloudLow')} %)`;
    case 'fog':
      return 'Brouillard';
    case 'nodata':
      return 'Prévision incomplète sur le créneau';
    default:
      return block ? `Créneau trop court (${block.length} h volable)` : 'Conditions non volables';
  }
}

/** Score trajet (0 à 100) à partir de la durée aller (h) et du coût aller-retour par personne (€). */
export function travelScore({ hours, euros }, weights = SCORE_WEIGHTS, scale = TRAVEL_SCALE) {
  if (hours == null) return 0;
  const t = 1 - clamp01((hours - scale.fullScoreHours) / (scale.zeroScoreHours - scale.fullScoreHours));
  const c = euros == null ? t : 1 - clamp01((euros - scale.fullScoreEuros) / (scale.zeroScoreEuros - scale.fullScoreEuros));
  return Math.round(100 * (weights.trajetTemps * t + (1 - weights.trajetTemps) * c));
}

/** Score global : 0 si la météo élimine, sinon moyenne pondérée météo / trajet. */
export function globalScore(day, travel, weights = SCORE_WEIGHTS) {
  if (!day.flyable) return 0;
  return Math.round(weights.meteo * day.meteoScore + weights.trajet * travel);
}

/** Verdict : « go » exige aussi une bonne météo, et une orientation connue. */
export function verdictOf(score, day, v = VERDICTS) {
  if (!day.flyable || !Number.isFinite(score) || score < v.jouable.minScore) return 'non';
  if (score >= v.go.minScore && day.meteoScore >= v.go.minMeteo && !day.orientationUnknown) return 'go';
  return 'jouable';
}

function mean(xs) {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

/** Moyenne de directions (en degrés), qui gère le passage par le nord. */
export function circularMean(degs) {
  const s = degs.reduce((a, d) => a + Math.sin((d * Math.PI) / 180), 0);
  const c = degs.reduce((a, d) => a + Math.cos((d * Math.PI) / 180), 0);
  return (((Math.atan2(s, c) * 180) / Math.PI) + 360) % 360;
}
