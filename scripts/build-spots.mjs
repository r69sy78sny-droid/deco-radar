#!/usr/bin/env node
/**
 * Déco Radar : construit data/spots.json, la liste des décollages de parapente en France
 * métropolitaine et en Corse, enrichie de la commune et de la gare SNCF la plus proche.
 *
 *   node scripts/build-spots.mjs                    # repli ParaglidingEarth (sans clé)
 *   FFVL_API_KEY=... node scripts/build-spots.mjs   # source FFVL
 *
 * Node >= 20, aucune dépendance. Sources :
 *   - FFVL (data.ffvl.fr, base « terrains ») si FFVL_API_KEY est défini ; clé personnelle à
 *     demander à informatique@ffvl.fr. En cas d'échec, repli automatique sur ParaglidingEarth.
 *   - ParaglidingEarth (CC BY-SA 3.0), API GeoJSON par pays.
 *   - Communes : geo.api.gouv.fr (géocodage inverse, sans clé).
 *   - Gares : SNCF Open Data, jeu « gares-de-voyageurs » (ODbL).
 *
 * Sortie déterministe (tri par id, arrondis fixes, un spot par ligne) pour des diffs git lisibles.
 * Si rien n'a changé depuis le fichier précédent, il n'est pas réécrit (generatedAt conservé).
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_FILE = join(ROOT, 'data', 'spots.json');

const FFVL_API = 'https://data.ffvl.fr/api';
const FFVL_SITE_URL = 'https://federation.ffvl.fr/sites_pratique/voir/';
const PGE_API = 'https://www.paraglidingearth.com/api/geojson/getCountrySites.php?iso=fr&limit=10000';
const PGE_SITE_URL = 'https://www.paraglidingearth.com/?site=';
const GEO_API = 'https://geo.api.gouv.fr/communes';
const SNCF_GARES =
  'https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/gares-de-voyageurs/exports/json?select=nom,position_geographique';

const GEO_CONCURRENCE = 8;
/** Au-delà, la « gare la plus proche » n'a plus de sens (ex. Corse : aucune gare SNCF sur l'île). */
const GARE_MAX_KM = 60;
/** Atterrissage plus loin que ça du décollage : coordonnées suspectes, on l'ignore. */
const ATTERRO_MAX_KM = 20;
/** Garde-fou : on refuse d'écrire un fichier qui aurait perdu plus de la moitié des spots. */
const PERTE_MAX = 0.5;

/** Rose des vents à 8 secteurs, codes français (O = ouest). */
const ROSE_FR = ['N', 'NE', 'E', 'SE', 'S', 'SO', 'O', 'NO'];

const t0 = Date.now();

// ─── Utilitaires ──────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

/** Nombre depuis une chaîne ou un nombre ; '' et valeurs non numériques → undefined. */
function num(x) {
  if (isNum(x)) return x;
  if (typeof x !== 'string' || x.trim() === '') return undefined;
  const n = Number(x.trim().replace(',', '.'));
  return Number.isFinite(n) ? n : undefined;
}

