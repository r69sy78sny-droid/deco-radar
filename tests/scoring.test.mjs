// Tests unitaires du moteur de score (js/scoring.js et js/geo.js).
// Lancement : npm test (node --test tests/*.test.mjs). Aucune dépendance.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PROFILES, WEATHER_RULES, VERDICTS } from '../js/config.js';
import { SECTORS, angleDiff, sectorOf, orientationFactor, formatOrientations, haversineKm } from '../js/geo.js';
import {
  evaluateHour,
  bestBlock,
  durationFactor,
  evaluateDay,
  explainNoGo,
  travelScore,
  globalScore,
  verdictOf,
  circularMean,
} from '../js/scoring.js';

// ---------------------------------------------------------------------------
// Jeux de données
// ---------------------------------------------------------------------------

const DEB = PROFILES.debutant;
const PIL = PROFILES.pilote;
const CONF = PROFILES.confirme;
const PROFILS_ORDONNES = [DEB, PIL, CONF]; // du plus exigeant au plus souple

// Déco à 1 000 m, idéal au N, possible NE et NO.
const DECO = { alt: 1000, orient: ['N'], orientOk: ['NE', 'NO'] };
const DECO_INCONNU = { alt: 1000, orient: [], orientOk: [] };

/** Heure « parfaite » pour un débutant sur DECO (qualité 1), modifiable champ par champ. */
function heure(modifs = {}) {
  return { hour: 12, wind: 10, gust: 10, dir: 0, rain: 0, cloud: 40, cloudLow: 0, code: 1, cape: 100, wind850: 10, ...modifs };
}

/** Créneau de `n` heures à partir de `debut` ; `modifs[i]` modifie la i-ème heure. */
function creneau(n, modifs = {}, debut = 10) {
  return Array.from({ length: n }, (_, i) => heure({ hour: debut + i, ...(modifs[i] ?? {}) }));
}

/** Heures évaluées, au format attendu par bestBlock / explainNoGo. */
function evaluer(heures, deco = DECO, profil = DEB) {
  return heures.map((h) => ({ ...h, ...evaluateHour(h, deco, profil) }));
}

const motifs = (modifs, deco = DECO, profil = DEB) => evaluateHour(heure(modifs), deco, profil).reasons;
const proche = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} n'est pas proche de ${b}`);
const RANG_VERDICT = { non: 0, jouable: 1, go: 2 };