/** Minuscules sans accents, pour comparer des libellés. */
function norm(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

/** Texte UTF-8 relu en Latin-1 (« dÃ©coller ») : on le redécode si le résultat est propre. */
function fixMojibake(s) {
  if (!/[ÃÂ][\u0080-\u00bf]/.test(s)) return s;
  const fixed = Buffer.from(s, 'latin1').toString('utf8');
  return fixed.includes('\ufffd') ? s : fixed;
}

/** Nettoie un libellé : encodage cassé, échappements PHP (\'), entités HTML, espaces multiples. */
function cleanText(s) {
  return fixMojibake(String(s ?? ''))
    .replace(/\\(['"])/g, '$1')
    .replace(/&(amp|quot|apos|#0?39|lt|gt);/g, (m, e) => ({ amp: '&', quot: '"', apos: "'", '#039': "'", '#39': "'", lt: '<', gt: '>' })[e])
    .replace(/\s+/g, ' ')
    .trim();
}

const PETITS_MOTS = new Set(['d', 'l', 'de', 'du', 'des', 'la', 'le', 'les', 'et', 'en', 'sur', 'sous', 'au', 'aux']);

/** Majuscule initiale ; un nom entièrement en capitales (FFVL) passe en casse de titre. */
function prettyName(s) {
  const t = cleanText(s);
  if (!t) return t;
  if (/\p{Lu}/u.test(t) && t === t.toUpperCase()) {
    let first = true;
    return t.toLowerCase().replace(/\p{L}+/gu, (w) => {
      const keep = !first && PETITS_MOTS.has(w);
      first = false;
      return keep ? w : w[0].toUpperCase() + w.slice(1);
    });
  }
  return t[0].toUpperCase() + t.slice(1);
}

// ─── Sites non ouverts à un pilote de passage ─────────────────────────────────────────────────
//
// Treuil / remorquage, site privé, interdit ou fermé. Recherche insensible à la casse et aux
// accents. Dans le NOM, tous les mots-clés excluent. Dans les DESCRIPTIONS, seuls le treuil et
// les formules explicites excluent : « private land », « ski tow », « interdit en période de
// chasse » ou « closed from june 15th to september 26th » décrivent des sites ouverts avec des
// consignes, pas des sites fermés.

/** Motifs testés sur le nom normalisé (sans accents, minuscules), dans l'ordre de priorité. */
const MOTIFS_NOM = [
  ['treuil', /treuil/],
  ['winch', /winch/],
  ['tow', /\btow(s|ing|ed)?\b/],
  ['remorquage', /remorqu/],
  ['privé', /\bprive(e|es|s)?\b/],
  ['private', /\bprivate\b/],
  ['interdit', /\binterdi(t|te|ts|tes|ction)\b/],
  // « ferme » sans accent est ambigu (« Ferme St Marie ») : seul « (ferme) » est pris tel quel ;
  // « fermé » accentué est détecté à part, sur le nom d'origine.
  ['fermé', /\bfermees?\b|\(ferme\)/],
  ['closed', /\bclosed\b/],
];

/** Motifs testés sur les descriptions normalisées. */
const MOTIFS_DESCRIPTION = [
  ['treuil', /treuil/],
  ['winch', /winch/],
  ['tow', /\btowing|\btow (site|launch|only)\b/],
  ['remorquage', /remorqu/],
  [
    'interdit',
    /interdit de (de)?coller|(de)?collage (est )?(strictement |absolument )?interdit|site (est )?(definitivement )?interdit|forbidden to take ?off|take ?off (is )?forbidden/,
  ],
  ['fermé', /site (est )?definitivement ferme|(de)?collage (est )?definitivement ferme/],
  ['closed', /permanently closed|closed permanently|definitively closed/],
];

/** Une interdiction datée ou saisonnière n'exclut pas le site. */
const SAISONNIER =
  /\b(periodes?|pendant|saisons?|seasons?|seasonal|chasse|hunting|nidification|nesting|week-?ends?|samedis?|dimanches?|entre|between|janvier|january|fevrier|february|mars|march|avril|april|mai|may|juin|june|juillet|july|aout|august|septembre|september|octobre|october|novembre|november|decembre|december|hiver|winter|summer)\b|\bfrom .{1,40} to\b|\bdu .{1,40} au\b/;

/**
 * Motif d'exclusion d'un site : { motif, champ } ou null.
 * @param {string} name nom brut ; @param {string[]} texts descriptions et champs libres.
 */
function exclusionMotif(name, texts = []) {
  const raw = cleanText(name).toLowerCase();
  const n = norm(raw);
  if (/\bferm(é|ée|és|ées)(?!\p{L})/u.test(raw)) return { motif: 'fermé', champ: 'nom' };
  for (const [motif, re] of MOTIFS_NOM) if (re.test(n)) return { motif, champ: 'nom' };
  for (const text of texts) {
    const t = norm(cleanText(text));
    if (!t) continue;
    for (const [motif, re] of MOTIFS_DESCRIPTION) {
      const m = re.exec(t);
      if (!m) continue;
      const around = t.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80);
      const temporaire = !['treuil', 'winch', 'tow', 'remorquage'].includes(motif) && SAISONNIER.test(around);
      if (!temporaire) return { motif, champ: 'description' };
    }
  }
  return null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** France métropolitaine + Corse (boîte englobante, Ouessant et Lauterbourg compris). */
function inMetropole(lat, lon) {
  return lat >= 41.3 && lat <= 51.2 && lon >= -5.3 && lon <= 9.7;
}

/** GET avec délai maximal et nouvelles tentatives (backoff exponentiel) sur erreur réseau, 429 et 5xx. */
async function fetchRetry(url, { tries = 4, timeoutMs = 30_000, label = url } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'deco-radar-build/1.0' } });
    } catch (err) {
      if (attempt >= tries) throw new Error(`${label} : ${err.message}`);
      await sleep(1000 * 2 ** (attempt - 1));
      continue;
    }
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (!retryable || attempt >= tries) throw new Error(`${label} : HTTP ${res.status}`);
    const retryAfter = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1));
  }
}

/** Exécute `fn` sur chaque élément avec au plus `n` appels simultanés. */
async function pool(items, n, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** Premier champ présent et non vide parmi plusieurs noms candidats. */
function pick(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return undefined;
}

// ─── Source FFVL ──────────────────────────────────────────────────────────────────────────────
//
// Schéma de l'API « terrains » (https://data.ffvl.fr/api?base=terrains&mode=json&key=CLE),
// reconstitué faute de clé à partir de projets open source :
//   - CONFIRMÉ (plusieurs projets) : réponse = tableau JSON d'objets ; suid, toponym, latitude,
//     longitude, altitude (chaînes), flying_functions_text (« décollage; », « atterrissage; »,
//     « treuil; »), terrain_polygon ; fiche publique federation.ffvl.fr/sites_pratique/voir/{suid}.
//   - VU UNE FOIS (sortie pandas d'un notebook, mar-tin07/GreenAI-power-plant ; carto.js de
//     spasutto/logfly-web) : zip (« '70000 », apostrophe comprise), city (commune en capitales,
//     abrégée), possible_usages / possible_usages_text (« parapente;delta;speed-riding; »),
//     flying_functions (masque : 1 décollage, 2 atterrissage, 8 treuil), wind_orientations_ok /
//     wind_orientations_nok (listes séparées par « ; »), restrictions.
//   - ANCIEN FORMAT (data.ffvl.fr/json/sites.json, export 2022 décrit par
//     Kevin-McIsaac/paragliding_site_federation) : numero, id, nom, sous_nom, lat, lon, alt, cp,
//     pratiques, site_sous_type (« Décollage », « Atterrissage », « Interdiction de pratique »…),
//     vent_favo, vent_defavo. Gardé en second choix au cas où l'API renverrait ce format.
//   - HYPOTHÈSES NON VÉRIFIÉES : codes d'orientation de l'API actuelle (on accepte N/NE/…/O/NO,
//     les variantes anglaises SW/W/NW, les 16 secteurs et les mots entiers) ; champ de statut
//     « fermé » (aucun n'est documenté : on teste plusieurs noms plausibles, voir isClosed) ;
//     rattachement décollage → atterrissage (aucun lien connu : atterrissage FFVL le plus proche,
//     plus bas, à moins de 10 km).

const FFVL_FIELDS = {
  id: ['suid', 'numero', 'id'],
  pageId: ['suid', 'id'],
  name: ['toponym', 'nom'],
  subName: ['sous_nom'],
  lat: ['latitude', 'lat'],
  lon: ['longitude', 'lon', 'lng'],
  alt: ['altitude', 'alt'],
  functionsText: ['flying_functions_text', 'site_sous_type', 'site_type'],
  functionsMask: ['flying_functions'],
  usagesText: ['possible_usages_text', 'pratiques'],
  usagesMask: ['possible_usages'],
  orient: ['wind_orientations_ok', 'vent_favo'],
  city: ['city', 'commune', 'ville'],
  zip: ['zip', 'cp', 'code_postal'],
  // Champs libres fouillés pour les motifs d'exclusion (treuil, interdiction explicite).
  texts: ['description', 'descriptif', 'restrictions', 'flying_rules_description'],
};

/** Jetons d'orientation → secteur à 8 directions (codes français). */
const ORIENT_8 = {
  N: 'N', NORD: 'N',
  NE: 'NE', 'NORD-EST': 'NE', NORDEST: 'NE',
  E: 'E', EST: 'E',
  SE: 'SE', 'SUD-EST': 'SE', SUDEST: 'SE',
  S: 'S', SUD: 'S',
  SO: 'SO', SW: 'SO', 'SUD-OUEST': 'SO', SUDOUEST: 'SO',
  O: 'O', W: 'O', OUEST: 'O',
  NO: 'NO', NW: 'NO', 'NORD-OUEST': 'NO', NORDOUEST: 'NO',
};
/** Secteurs intermédiaires (rose à 16) : comptés « possibles » sur les deux secteurs voisins. */
const ORIENT_16 = {
  NNE: ['N', 'NE'], ENE: ['NE', 'E'], ESE: ['E', 'SE'], SSE: ['SE', 'S'],
  SSO: ['S', 'SO'], SSW: ['S', 'SO'], OSO: ['SO', 'O'], WSW: ['SO', 'O'],
  ONO: ['O', 'NO'], WNW: ['O', 'NO'], NNO: ['NO', 'N'], NNW: ['NO', 'N'],
};

function parseFfvlOrient(raw) {
  const good = new Set();
  const ok = new Set();
  for (const tok of String(raw ?? '').split(/[;,/|\s]+/)) {
    const t = norm(tok).toUpperCase().replace(/[^A-Z-]/g, '');
    if (!t) continue;
    if (ORIENT_8[t]) good.add(ORIENT_8[t]);
    else if (ORIENT_16[t]) ORIENT_16[t].forEach((d) => ok.add(d));
  }
  for (const d of good) ok.delete(d);
  const order = (set) => ROSE_FR.filter((d) => set.has(d));
  return { orient: order(good), orientOk: order(ok) };
}

const truthy = (v) => v === true || v === 1 || /^(1|true|oui|yes|o|y)$/i.test(String(v).trim());
const falsy = (v) => v === false || v === 0 || /^(0|false|non|no|n)$/i.test(String(v).trim());

/** HYPOTHÈSE : aucun champ de statut n'est documenté pour l'API « terrains ». */
function isClosed(row) {
  const fn = norm(pick(row, FFVL_FIELDS.functionsText));
  if (fn.includes('interdiction')) return true; // ancien format : site_sous_type « Interdiction de pratique »
  for (const k of ['closed', 'is_closed', 'ferme', 'site_ferme', 'deleted', 'is_deleted', 'interdit']) {
    if (row[k] !== undefined && row[k] !== null && truthy(row[k])) return true;
  }
  for (const k of ['active', 'actif', 'is_active', 'published', 'visible', 'valide']) {
    if (row[k] !== undefined && row[k] !== null && falsy(row[k])) return true;
  }
  for (const k of ['status', 'statut', 'etat', 'state', 'site_status', 'terrain_status']) {
    if (typeof row[k] === 'string' && /ferm|clos|interdi|inactif|suspendu|supprim/.test(norm(row[k]))) return true;
  }
  return false;
}

/** HYPOTHÈSE : aucun champ « site privé » n'est documenté ; noms plausibles testés. */
function isPrivate(row) {
  for (const k of ['private', 'is_private', 'prive', 'site_prive', 'acces_prive', 'private_access']) {
    if (row[k] !== undefined && row[k] !== null && truthy(row[k])) return true;
  }
  return false;
}

/** Fonctions du terrain : { takeoff, landing } ; null si la source ne dit rien. */
function ffvlFunctions(row) {
  const text = norm(pick(row, FFVL_FIELDS.functionsText));
  if (text) return { takeoff: text.includes('decollage'), landing: text.includes('atterrissage') };
  const mask = num(pick(row, FFVL_FIELDS.functionsMask));
  if (mask !== undefined) return { takeoff: (mask & 1) === 1, landing: (mask & 2) === 2 };
  return null;
}

function ffvlParagliding(row) {
  const text = norm(pick(row, FFVL_FIELDS.usagesText));
  if (text) return text.includes('parapente');
  const mask = num(pick(row, FFVL_FIELDS.usagesMask));
  return mask === undefined ? true : (mask & 1) === 1;
}

/** Code département depuis un code postal (Corse : 200xx-201xx → 2A, 202xx-206xx → 2B). */
function deptFromZip(zip) {
  const z = String(zip ?? '').replace(/\D/g, '');
  if (z.length !== 5) return null;
  if (z.startsWith('20')) return Number(z.slice(0, 3)) <= 201 ? '2A' : '2B';
  if (z.startsWith('97') || z.startsWith('98')) return z.slice(0, 3);
  return z.slice(0, 2);
}

function extractRows(json) {
  if (Array.isArray(json)) return json;
  for (const k of ['terrains', 'sites', 'data', 'results']) if (Array.isArray(json?.[k])) return json[k];
  if (json && typeof json === 'object') {
    const values = Object.values(json);
    if (values.length > 0 && values.every((v) => v && typeof v === 'object' && !Array.isArray(v))) return values;
  }
  return null;
}

async function fetchFfvl(key) {
  const url = `${FFVL_API}?base=terrains&mode=json&key=${encodeURIComponent(key)}`;
  const res = await fetchRetry(url, { timeoutMs: 120_000, label: 'FFVL' });
  const body = await res.text();
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error(`FFVL : réponse non JSON (« ${body.replace(/\s+/g, ' ').slice(0, 120)} »)`);
  }
  const rows = extractRows(json);
  if (!rows) throw new Error('FFVL : format de réponse inattendu');

  const takeoffs = [];
  const landings = [];
  let unknownFunction = 0;
  let notParagliding = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const lat = num(pick(row, FFVL_FIELDS.lat));
    const lon = num(pick(row, FFVL_FIELDS.lon));
    const rawId = pick(row, FFVL_FIELDS.id);
    if (!isNum(lat) || !isNum(lon) || rawId === undefined) continue;
    const alt = num(pick(row, FFVL_FIELDS.alt));
    const fn = ffvlFunctions(row);
    if (fn === null) unknownFunction++;
    if (fn?.landing) landings.push({ id: String(rawId).trim(), lat, lon, alt });
    if (fn && !fn.takeoff) continue;
    if (!ffvlParagliding(row)) {
      notParagliding++;
      continue;
    }
    const fnText = norm(pick(row, FFVL_FIELDS.functionsText));
    const texts = FFVL_FIELDS.texts.map((k) => row[k]).filter((v) => typeof v === 'string');
    const excluded = isClosed(row)
      ? { motif: 'fermé', champ: 'statut FFVL' }
      : isPrivate(row)
        ? { motif: 'privé', champ: 'statut FFVL' }
        : /treuil|remorqu/.test(fnText)
          ? { motif: 'treuil', champ: 'fonction FFVL' }
          : exclusionMotif(`${pick(row, FFVL_FIELDS.name) ?? ''} ${pick(row, FFVL_FIELDS.subName) ?? ''}`, texts);

    const name = prettyName(pick(row, FFVL_FIELDS.name) ?? '');
    const subName = prettyName(pick(row, FFVL_FIELDS.subName) ?? '');
    const pageId = pick(row, FFVL_FIELDS.pageId);
    const city = pick(row, FFVL_FIELDS.city);
    takeoffs.push({
      rawId: String(rawId).trim(),
      id: `ffvl:${String(rawId).trim()}`,
      name: subName && norm(subName) !== norm(name) ? `${name} - ${subName}` : name || subName,
      lat,
      lon,
      alt: alt !== undefined && alt > 0 ? Math.round(alt) : null,
      ...parseFfvlOrient(pick(row, FFVL_FIELDS.orient)),
      alsoLanding: Boolean(fn?.landing),
      sourceCity: city ? prettyName(city) : null,
      sourceDept: deptFromZip(pick(row, FFVL_FIELDS.zip)),
      url: pageId !== undefined ? `${FFVL_SITE_URL}${encodeURIComponent(String(pageId).trim())}` : null,
      excluded,
    });
  }
  if (unknownFunction > 0) console.warn(`FFVL : ${unknownFunction} terrains sans fonction connue, gardés comme décollages`);
  console.log(`FFVL : ${rows.length} terrains, ${takeoffs.length} décollages parapente (${notParagliding} hors parapente écartés)`);
  if (takeoffs.length < 100) throw new Error(`FFVL : seulement ${takeoffs.length} décollages, schéma probablement différent`);

  // HYPOTHÈSE : l'API ne relie pas un décollage à son atterrissage ; on prend l'atterrissage
  // FFVL le plus proche, plus bas que le décollage quand les deux altitudes sont connues.
  for (const t of takeoffs) {
    t.landing = null;
    if (t.alsoLanding) continue;
    let best = null;
    for (const l of landings) {
      if (l.id === t.rawId) continue;
      if (t.alt !== null && isNum(l.alt) && l.alt > 0 && l.alt >= t.alt) continue;
      const d = haversineKm(t.lat, t.lon, l.lat, l.lon);
      if (d <= 10 && (!best || d < best.d)) best = { d, l };
    }
    if (best) t.landing = { lat: best.l.lat, lon: best.l.lon };
  }

  return {
    // HYPOTHÈSE : conditions de réutilisation des données FFVL à confirmer à l'obtention de la clé.
    meta: { source: 'FFVL', license: 'Données FFVL', attribution: 'Décollages : FFVL (data.ffvl.fr)' },
    spots: takeoffs,
  };
}