// Générateur pseudo-aléatoire reproductible (mulberry32) pour les tests de propriétés.
function alea(graine) {
  let s = graine >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function decoAleatoire(r) {
  if (r() < 0.15) return { alt: 800, orient: [], orientOk: [] };
  const i = Math.floor(r() * 8);
  const orientOk = r() < 0.5 ? [SECTORS[(i + 1) % 8], SECTORS[(i + 7) % 8]] : [];
  return { alt: 200 + r() * 1800, orient: [SECTORS[i]], orientOk };
}

function heureAleatoire(r, hour = 12) {
  const wind = r() * 40;
  return {
    hour,
    wind,
    gust: wind + r() * 20,
    dir: r() * 360,
    rain: r() < 0.7 ? 0 : r() * 1.5,
    cloud: r() * 100,
    cloudLow: r() * 100,
    code: r() < 0.05 ? 95 : r() < 0.1 ? 45 : 2,
    cape: r() * 2500,
    wind850: r() < 0.1 ? null : r() * 60,
  };
}

/** Journée plausible : vent de base + tendance + bruit, pour obtenir assez de journées volables. */
function journeeAleatoire(r, n = 8) {
  const w0 = r() * 28;
  const tendance = (r() - 0.4) * 4;
  const d0 = r() * 360;
  const ecart = r() * 12;
  const w850 = r() * 55;
  return Array.from({ length: n }, (_, i) => {
    const wind = Math.max(0, w0 + tendance * i + (r() - 0.5) * 6);
    return {
      hour: 10 + i,
      wind,
      gust: wind + ecart * r() * 1.5,
      dir: (d0 + (r() - 0.5) * 60 + 360) % 360,
      rain: r() < 0.85 ? 0 : r(),
      cloud: r() * 100,
      cloudLow: r() < 0.9 ? r() * 60 : 95,
      code: r() < 0.01 ? 95 : r() < 0.03 ? 45 : 2,
      cape: r() * 1500,
      wind850: Math.max(0, w850 + (r() - 0.5) * 10),
    };
  });
}

// ---------------------------------------------------------------------------
// geo.js
// ---------------------------------------------------------------------------

describe('angleDiff', () => {
  test('écart le plus court en passant par le nord (350° vs 10°)', () => {
    assert.equal(angleDiff(350, 10), 20);
    assert.equal(angleDiff(10, 350), 20);
  });

  test('angles opposés, négatifs ou au-delà de 360°', () => {
    assert.equal(angleDiff(0, 180), 180);
    assert.equal(angleDiff(-90, 90), 180);
    assert.equal(angleDiff(370, 10), 0);
    assert.equal(angleDiff(720, 0), 0);
    assert.equal(angleDiff(45, 0), 45);
  });

  test('toujours entre 0 et 180° et symétrique', () => {
    const r = alea(1);
    for (let i = 0; i < 2000; i++) {
      const a = (r() - 0.5) * 1440;
      const b = (r() - 0.5) * 1440;
      const d = angleDiff(a, b);
      assert.ok(d >= 0 && d <= 180, `angleDiff(${a}, ${b}) = ${d}`);
      proche(d, angleDiff(b, a));
    }
  });
});

describe('sectorOf', () => {
  test('passage par le nord : 350° et 10° sont au N', () => {
    assert.equal(sectorOf(350), 'N');
    assert.equal(sectorOf(10), 'N');
    assert.equal(sectorOf(0), 'N');
    assert.equal(sectorOf(360), 'N');
  });

  test('centre de chaque secteur', () => {
    SECTORS.forEach((s, i) => assert.equal(sectorOf(i * 45), s));
  });

  test('limites entre secteurs et angles hors [0, 360[', () => {
    assert.equal(sectorOf(22), 'N');
    assert.equal(sectorOf(23), 'NE');
    assert.equal(sectorOf(337), 'NO');
    assert.equal(sectorOf(338), 'N');
    assert.equal(sectorOf(-45), 'NO');
    assert.equal(sectorOf(-10), 'N');
    assert.equal(sectorOf(765), 'NE');
  });
});

describe('orientationFactor', () => {
  test("dans l'axe (≤ 22,5° d'un secteur idéal) = 1", () => {
    assert.equal(orientationFactor(0, ['N']), 1);
    assert.equal(orientationFactor(20, ['N']), 1);
    assert.equal(orientationFactor(350, ['N']), 1);
    assert.equal(orientationFactor(22.5, ['N']), 1);
  });

  test("travers (≤ 45° d'un secteur idéal) = 0,6", () => {
    assert.equal(orientationFactor(40, ['N']), 0.6);
    assert.equal(orientationFactor(45, ['N']), 0.6);
    assert.equal(orientationFactor(315, ['N']), 0.6);
  });

  test('vent de dos ou très de travers = 0', () => {
    assert.equal(orientationFactor(180, ['N']), 0);
    assert.equal(orientationFactor(90, ['N']), 0);
    assert.equal(orientationFactor(46, ['N']), 0);
  });

  test("secteurs orientOk : 0,6 jusqu'à 22,5° du secteur", () => {
    assert.equal(orientationFactor(90, ['N'], ['E']), 0.6);
    assert.equal(orientationFactor(110, ['N'], ['E']), 0.6);
    assert.equal(orientationFactor(115, ['N'], ['E']), 0);
    assert.equal(orientationFactor(180, [], ['S']), 0.6);
    assert.equal(orientationFactor(0, [], ['S']), 0);
  });

  test("un secteur idéal l'emporte sur un secteur orientOk", () => {
    assert.equal(orientationFactor(0, ['N'], ['N']), 1);
    assert.equal(orientationFactor(45, ['NE'], ['N']), 1);
  });

  test('orientation inconnue = null (listes vides, absentes ou null)', () => {
    assert.equal(orientationFactor(0, [], []), null);
    assert.equal(orientationFactor(0), null);
    assert.equal(orientationFactor(0, undefined, undefined), null);
    assert.equal(orientationFactor(0, null, null), null);
    assert.equal(orientationFactor(0, null, ['N']), 0.6);
  });

  test('codes hors des 8 secteurs français ignorés', () => {
    assert.equal(orientationFactor(270, ['W']), null);
    assert.equal(orientationFactor(0, ['NNO', 'nord'], ['SW']), null);
    assert.equal(orientationFactor(270, ['W', 'O']), 1);
    assert.equal(orientationFactor(225, ['N'], ['SW']), 0);
  });
});

describe('formatOrientations et haversineKm', () => {
  test("libellé dans l'ordre de la rose", () => {
    assert.equal(formatOrientations(['NO', 'O', 'N']), 'N-O-NO');
    assert.equal(formatOrientations([]), '');
  });

  test('distance Paris–Lyon ≈ 392 km', () => {
    const d = haversineKm({ lat: 48.8566, lon: 2.3522 }, { lat: 45.764, lon: 4.8357 });
    assert.ok(Math.abs(d - 392) < 3, `${d}`);
  });
});

// ---------------------------------------------------------------------------
// evaluateHour
// ---------------------------------------------------------------------------

describe('evaluateHour', () => {
  test('heure idéale : volable, qualité 1', () => {
    const e = evaluateHour(heure(), DECO, DEB);
    assert.deepEqual(e, { ok: true, reasons: [], quality: 1, orient: 1 });
  });

  test('pluie : éliminée à partir de 0,2 mm/h', () => {
    assert.deepEqual(motifs({ rain: 0.2 }), ['rain']);
    assert.deepEqual(motifs({ rain: 1.5 }), ['rain']);
    const bruine = evaluateHour(heure({ rain: 0.19 }), DECO, DEB);
    assert.equal(bruine.ok, true);
    proche(bruine.quality, 0.9);
    assert.equal(evaluateHour(heure({ rain: null }), DECO, DEB).ok, true);
  });

  test('orage : codes WMO 95, 96 et 99', () => {
    for (const code of [95, 96, 99]) assert.deepEqual(motifs({ code }), ['thunder']);
    assert.equal(evaluateHour(heure({ code: 3 }), DECO, DEB).ok, true);
  });

  test('brouillard : codes WMO 45 et 48', () => {
    for (const code of [45, 48]) assert.deepEqual(motifs({ code }), ['fog']);
  });

  test('vent moyen au-dessus du maximum du profil', () => {
    assert.equal(evaluateHour(heure({ wind: 20, gust: 20 }), DECO, DEB).ok, true); // limite incluse
    assert.deepEqual(motifs({ wind: 21, gust: 21 }), ['wind']);
    assert.equal(evaluateHour(heure({ wind: 21, gust: 21 }), DECO, PIL).ok, true);
  });

  test('rafales au-dessus du maximum du profil', () => {
    assert.equal(evaluateHour(heure({ wind: 18, gust: 25 }), DECO, DEB).ok, true);
    assert.deepEqual(motifs({ wind: 18, gust: 26 }), ['gust']);
  });

  test('turbulence : écart rafales − vent > gustSpread ET rafales ≥ 75 % de gustMax', () => {
    assert.equal(WEATHER_RULES.turbulentGustRatio, 0.75);
    // Débutant : gustSpread 10 km/h, rafales « fortes » à partir de 18,75 km/h.
    const faible = evaluateHour(heure({ wind: 5, gust: 16 }), DECO, DEB); // écart 11, rafales faibles
    assert.equal(faible.ok, true);
    proche(faible.quality, 1 - 0.45 * (6 / 15));
    assert.deepEqual(motifs({ wind: 10, gust: 21 }), ['turbulence']);
    assert.deepEqual(motifs({ wind: 8, gust: 18.75 }), ['turbulence']); // seuil de rafales inclus
    assert.equal(evaluateHour(heure({ wind: 8, gust: 18.7 }), DECO, DEB).ok, true);
    assert.equal(evaluateHour(heure({ wind: 10, gust: 20 }), DECO, DEB).ok, true); // écart 10 = limite
    // Confirmé : gustSpread 15 km/h, seuil de rafales 28,5 km/h.
    assert.equal(evaluateHour(heure({ wind: 10, gust: 27 }), DECO, CONF).ok, true);
    assert.deepEqual(motifs({ wind: 12, gust: 29 }, DECO, CONF), ['turbulence']);
  });

  test('vent à 850 hPa trop fort ; valeur absente = pas de critère', () => {
    assert.equal(evaluateHour(heure({ wind850: 30 }), DECO, DEB).ok, true);
    assert.deepEqual(motifs({ wind850: 31 }), ['wind850']);
    assert.equal(evaluateHour(heure({ wind850: null }), DECO, DEB).ok, true);
    assert.equal(evaluateHour(heure({ wind850: undefined }), DECO, DEB).ok, true);
  });

  test('nuages bas : éliminatoires à partir de 600 m, pas en dessous', () => {
    assert.deepEqual(motifs({ cloudLow: 95 }, { ...DECO, alt: 1200 }), ['cloud']);
    assert.deepEqual(motifs({ cloudLow: 95 }, { ...DECO, alt: 600 }), ['cloud']);
    assert.equal(evaluateHour(heure({ cloudLow: 95 }), { ...DECO, alt: 500 }, DEB).ok, true);
    assert.equal(evaluateHour(heure({ cloudLow: 90 }), { ...DECO, alt: 1200 }, DEB).ok, true);
  });

  test("nuages bas : règle appliquée par prudence quand l'altitude est inconnue", () => {
    assert.deepEqual(motifs({ cloudLow: 100 }, { orient: ['N'], orientOk: [] }), ['cloud']);
    assert.deepEqual(motifs({ cloudLow: 100 }, { ...DECO, alt: null }), ['cloud']);
    assert.equal(evaluateHour(heure({ cloudLow: 50 }), { ...DECO, alt: null }, DEB).ok, true);
    assert.equal(evaluateHour(heure({ cloudLow: null }), { ...DECO, alt: null }, DEB).ok, true);
  });

  test('vent mal orienté : éliminatoire', () => {
    const e = evaluateHour(heure({ dir: 180 }), DECO, DEB);
    assert.deepEqual(e.reasons, ['orientation']);
    assert.equal(e.orient, 0);
    assert.deepEqual(motifs({ dir: 135, wind: 6, gust: 6 }), ['orientation']);
  });

  test("vent calme (< 6 km/h) : la direction n'est pas éliminatoire", () => {
    for (const wind of [0, 3, 5, 5.9]) {
      const e = evaluateHour(heure({ dir: 180, wind, gust: wind }), DECO, DEB);
      assert.equal(e.ok, true, `vent ${wind} km/h`);
      assert.equal(e.orient, 0);
    }
    assert.deepEqual(motifs({ dir: 180, wind: 6, gust: 6 }), ['orientation']);
  });

  test("vent calme : qualité × 1 dans l'axe, × 0,85 sinon", () => {
    const q = (dir) => evaluateHour(heure({ dir, wind: 5, gust: 5 }), DECO, DEB).quality;
    proche(q(0), 1);
    proche(q(45), 0.85); // travers
    proche(q(180), 0.85); // de dos
  });

  test('vent de travers : volable avec qualité × 0,6', () => {
    const e = evaluateHour(heure({ dir: 45 }), DECO, DEB); // NE est en orientOk
    assert.equal(e.ok, true);
    assert.equal(e.orient, 0.6);
    proche(e.quality, 0.6);
  });

  test('orientation inconnue : jamais éliminée pour la direction, qualité × 0,6 (comme un travers)', () => {
    for (const deco of [DECO_INCONNU, { alt: 1000 }, { alt: 1000, orient: null, orientOk: null }, { alt: 1000, orient: ['W'] }]) {
      for (const dir of [0, 90, 180, 270]) {
        const e = evaluateHour(heure({ dir }), deco, DEB);
        assert.equal(e.ok, true);
        assert.equal(e.orient, null);
        proche(e.quality, 0.6);
      }
    }
    // Par vent calme aussi.
    proche(evaluateHour(heure({ wind: 5, gust: 5 }), DECO_INCONNU, DEB).quality, 0.6);
  });

  test('données manquantes (vent, rafales ou direction) : non volable', () => {
    for (const k of ['wind', 'gust', 'dir']) {
      for (const v of [null, undefined]) {
        assert.deepEqual(evaluateHour(heure({ [k]: v }), DECO, DEB), { ok: false, reasons: ['nodata'], quality: 0, orient: null });
      }
    }
  });

  test("données manquantes mais code d'orage : l'orage est quand même signalé", () => {
    assert.deepEqual(motifs({ gust: null, code: 95 }), ['thunder', 'nodata']);
  });

  test('plusieurs motifs se cumulent', () => {
    const r = motifs({ wind: 30, gust: 45, dir: 180, rain: 1, wind850: 60, cloudLow: 100 });
    for (const m of ['rain', 'wind', 'gust', 'turbulence', 'wind850', 'cloud', 'orientation']) assert.ok(r.includes(m), m);
  });

  test('vent sous le vent idéal : qualité × 0,85', () => {
    const q = (wind) => evaluateHour(heure({ wind, gust: wind }), DECO, DEB).quality;
    proche(q(4), 0.85);
    proche(q(0), 0.85);
    proche(q(5), 1);
  });

  test('vent au-dessus du vent idéal : jusqu\'à × 0,5 à la limite du profil', () => {
    // Débutant : idéal jusqu'à 15 km/h, limite 20 ; rafales fixées à 10 pour isoler le facteur vent.
    proche(evaluateHour(heure({ wind: 17.5, gust: 10 }), DECO, DEB).quality, 0.75);
    proche(evaluateHour(heure({ wind: 20, gust: 10 }), DECO, DEB).quality, 0.5);
  });

  test('rafales jugées sur leur valeur absolue, rapportée à gustMax', () => {
    const q = (wind, gust, profil = DEB) => evaluateHour(heure({ wind, gust }), DECO, profil).quality;
    // Débutant (gustMax 25) : aucune pénalité jusqu'à 10 km/h (0,4 × 25), × 0,55 à 25 km/h.
    proche(q(10, 10), 1);
    proche(q(5, 8), 1);
    proche(q(10, 17.5), 0.775);
    proche(q(15, 15), 0.85);
    proche(q(15, 25), 0.55);
    // Même rafale, profil plus souple : pénalité moindre.
    proche(q(15, 25, CONF), 1 - (0.45 * (25 - 0.4 * 38)) / (0.6 * 38));
  });

  test('couverture nuageuse : absente 0,9 ; < 10 % 0,95 ; 10–70 % 1 ; ≤ 90 % 0,8 ; au-delà 0,6', () => {
    const cas = [[null, 0.9], [undefined, 0.9], [0, 0.95], [9, 0.95], [10, 1], [70, 1], [80, 0.8], [90, 0.8], [95, 0.6]];
    for (const [cloud, f] of cas) proche(evaluateHour(heure({ cloud }), DECO, DEB).quality, f);
  });

  test('CAPE et vent à 850 hPa', () => {
    proche(evaluateHour(heure({ cape: 500 }), DECO, DEB).quality, 0.85);
    proche(evaluateHour(heure({ cape: 1500 }), DECO, DEB).quality, 0.65);
    proche(evaluateHour(heure({ cape: 2500 }), DECO, DEB).quality, 0.45);
    proche(evaluateHour(heure({ wind850: 18 }), DECO, DEB).quality, 1);
    proche(evaluateHour(heure({ wind850: 24 }), DECO, DEB).quality, 0.75);
  });
});

// ---------------------------------------------------------------------------
// bestBlock et durationFactor
// ---------------------------------------------------------------------------

const OK = (quality = 1) => ({ ok: true, quality });
const KO = { ok: false, quality: 0 };

/** Référence naïve : meilleure valeur moyenne × durationFactor sur toutes les fenêtres volables. */
function meilleureValeurNaive(evaluated, minHours) {
  let best = null;
  for (let i = 0; i < evaluated.length; i++) {
    for (let j = i + minHours; j <= evaluated.length; j++) {
      const s = evaluated.slice(i, j);
      if (!s.every((e) => e.ok)) break;
      const v = (s.reduce((a, e) => a + e.quality, 0) / s.length) * durationFactor(s.length);
      if (best === null || v > best) best = v;
    }
  }
  return best;
}

describe('durationFactor', () => {
  test('0,775 pour 1 h, 0,85 pour 2 h, 0,925 pour 3 h, plafonné à 1 dès 4 h', () => {
    proche(durationFactor(1), 0.775);
    proche(durationFactor(2), 0.85);
    proche(durationFactor(3), 0.925);
    assert.equal(durationFactor(4), 1);
    assert.equal(durationFactor(10), 1);
  });
});

describe('bestBlock', () => {
  test('aucune fenêtre assez longue : null', () => {
    assert.equal(bestBlock([]), null);
    assert.equal(bestBlock([KO, KO, KO]), null);
    assert.equal(bestBlock([OK(), KO, OK()], 2), null);
    assert.equal(bestBlock([OK(), OK()], 3), null);
  });

  test('objet renvoyé : from, to, length, mean et value = mean × durationFactor(length)', () => {
    const b = bestBlock([KO, OK(1), OK(0.8), KO], 2);
    assert.equal(b.from, 1);
    assert.equal(b.to, 3);
    assert.equal(b.length, 2);
    proche(b.mean, 0.9);
    proche(b.value, 0.9 * 0.85);
  });

  test('retient le meilleur créneau, pas le plus long', () => {
    const b = bestBlock([OK(1), OK(1), OK(1), OK(0.3), OK(0.3), OK(0.3), OK(0.3)], 2);
    assert.deepEqual([b.from, b.to, b.length], [0, 3, 3]);
    proche(b.value, 0.925);
  });

  test("peut ne garder qu'une partie d'une suite volable", () => {
    const b = bestBlock([OK(0.3), OK(1), OK(1), OK(1), OK(1), OK(0.3)], 2);
    assert.deepEqual([b.from, b.to, b.length], [1, 5, 4]);
    proche(b.value, 1);
  });

  test('minHours par défaut = 1 : une heure isolée excellente peut gagner', () => {
    const b = bestBlock([OK(0.5), OK(1), KO]);
    assert.deepEqual([b.from, b.length], [1, 1]);
    proche(b.value, 0.775);
  });

  test('à valeur égale : le plus long, puis le plus tôt', () => {
    // 4 h puis 5 h parfaites : valeur 1 dans les deux cas → la plus longue, même plus tardive.
    const long = bestBlock([OK(), OK(), OK(), OK(), KO, OK(), OK(), OK(), OK(), OK()], 2);
    assert.deepEqual([long.from, long.length], [5, 5]);
    // Suite de 6 h parfaites : toute la suite.
    assert.equal(bestBlock([OK(), OK(), OK(), OK(), OK(), OK()], 2).length, 6);
    // Deux créneaux identiques : le premier.
    const tot = bestBlock([OK(0.8), OK(0.8), KO, OK(0.8), OK(0.8)], 2);
    assert.deepEqual([tot.from, tot.length], [0, 2]);
  });

  test('égale la référence naïve sur des données aléatoires', () => {
    const r = alea(5);
    for (let i = 0; i < 2000; i++) {
      const ev = Array.from({ length: 1 + Math.floor(r() * 12) }, () => (r() < 0.25 ? KO : OK(0.3 + 0.7 * r())));
      const minHours = 1 + Math.floor(r() * 3);
      const b = bestBlock(ev, minHours);
      const ref = meilleureValeurNaive(ev, minHours);
      if (ref === null) {
        assert.equal(b, null);
        continue;
      }
      proche(b.value, ref);
      assert.ok(b.length >= minHours);
      assert.ok(ev.slice(b.from, b.to).every((e) => e.ok));
      proche(b.mean, ev.slice(b.from, b.to).reduce((a, e) => a + e.quality, 0) / b.length);
    }
  });
});

// ---------------------------------------------------------------------------
// evaluateDay
// ---------------------------------------------------------------------------

describe('evaluateDay', () => {
  test('journée parfaite de 10 h à 18 h : volable, bloc et meteoScore cohérents', () => {
    const j = evaluateDay(creneau(8), DECO, DEB);
    assert.equal(j.flyable, true);
    assert.equal(j.mainReason, null);
    assert.equal(j.meteoScore, 100);
    assert.equal(j.flyableHours, 8);
    assert.equal(j.orientationUnknown, false);
    assert.deepEqual(j.warnings, []);
    assert.deepEqual(j.block, { start: 10, end: 18, hours: 8, wind: 10, gust: 10, dirDeg: 0, dir: 'N', cloud: 40, wind850: 10 });
    assert.equal(j.evaluated.length, 8);
  });

  test('meteoScore = round(100 × block.value) = qualité moyenne × facteur de durée', () => {
    // 3 h volables (10 h–13 h) dont une à CAPE 1 500 (× 0,65), puis pluie.
    const heures = creneau(5, { 1: { cape: 1500 }, 3: { rain: 0.5 }, 4: { rain: 0.5 } });
    const j = evaluateDay(heures, DECO, DEB);
    assert.equal(j.flyable, true);
    assert.equal(j.block.start, 10);
    assert.equal(j.block.end, 13);
    assert.equal(j.block.hours, 3);
    assert.equal(j.flyableHours, 3);
    assert.equal(j.meteoScore, Math.round(100 * ((1 + 0.65 + 1) / 3) * 0.925));
    assert.ok(j.warnings.includes('Air instable (CAPE 1500 J/kg) : surveille le développement des cumulus'));
    assert.ok(j.warnings.includes('Pluie attendue à partir de 13h'));
  });

  test('facteur de durée : 2 h = 85, 4 h et plus = 100', () => {
    assert.equal(evaluateDay(creneau(2), DECO, DEB).meteoScore, 85);
    assert.equal(evaluateDay(creneau(4), DECO, DEB).meteoScore, 100);
  });

  test("bloc affiché = meilleur créneau ; flyableHours compte toutes les heures volables", () => {
    // Matinée parfaite, après-midi volable mais venté (qualité ≈ 0,53 pour un débutant).
    const vente = { wind: 18, gust: 18 };
    const j = evaluateDay(creneau(8, { 3: vente, 4: vente, 5: vente, 6: vente, 7: vente }), DECO, DEB);
    assert.equal(j.flyable, true);
    assert.equal(j.flyableHours, 8);
    assert.deepEqual([j.block.start, j.block.end, j.block.hours], [10, 13, 3]);
    assert.equal(j.meteoScore, 93);
  });

  test('bloc cohérent et optimal sur des données aléatoires', () => {
    const r = alea(7);
    let volables = 0;
    for (let i = 0; i < 1500; i++) {
      const deco = decoAleatoire(r);
      const j = evaluateDay(journeeAleatoire(r), deco, DEB);
      if (!j.flyable) {
        assert.equal(j.meteoScore, 0);
        assert.equal(j.block, null);
        assert.equal(typeof j.mainReason, 'string');
        assert.ok(j.mainReason.length > 0 && !/undefined|NaN|Infinity/.test(j.mainReason), j.mainReason);
        continue;
      }
      volables++;
      const b = bestBlock(j.evaluated, WEATHER_RULES.minBlockHours);
      const bloc = j.evaluated.slice(b.from, b.to);
      assert.ok(bloc.every((e) => e.ok));
      assert.equal(j.block.start, bloc[0].hour);
      assert.equal(j.block.hours, b.length);
      assert.equal(j.block.end - j.block.start, j.block.hours);
      assert.ok(j.block.hours >= WEATHER_RULES.minBlockHours);
      proche(b.value, meilleureValeurNaive(j.evaluated, WEATHER_RULES.minBlockHours));
      assert.equal(j.meteoScore, Math.round(100 * b.value));
      assert.ok(j.meteoScore >= 0 && j.meteoScore <= 100);
      assert.equal(j.flyableHours, j.evaluated.filter((e) => e.ok).length);
      assert.ok(j.flyableHours >= j.block.hours);
      assert.ok(j.block.dirDeg >= 0 && j.block.dirDeg <= 360);
      assert.equal(sectorOf(j.block.dirDeg), j.block.dir);
    }
    assert.ok(volables > 100, `trop peu de journées volables générées (${volables})`);
  });

  test("orage à n'importe quelle heure : journée éliminée", () => {
    const j = evaluateDay(creneau(8, { 7: { code: 95 } }), DECO, DEB);
    assert.equal(j.flyable, false);
    assert.equal(j.meteoScore, 0);
    assert.equal(j.block, null);
    assert.equal(j.mainReason, 'Orage prévu (17h)');
    assert.equal(evaluateDay(creneau(8, { 0: { code: 96 }, 3: { code: 99 } }), DECO, DEB).mainReason, 'Orage prévu (10h, 13h)');
  });

  test('orage sur une heure où le vent manque : journée quand même éliminée', () => {
    const j = evaluateDay(creneau(8, { 7: { code: 95, gust: null } }), DECO, DEB);
    assert.equal(j.flyable, false);
    assert.equal(j.mainReason, 'Orage prévu (17h)');
  });

  test('créneau volable de moins de 2 h : éliminée avec un motif lisible', () => {
    const vent = { wind: 24, gust: 24 };
    const j = evaluateDay(creneau(5, { 1: vent, 3: { wind: 26, gust: 26 }, 4: vent }), DECO, DEB);
    assert.equal(j.flyable, false);
    assert.equal(j.meteoScore, 0);
    assert.equal(j.block, null);
    assert.equal(j.mainReason, "Vent trop fort (jusqu'à 26 km/h)");
  });

  test("créneau d'une seule heure : « Créneau trop court »", () => {
    const j = evaluateDay(creneau(1), DECO, DEB);
    assert.equal(j.flyable, false);
    assert.equal(j.mainReason, 'Créneau trop court (1 h volable)');
  });

  test('pas de prévision : créneau vide ou uniquement des heures sans données', () => {
    const attendu = 'Pas de prévision disponible pour ce créneau';
    assert.equal(evaluateDay([], DECO, DEB).mainReason, attendu);
    const j = evaluateDay(creneau(4, { 0: { wind: null }, 1: { gust: null }, 2: { dir: null }, 3: { wind: null } }), DECO, DEB);
    assert.equal(j.flyable, false);
    assert.equal(j.mainReason, attendu);
  });

  test('orientation inconnue : avertissement, volable, mais jamais « go »', () => {
    const j = evaluateDay(creneau(8), DECO_INCONNU, DEB);
    assert.equal(j.flyable, true);
    assert.equal(j.orientationUnknown, true);
    assert.deepEqual(j.warnings, ["Orientation du déco inconnue : vérifie-la avant d'y aller"]);
    assert.equal(j.meteoScore, 60);
    assert.equal(verdictOf(globalScore(j, 100), j), 'jouable');
    // Champs absents ou null : même traitement, sans erreur.
    assert.equal(evaluateDay(creneau(8), { alt: 1000 }, DEB).orientationUnknown, true);
    assert.equal(evaluateDay(creneau(8), { alt: 1000, orient: null, orientOk: null }, DEB).orientationUnknown, true);
  });

  test('secteurs tous hors des 8 codes français : orientation inconnue, avertissement, jamais « go »', () => {
    const heures = creneau(8).map((h) => ({ ...h, dir: 180 }));
    const j = evaluateDay(heures, { alt: 1000, orient: ['W'], orientOk: ['SW'] }, DEB);
    assert.equal(j.flyable, true);
    assert.equal(j.orientationUnknown, true);
    assert.equal(j.warnings.length, 1);
    assert.equal(j.meteoScore, 60);
    assert.equal(verdictOf(globalScore(j, 100), j), 'jouable');
    // Un code valide suffit pour que l'orientation soit connue.
    assert.equal(evaluateDay(creneau(8), { alt: 1000, orient: ['W', 'N'] }, DEB).orientationUnknown, false);
  });

  test("altitude inconnue et nuages bas à 100 % : journée éliminée pour le nuage", () => {
    const heures = creneau(8).map((h) => ({ ...h, cloudLow: 100 }));
    const j = evaluateDay(heures, { orient: ['N'], orientOk: [] }, DEB);
    assert.equal(j.flyable, false);
    assert.equal(j.mainReason, 'Déco probablement dans le nuage (nuages bas 100 %)');
  });

  test('direction moyenne du bloc : passage par le nord', () => {
    const j = evaluateDay(creneau(4, { 0: { dir: 350 }, 1: { dir: 10 }, 2: { dir: 355 }, 3: { dir: 5 } }), DECO, DEB);
    assert.equal(j.block.dir, 'N');
    assert.ok(j.block.dirDeg === 0 || j.block.dirDeg === 360, `${j.block.dirDeg}`);
  });

  test('pas de vent à 850 hPa dans le bloc : wind850 = null', () => {
    const heures = creneau(3).map((h) => ({ ...h, wind850: null }));
    assert.equal(evaluateDay(heures, DECO, DEB).block.wind850, null);
  });
});

// ---------------------------------------------------------------------------
// explainNoGo
// ---------------------------------------------------------------------------

describe('explainNoGo', () => {
  const pluie = { rain: 0.5 };
  const vent = { wind: 25, gust: 25 };

  test('retient le motif le plus fréquent', () => {
    const heures = creneau(8, { 0: pluie, 1: pluie, 2: pluie, 3: pluie, 4: pluie, 5: vent, 6: vent, 7: vent });
    assert.equal(evaluateDay(heures, DECO, DEB).mainReason, 'Pluie (10h–15h, 2,5 mm)');
    const ventMajoritaire = creneau(5, { 0: pluie, 1: vent, 2: vent, 3: vent, 4: pluie });
    assert.equal(evaluateDay(ventMajoritaire, DECO, DEB).mainReason, "Vent trop fort (jusqu'à 25 km/h)");
  });

  test('à égalité : pluie, puis vent, puis rafales…', () => {
    const ev = evaluer(creneau(4, { 0: pluie, 1: vent, 2: pluie, 3: vent }));
    assert.match(explainNoGo(ev, DECO, null), /^Pluie/);
  });

  test('cumul de pluie arrondi au dixième, virgule décimale', () => {
    const ev = evaluer(creneau(2, { 0: { rain: 0.3 }, 1: { rain: 0.4 } }));
    assert.equal(explainNoGo(ev, DECO, null), 'Pluie (10h–12h, 0,7 mm)');
  });

  test('libellé de chaque motif, en français', () => {
    const cas = [
      [{ wind: 18, gust: 27 }, "Rafales trop fortes (jusqu'à 27 km/h)"],
      [{ dir: 180 }, 'Vent mal orienté (S pour un déco N-NE-NO)'],
      [{ wind850: 42.4 }, 'Vent trop fort en altitude (42 km/h vers 1 500 m)'],
      [{ wind: 8, gust: 20 }, "Air turbulent (rafales jusqu'à +12 km/h)"],
      [{ cloudLow: 97 }, 'Déco probablement dans le nuage (nuages bas 97 %)'],
      [{ code: 45 }, 'Brouillard'],
      [{ wind: null }, 'Prévision incomplète sur le créneau'],
    ];
    for (const [modifs, texte] of cas) {
      const ev = evaluer(creneau(3, { 0: modifs, 1: modifs, 2: modifs }));
      assert.equal(explainNoGo(ev, DECO, null), texte);
    }
  });

  test('aucun motif et créneau trop court', () => {
    const ev = evaluer(creneau(1));
    assert.equal(explainNoGo(ev, DECO, { length: 1 }), 'Créneau trop court (1 h volable)');
    assert.equal(explainNoGo([], DECO, null), 'Conditions non volables');
  });
});

// ---------------------------------------------------------------------------
// travelScore, globalScore, verdictOf
// ---------------------------------------------------------------------------

describe('travelScore', () => {
  test('1 h et 15 € ou moins : 100', () => {
    assert.equal(travelScore({ hours: 1, euros: 15 }), 100);
    assert.equal(travelScore({ hours: 0.2, euros: 0 }), 100);
  });

  test('8 h et 200 € ou plus : 0', () => {
    assert.equal(travelScore({ hours: 8, euros: 200 }), 0);
    assert.equal(travelScore({ hours: 12, euros: 500 }), 0);
  });

  test('durée inconnue : 0', () => {
    assert.equal(travelScore({ hours: null, euros: 10 }), 0);
    assert.equal(travelScore({ euros: 10 }), 0);
  });

  test('75 % durée, 25 % coût, interpolation linéaire', () => {
    assert.equal(travelScore({ hours: 8, euros: 15 }), 25);
    assert.equal(travelScore({ hours: 1, euros: 200 }), 75);
    assert.equal(travelScore({ hours: 4.5, euros: 107.5 }), 50);
  });

  test('coût inconnu : seule la durée compte', () => {
    assert.equal(travelScore({ hours: 4.5, euros: null }), 50);
    assert.equal(travelScore({ hours: 1, euros: undefined }), 100);
  });
});

describe('globalScore', () => {
  test("0 si la météo élimine la journée, quel que soit le trajet", () => {
    assert.equal(globalScore({ flyable: false, meteoScore: 0 }, 100), 0);
    assert.equal(globalScore(evaluateDay(creneau(8, { 3: { code: 95 } }), DECO, DEB), 100), 0);
  });

  test('60 % météo + 40 % trajet, arrondi', () => {
    assert.equal(globalScore({ flyable: true, meteoScore: 80 }, 50), 68);
    assert.equal(globalScore({ flyable: true, meteoScore: 100 }, 100), 100);
    assert.equal(globalScore({ flyable: true, meteoScore: 73 }, 41), 60);
  });
});

describe('verdictOf', () => {
  const jour = (meteoScore, orientationUnknown = false) => ({ flyable: true, meteoScore, orientationUnknown });

  test('journée non volable : « non », même avec un score élevé', () => {
    assert.equal(verdictOf(90, { flyable: false, meteoScore: 90 }), 'non');
  });

  test('« jouable » à partir de 40', () => {
    assert.equal(verdictOf(39, jour(80)), 'non');
    assert.equal(verdictOf(40, jour(80)), 'jouable');
  });

  test('« go » exige score ≥ 65, meteoScore ≥ 60 et orientation connue', () => {
    assert.equal(verdictOf(65, jour(60)), 'go');
    assert.equal(verdictOf(64, jour(90)), 'jouable');
    assert.equal(verdictOf(90, jour(59)), 'jouable');
    assert.equal(verdictOf(90, jour(90, true)), 'jouable');
  });

  test('score non fini (NaN, Infinity, absent) : « non »', () => {
    for (const s of [NaN, Infinity, -Infinity, undefined, null]) assert.equal(verdictOf(s, jour(90)), 'non', String(s));
    assert.equal(verdictOf(globalScore(jour(90), NaN), jour(90)), 'non');
  });

  test('seuils lus dans VERDICTS', () => {
    assert.equal(VERDICTS.go.minScore, 65);
    assert.equal(VERDICTS.go.minMeteo, 60);
    assert.equal(VERDICTS.jouable.minScore, 40);
  });
});

describe('circularMean', () => {
  test('passage par le nord : 350° et 10° donnent 0°', () => {
    proche(angleDiff(circularMean([350, 10]), 0), 0);
    proche(angleDiff(circularMean([300, 60]), 0), 0);
  });

  test('cas simples', () => {
    proche(circularMean([80, 100]), 90);
    proche(circularMean([0, 90]), 45);
    proche(circularMean([270]), 270);
    proche(circularMean([200, 220, 240]), 220);
  });

  test('résultat toujours dans [0, 360[', () => {
    const r = alea(3);
    for (let i = 0; i < 1000; i++) {
      const m = circularMean(Array.from({ length: 1 + Math.floor(r() * 6) }, () => (r() - 0.5) * 1000));
      assert.ok(m >= 0 && m < 360, `${m}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Propriétés
// ---------------------------------------------------------------------------

describe('Propriétés', () => {
  test('les profils sont ordonnés du plus exigeant au plus souple', () => {
    for (let i = 1; i < PROFILS_ORDONNES.length; i++) {
      const [a, b] = [PROFILS_ORDONNES[i - 1], PROFILS_ORDONNES[i]];
      for (const k of ['windMax', 'gustMax', 'gustSpread', 'wind850Max']) assert.ok(a[k] <= b[k], k);
      assert.ok(a.idealWind[0] >= b.idealWind[0] && a.idealWind[1] <= b.idealWind[1]);
    }
  });

  test('heure par heure, un profil plus exigeant ne fait jamais mieux', () => {
    const r = alea(11);
    for (let i = 0; i < 5000; i++) {
      const h = heureAleatoire(r);
      const deco = decoAleatoire(r);
      const [d, p, c] = PROFILS_ORDONNES.map((prof) => evaluateHour(h, deco, prof));
      for (const [strict, souple] of [[d, p], [p, c]]) {
        if (strict.ok) assert.ok(souple.ok, JSON.stringify(h));
        assert.ok(strict.quality <= souple.quality + 1e-12, JSON.stringify(h));
      }
      for (const e of [d, p, c]) assert.ok(e.quality >= 0 && e.quality <= 1);
    }
  });

  test('une journée volable pour un débutant l\'est aussi pour un confirmé', () => {
    const r = alea(21);
    for (let i = 0; i < 2000; i++) {
      const heures = journeeAleatoire(r);
      const deco = decoAleatoire(r);
      if (evaluateDay(heures, deco, DEB).flyable) assert.ok(evaluateDay(heures, deco, CONF).flyable);
    }
  });

  test("un profil plus exigeant n'obtient jamais un meilleur score météo ni un meilleur verdict", () => {
    // Cas réaliste : matinée parfaite, puis le vent rentre l'après-midi (volable seulement pour
    // le confirmé). Le confirmé doit pouvoir garder la matinée : score au moins égal au débutant.
    const apresMidi = { wind: 28, gust: 38, wind850: 45 };
    const heures = creneau(8, { 3: apresMidi, 4: apresMidi, 5: apresMidi, 6: apresMidi, 7: apresMidi });
    const deb = evaluateDay(heures, DECO, DEB);
    const conf = evaluateDay(heures, DECO, CONF);
    assert.equal(deb.meteoScore, 93);
    assert.ok(conf.meteoScore >= deb.meteoScore, `débutant ${deb.meteoScore} > confirmé ${conf.meteoScore}`);
    assert.equal(conf.flyableHours, 8);
    assert.equal(verdictOf(globalScore(deb, 60), deb), 'go');
    assert.equal(verdictOf(globalScore(conf, 60), conf), 'go');

    // Même vérification sur des journées aléatoires, débutant → pilote → confirmé.
    const r = alea(31);
    for (let i = 0; i < 3000; i++) {
      const hs = journeeAleatoire(r);
      const deco = decoAleatoire(r);
      const t = r() * 100;
      const jours = PROFILS_ORDONNES.map((p) => evaluateDay(hs, deco, p));
      for (let k = 1; k < jours.length; k++) {
        const [a, b] = [jours[k - 1], jours[k]];
        assert.ok(a.meteoScore <= b.meteoScore, `journée ${i} : ${a.meteoScore} > ${b.meteoScore}`);
        assert.ok(RANG_VERDICT[verdictOf(globalScore(a, t), a)] <= RANG_VERDICT[verdictOf(globalScore(b, t), b)], `journée ${i}`);
      }
    }
  });

  test('augmenter le vent au-delà du seuil ne rend jamais une heure volable', () => {
    const r = alea(41);
    for (let i = 0; i < 3000; i++) {
      const h = heureAleatoire(r);
      const deco = decoAleatoire(r);
      for (const prof of PROFILS_ORDONNES) {
        for (let delta = 0; delta <= 40; delta += 2.5) {
          const wind = h.wind + delta;
          if (wind <= prof.windMax) continue;
          const e = evaluateHour({ ...h, wind, gust: h.gust + delta }, deco, prof);
          assert.equal(e.ok, false);
          assert.ok(e.reasons.includes('wind'));
          assert.equal(e.quality, 0);
        }
      }
    }
  });

  test('un trajet plus long (même coût) ne donne jamais un meilleur travelScore', () => {
    for (const euros of [null, 0, 15, 40, 107.5, 200, 350]) {
      let precedent = Infinity;
      for (let hours = 0; hours <= 10; hours += 0.05) {
        const s = travelScore({ hours, euros });
        assert.ok(s <= precedent, `${hours} h, ${euros} € : ${s} > ${precedent}`);
        assert.ok(s >= 0 && s <= 100);
        precedent = s;
      }
    }
  });

  test('un trajet plus cher (même durée) ne donne jamais un meilleur travelScore', () => {
    for (const hours of [0.5, 1, 3, 6, 8, 9]) {
      let precedent = Infinity;
      for (let euros = 0; euros <= 300; euros += 2.5) {
        const s = travelScore({ hours, euros });
        assert.ok(s <= precedent, `${hours} h, ${euros} € : ${s} > ${precedent}`);
        precedent = s;
      }
    }
  });
});