// ─── Source ParaglidingEarth ──────────────────────────────────────────────────────────────────
//
// GeoJSON, coordonnées [lon, lat], tous les nombres en texte. Orientation : un champ par
// direction (N, NE, E, SE, S, SW, W, NW) valant 0 (non adaptée), 1 (possible) ou 2 (bonne).
// '' , 0 et -1 codent une valeur inconnue. Même décodage que AeroCompanion (paraglidingEarth.ts).

const PGE_ROSE = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

async function fetchPge() {
  const res = await fetchRetry(PGE_API, { timeoutMs: 90_000, label: 'ParaglidingEarth' });
  const features = (await res.json())?.features;
  if (!Array.isArray(features)) throw new Error('ParaglidingEarth : réponse inattendue');
  const spots = [];
  for (const f of features) {
    const p = f?.properties;
    const coords = f?.geometry?.coordinates;
    if (!p || !Array.isArray(coords)) continue;
    const [lon, lat] = coords.map(num);
    const id = String(p.pge_site_id ?? f.id ?? '').trim();
    const name = prettyName(p.name);
    if (!id || !name || !isNum(lat) || !isNum(lon)) continue;
    if (p.paragliding !== undefined && String(p.paragliding).trim() === '0') continue;
    if (typeof p.place === 'string' && p.place && !/takeoff/i.test(p.place)) continue;

    const alt = num(p.takeoff_altitude);
    const orient = [];
    const orientOk = [];
    PGE_ROSE.forEach((k, i) => {
      const v = String(p[k] ?? '').trim();
      if (v === '2') orient.push(ROSE_FR[i]);
      else if (v === '1') orientOk.push(ROSE_FR[i]);
    });
    const lLat = num(p.landing_lat);
    const lLon = num(p.landing_lng);
    const landingOk = lLat && lLon && haversineKm(lat, lon, lLat, lLon) <= ATTERRO_MAX_KM;
    spots.push({
      id: `pge:${id}`,
      name,
      lat,
      lon,
      alt: alt !== undefined && alt > 0 ? Math.round(alt) : null,
      orient,
      orientOk,
      landing: landingOk ? { lat: lLat, lon: lLon } : null,
      sourceCity: null,
      sourceDept: null,
      url: `${PGE_SITE_URL}${encodeURIComponent(id)}`,
      excluded: exclusionMotif(p.name, [p.takeoff_description]),
    });
  }
  console.log(`ParaglidingEarth : ${features.length} sites reçus, ${spots.length} décollages lus`);
  return {
    meta: { source: 'ParaglidingEarth', license: 'CC BY-SA 3.0', attribution: 'Décollages : ParaglidingEarth (CC BY-SA 3.0)' },
    spots,
  };
}

// ─── Enrichissements ──────────────────────────────────────────────────────────────────────────

/** Liste des gares de voyageurs SNCF : [{ name, lat, lon }]. */
async function fetchGares() {
  const res = await fetchRetry(SNCF_GARES, { timeoutMs: 60_000, label: 'SNCF gares' });
  const rows = await res.json();
  if (!Array.isArray(rows)) throw new Error('SNCF gares : réponse inattendue');
  const gares = [];
  for (const r of rows) {
    const lat = num(r?.position_geographique?.lat);
    const lon = num(r?.position_geographique?.lon);
    const name = cleanText(r?.nom);
    if (name && isNum(lat) && isNum(lon)) gares.push({ name, lat, lon });
  }
  if (gares.length < 1000) throw new Error(`SNCF gares : seulement ${gares.length} gares`);
  console.log(`SNCF : ${gares.length} gares de voyageurs`);
  return gares;
}

function nearestGare(gares, lat, lon) {
  let best = null;
  for (const g of gares) {
    const d = haversineKm(lat, lon, g.lat, g.lon);
    if (!best || d < best.d) best = { d, g };
  }
  if (!best || best.d > GARE_MAX_KM) return null;
  return { name: best.g.name, lat: round(best.g.lat, 5), lon: round(best.g.lon, 5), km: round(best.d, 1) };
}

/** Commune contenant le point : { city, dept } ; { city: null } si aucune (mer, étranger). */
async function reverseGeocode(lat, lon) {
  const url = `${GEO_API}?lat=${lat}&lon=${lon}&fields=nom,codeDepartement&format=json`;
  const res = await fetchRetry(url, { timeoutMs: 20_000, label: 'geo.api.gouv.fr' });
  const list = await res.json();
  if (!Array.isArray(list)) throw new Error('geo.api.gouv.fr : réponse inattendue');
  const c = list[0];
  return c?.nom ? { city: c.nom, dept: c.codeDepartement ?? null } : { city: null, dept: null };
}

/**
 * Commune du décollage. Un point hors de toute commune est soit sur une plage ou une falaise
 * (polygone communal un peu en retrait), soit à l'étranger (site mal étiqueté par la source) :
 * on sonde deux cercles de 0,5 puis 1,5 km et on garde la commune la plus fréquente. Rien trouvé :
 * `outside: true`, le spot sera écarté.
 */
async function geocodeSpot(lat, lon) {
  const direct = await reverseGeocode(lat, lon);
  if (direct.city) return direct;
  const rad = Math.PI / 180;
  for (const km of [0.5, 1.5]) {
    const hits = new Map();
    for (let bearing = 0; bearing < 360; bearing += 45) {
      const pLat = round(lat + (km / 111.32) * Math.cos(bearing * rad), 5);
      const pLon = round(lon + (km / (111.32 * Math.cos(lat * rad))) * Math.sin(bearing * rad), 5);
      const r = await reverseGeocode(pLat, pLon);
      if (!r.city) continue;
      const k = `${r.city}|${r.dept}`;
      hits.set(k, { ...r, n: (hits.get(k)?.n ?? 0) + 1 });
    }
    if (hits.size > 0) {
      const best = [...hits.values()].reduce((a, b) => (b.n > a.n ? b : a));
      return { city: best.city, dept: best.dept };
    }
  }
  return { city: null, dept: null, outside: true };
}

// ─── Programme principal ──────────────────────────────────────────────────────────────────────

async function readPrevious() {
  if (!existsSync(OUT_FILE)) return null;
  try {
    const text = await readFile(OUT_FILE, 'utf8');
    const json = JSON.parse(text);
    return Array.isArray(json?.spots) ? { text, json } : null;
  } catch {
    console.warn('data/spots.json précédent illisible : ignoré');
    return null;
  }
}

function compareIds(a, b) {
  const [pa, ka] = [a.slice(0, a.indexOf(':')), a.slice(a.indexOf(':') + 1)];
  const [pb, kb] = [b.slice(0, b.indexOf(':')), b.slice(b.indexOf(':') + 1)];
  if (pa !== pb) return pa < pb ? -1 : 1;
  const na = Number(ka);
  const nb = Number(kb);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

const coordKey = (lat, lon) => `${round(lat, 5)},${round(lon, 5)}`;

async function main() {
  const previous = await readPrevious();

  // 1. Décollages : FFVL si une clé est fournie, sinon (ou en cas d'échec) ParaglidingEarth.
  let data = null;
  const ffvlKey = process.env.FFVL_API_KEY?.trim();
  if (ffvlKey) {
    try {
      data = await fetchFfvl(ffvlKey);
    } catch (err) {
      console.warn(`⚠ Source FFVL indisponible (${err.message}) : repli sur ParaglidingEarth.`);
    }
  } else {
    console.warn('⚠ FFVL_API_KEY absente : repli sur ParaglidingEarth.');
  }
  data ??= await fetchPge();

  // Métropole + Corse uniquement, coordonnées arrondies, un seul spot par id.
  const byId = new Map();
  let horsMetropole = 0;
  const exclus = [];
  for (const s of data.spots) {
    if (!inMetropole(s.lat, s.lon)) {
      horsMetropole++;
      continue;
    }
    if (s.excluded) {
      exclus.push(s);
      continue;
    }
    s.lat = round(s.lat, 5);
    s.lon = round(s.lon, 5);
    if (s.landing) s.landing = { lat: round(s.landing.lat, 5), lon: round(s.landing.lon, 5) };
    if (!byId.has(s.id)) byId.set(s.id, s);
  }
  const spots = [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
  if (horsMetropole) console.log(`${horsMetropole} spots hors métropole/Corse écartés`);
  if (exclus.length) {
    // Sites non ouverts à un pilote de passage, comptés par motif puis listés.
    const parMotif = new Map();
    for (const s of exclus) {
      const m = parMotif.get(s.excluded.motif) ?? { total: 0, champs: new Map() };
      m.total++;
      m.champs.set(s.excluded.champ, (m.champs.get(s.excluded.champ) ?? 0) + 1);
      parMotif.set(s.excluded.motif, m);
    }
    const detail = [...parMotif]
      .map(([motif, m]) => `${motif} ${m.total} (${[...m.champs].map(([c, n]) => `${c} ${n}`).join(', ')})`)
      .join(' · ');
    console.log(`${exclus.length} sites exclus (treuil, privé, interdit, fermé) : ${detail}`);
    for (const s of exclus.sort((a, b) => compareIds(a.id, b.id))) {
      console.log(`  - ${s.id} ${s.name} [${s.excluded.motif}, ${s.excluded.champ}]`);
    }
  }

  // 2. Valeurs du fichier précédent, réutilisées pour les coordonnées inchangées.
  const prevCity = new Map();
  const prevStation = new Map();
  for (const p of previous?.json.spots ?? []) {
    if (!isNum(p?.lat) || !isNum(p?.lon)) continue;
    const k = coordKey(p.lat, p.lon);
    if (p.city) prevCity.set(k, { city: p.city, dept: p.dept ?? null });
    if (p.station !== undefined) prevStation.set(k, p.station);
  }

  // 3. Commune et département : géocodage inverse (nom officiel accentué + code département),
  //    la commune fournie par la source (FFVL) ne servant que de repli.
  const todo = spots.filter((s) => !prevCity.has(coordKey(s.lat, s.lon)));
  console.log(`Communes : ${spots.length - todo.length} reprises du fichier précédent, ${todo.length} à géocoder`);
  let geoErrors = 0;
  const geo = new Map();
  await pool(todo, GEO_CONCURRENCE, async (s, i) => {
    try {
      geo.set(s.id, await geocodeSpot(s.lat, s.lon));
    } catch (err) {
      geoErrors++;
      if (geoErrors <= 5) console.warn(`  ${s.id} : ${err.message}`);
    }
    if ((i + 1) % 200 === 0) console.log(`  … ${i + 1}/${todo.length}`);
  });
  if (geoErrors) console.warn(`⚠ ${geoErrors} géocodages en échec (ville laissée vide, réessayée au prochain passage)`);
  const abroad = spots.filter((s) => geo.get(s.id)?.outside);
  for (const s of abroad) console.log(`Hors de France (aucune commune à 1,5 km), écarté : ${s.id} ${s.name}`);
  const kept = spots.filter((s) => !geo.get(s.id)?.outside);

  // 4. Gare de voyageurs la plus proche.
  let gares = null;
  try {
    gares = await fetchGares();
  } catch (err) {
    console.warn(`⚠ Gares SNCF indisponibles (${err.message}) : valeurs précédentes conservées.`);
  }

  const out = kept.map((s) => {
    const k = coordKey(s.lat, s.lon);
    const g = prevCity.get(k) ?? geo.get(s.id);
    const station = gares ? nearestGare(gares, s.lat, s.lon) : (prevStation.get(k) ?? null);
    return {
      id: s.id,
      name: s.name,
      lat: s.lat,
      lon: s.lon,
      alt: s.alt,
      orient: s.orient,
      orientOk: s.orientOk,
      city: g?.city ?? s.sourceCity ?? null,
      dept: (g?.city ? g.dept : null) ?? s.sourceDept ?? null,
      landing: s.landing,
      station,
      url: s.url,
    };
  });

  // 5. Garde-fous puis écriture (un spot par ligne).
  const prevCount = previous?.json.spots.length ?? 0;
  if (out.length === 0 || (prevCount > 0 && out.length < prevCount * PERTE_MAX && !process.argv.includes('--force'))) {
    throw new Error(`${out.length} spots contre ${prevCount} précédemment : fichier conservé (--force pour passer outre)`);
  }
  const render = (generatedAt) => {
    const head = { ...data.meta, generatedAt, count: out.length };
    return `${JSON.stringify(head).slice(0, -1)},"spots":[\n${out.map((s) => JSON.stringify(s)).join(',\n')}\n]}\n`;
  };
  const pct = (f) => `${Math.round((100 * out.filter(f).length) / out.length)} %`;
  console.log(
    `${out.length} décollages · orientation ${pct((s) => s.orient.length + s.orientOk.length > 0)}` +
      ` · ville ${pct((s) => s.city)} · gare ${pct((s) => s.station)} · atterrissage ${pct((s) => s.landing)}`,
  );

  const prevAt = previous?.json.generatedAt;
  if (prevAt && render(prevAt) === previous.text) {
    console.log(`Aucun changement : data/spots.json inchangé (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    return;
  }
  await mkdir(dirname(OUT_FILE), { recursive: true });
  const text = render(new Date().toISOString());
  await writeFile(OUT_FILE, text);
  console.log(`data/spots.json écrit : ${(Buffer.byteLength(text) / 1024).toFixed(0)} Ko en ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
