#!/usr/bin/env node
/**
 * Déco Radar : construit data/destinations.json (destinations de vol connues qui regroupent les
 * décollages de data/spots.json) et data/fares.json (tarifs SNCF open data vers ces destinations).
 *
 *   node scripts/build-destinations.mjs           # après scripts/build-spots.mjs
 *   node scripts/build-destinations.mjs --force   # écrit même si fares.json perd trop de couples
 *
 * Node >= 20, aucune dépendance. Sources :
 *   - data/destinations.source.json, liste éditée à la main (format ci-dessous).
 *   - data/spots.json, produit par scripts/build-spots.mjs.
 *   - Communes : geo.api.gouv.fr (sans clé). Communes nouvelles : une ancienne commune devenue
 *     commune déléguée (ex. Saint-Hilaire, dans Plateau-des-Petites-Roches) est cherchée dans
 *     /communes_associees_deleguees quand /communes ne la connaît pas.
 *   - Gares et tarifs : SNCF Open Data (ODbL), jeux « gares-de-voyageurs »,
 *     « tarifs-tgv-inoui-ouigo » et « tarifs-intercites ».
 *   - Flixbus : API d'autocomplétion de leur site (publique, CORS ouvert, NON documentée) ;
 *     requêtes séquentielles espacées, résultats mis en cache, valeur précédente conservée en
 *     cas d'échec.
 *
 * Format de data/destinations.source.json : tableau de
 *   {
 *     "id": "annecy",                                    // [a-z0-9-], unique
 *     "name": "Annecy",
 *     "center": { "commune": "Talloires-Montmin", "dept": "74" },  // centre du groupe de décos
 *     "radiusKm": 11,                                   // décos à ≤ radiusKm du centre
 *     "hub": { "commune": "Annecy", "dept": "74" },     // ville d'arrivée en train / car
 *     "expect": ["Forclaz", "Planfait"],                // mots attendus dans les noms (contrôle)
 *     "note": "…",                                      // accès au déco, facultatif
 *     "exclude": { "pge:123": "raison" },               // facultatif : décos écartés malgré le rayon
 *     "fareRadiusKm": 30                                // facultatif : rayon des gares tarifées (35)
 *   }
 * Centre : centroïde de la commune (champ « centre ») ; hub : position de la mairie (champ
 * « mairie », centroïde à défaut), plus proche de la gare et de l'arrêt de car.
 *
 * Sorties déterministes (ordre de la source, tris stables, arrondis fixes, une entrée par ligne) ;
 * un fichier dont seul generatedAt changerait n'est pas réécrit. Rien n'est écrit en cas d'erreur.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE_FILE = join(ROOT, 'data', 'destinations.source.json');
const SPOTS_FILE = join(ROOT, 'data', 'spots.json');
const DEST_FILE = join(ROOT, 'data', 'destinations.json');
const FARES_FILE = join(ROOT, 'data', 'fares.json');

const GEO_API = 'https://geo.api.gouv.fr';
const SNCF_API = 'https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets';
const FLIXBUS_API = 'https://global.api.flixbus.com/search/autocomplete/cities';

const GEO_CONCURRENCE = 4;
/** Au-delà, la « gare la plus proche » du hub n'a plus de sens. */
const GARE_MAX_KM = 60;
/** Gares tarifées retenues autour du hub : rayon par défaut et nombre maximal. */
const FARE_RADIUS_KM = 35;
const FARE_STATIONS_MAX = 4;
/** Ville Flixbus acceptée jusqu'à cette distance du hub. */
const FLIXBUS_MAX_KM = 40;
/** Pause entre deux requêtes Flixbus : API non officielle, on reste économe. */
const FLIXBUS_PAUSE_MS = 300;
/** Garde-fou : on refuse d'écrire un fares.json qui aurait perdu plus de la moitié des couples. */
const PERTE_MAX = 0.5;

/** Ordre d'affichage des transporteurs et des profils dans fares.json. */
const TRANSPORTEURS = ['TGV INOUI', 'OUIGO', 'Intercités'];
const PROFILS = ['normal', 'avantage', 'etudiant'];

const t0 = Date.now();

// ─── Utilitaires ──────────────────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (x, d) => Math.round(x * 10 ** d) / 10 ** d;
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;

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
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Libellé réduit à ses lettres et chiffres : « Plan Praz/ Brevent » ~ « Planpraz », « Brévent ». */
const compact = (s) => norm(s).replace(/[^a-z0-9]/g, '');

/** Espaces multiples et bords nettoyés (« CLUSES  74 » → « CLUSES 74 »). */
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();

function haversineKm(lat1, lon1, lat2, lon2) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** GET avec délai maximal et nouvelles tentatives (backoff exponentiel) sur erreur réseau, 429 et 5xx. */
async function fetchRetry(url, { tries = 4, timeoutMs = 30_000, label = url } = {}) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'user-agent': 'deco-radar-build/1.0', accept: 'application/json' },
      });
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

async function fetchJson(url, opts) {
  const res = await fetchRetry(url, opts);
  return res.json();
}

async function readJsonIfAny(file, label) {
  if (!existsSync(file)) return null;
  try {
    const text = await readFile(file, 'utf8');
    return { text, json: JSON.parse(text) };
  } catch {
    console.warn(`${label} précédent illisible : ignoré`);
    return null;
  }
}

/** Écrit `render(generatedAt)` sauf si seul generatedAt changerait. Renvoie true si écrit. */
async function writeIfChanged(file, previous, render, label) {
  const prevAt = previous?.json?.generatedAt;
  if (prevAt && render(prevAt) === previous.text) {
    console.log(`${label} inchangé`);
    return false;
  }
  const text = render(new Date().toISOString());
  await writeFile(file, text);
  console.log(`${label} écrit : ${(Buffer.byteLength(text) / 1024).toFixed(0)} Ko`);
  return true;
}

// ─── Source éditée à la main ──────────────────────────────────────────────────────────────────

/** Contrôle la forme de la source ; toutes les erreurs sont listées d'un coup. */
function validateSource(list) {
  if (!Array.isArray(list) || list.length === 0) throw new Error('destinations.source.json : tableau non vide attendu');
  const errors = [];
  const ids = new Set();
  const isCommune = (c) => c && typeof c.commune === 'string' && c.commune.trim() && /^(\d{2,3}|2A|2B)$/.test(String(c.dept ?? ''));
  list.forEach((d, i) => {
    const where = `entrée ${i + 1}${d?.id ? ` (${d.id})` : ''}`;
    if (!d || typeof d !== 'object') return errors.push(`${where} : objet attendu`);
    if (typeof d.id !== 'string' || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(d.id)) errors.push(`${where} : id en [a-z0-9-] attendu`);
    else if (ids.has(d.id)) errors.push(`${where} : id en double`);
    else ids.add(d.id);
    if (typeof d.name !== 'string' || !d.name.trim()) errors.push(`${where} : name manquant`);
    if (!isCommune(d.center)) errors.push(`${where} : center {commune, dept} invalide`);
    if (!isCommune(d.hub)) errors.push(`${where} : hub {commune, dept} invalide`);
    if (!isNum(d.radiusKm) || d.radiusKm <= 0 || d.radiusKm > 50) errors.push(`${where} : radiusKm entre 0 et 50 attendu`);
    if (d.fareRadiusKm !== undefined && (!isNum(d.fareRadiusKm) || d.fareRadiusKm <= 0 || d.fareRadiusKm > 100)) {
      errors.push(`${where} : fareRadiusKm entre 0 et 100 attendu`);
    }
    if (d.expect !== undefined && (!Array.isArray(d.expect) || !d.expect.every((w) => typeof w === 'string' && w.trim()))) {
      errors.push(`${where} : expect doit être une liste de mots`);
    }
    if (d.note !== undefined && d.note !== null && typeof d.note !== 'string') errors.push(`${where} : note doit être un texte`);
    if (d.exclude !== undefined && (typeof d.exclude !== 'object' || d.exclude === null || Array.isArray(d.exclude))) {
      errors.push(`${where} : exclude doit être un objet { "id du déco": "raison" }`);
    }
  });
  if (errors.length) throw new Error(`destinations.source.json invalide :\n  - ${errors.join('\n  - ')}`);
}

// ─── Communes (geo.api.gouv.fr) ───────────────────────────────────────────────────────────────

const point = (p) => {
  const [lon, lat] = p?.coordinates ?? [];
  return isNum(lat) && isNum(lon) ? { lat, lon } : null;
};

/**
 * Commune par nom exact (casse, accents et tirets ignorés) dans un département :
 * { name, centre: {lat, lon}, mairie: {lat, lon} }. Communes actuelles d'abord, puis communes
 * déléguées ou associées (communes nouvelles), dont geo.api.gouv.fr ne donne que le centroïde.
 */
async function geocodeCommune({ commune, dept }) {
  const q = new URLSearchParams({ nom: commune, codeDepartement: dept });
  const wanted = compact(commune);
  const actuelles = await fetchJson(`${GEO_API}/communes?${q}&fields=nom,code,centre,mairie&format=json`, {
    label: `geo.api.gouv.fr (${commune})`,
  });
  if (!Array.isArray(actuelles)) throw new Error(`geo.api.gouv.fr : réponse inattendue pour ${commune}`);
  const hit = actuelles.find((c) => compact(c.nom) === wanted && point(c.centre));
  if (hit) return { name: hit.nom, centre: point(hit.centre), mairie: point(hit.mairie) ?? point(hit.centre) };

  const deleguees = await fetchJson(`${GEO_API}/communes_associees_deleguees?${q}&fields=nom,code,chefLieu,centre,type`, {
    label: `geo.api.gouv.fr (${commune}, communes déléguées)`,
  });
  const old = Array.isArray(deleguees) ? deleguees.find((c) => compact(c.nom) === wanted && point(c.centre)) : null;
  if (old) {
    const chefLieu = await fetchJson(`${GEO_API}/communes/${encodeURIComponent(old.chefLieu)}?fields=nom`, {
      label: `geo.api.gouv.fr (${old.chefLieu})`,
    }).catch(() => null);
    console.log(`  ${commune} (${dept}) : ${old.type ?? 'commune déléguée'} de ${chefLieu?.nom ?? old.chefLieu}`);
    return { name: old.nom, centre: point(old.centre), mairie: point(old.centre) };
  }
  const candidats = [...actuelles, ...(Array.isArray(deleguees) ? deleguees : [])].map((c) => c.nom).slice(0, 5);
  throw new Error(`commune introuvable : « ${commune} » (${dept})${candidats.length ? `, candidats : ${candidats.join(', ')}` : ''}`);
}

// ─── Gares et tarifs SNCF ─────────────────────────────────────────────────────────────────────

/** Gares de voyageurs : liste [{ name, uics, lat, lon }] et index UIC → gare. */
async function fetchGares() {
  const rows = await fetchJson(`${SNCF_API}/gares-de-voyageurs/exports/json?select=nom,codes_uic,position_geographique`, {
    timeoutMs: 60_000,
    label: 'SNCF gares',
  });
  if (!Array.isArray(rows)) throw new Error('SNCF gares : réponse inattendue');
  const gares = [];
  const byUic = new Map();
  for (const r of rows) {
    const lat = num(r?.position_geographique?.lat);
    const lon = num(r?.position_geographique?.lon);
    const name = clean(r?.nom);
    // Une gare peut porter plusieurs codes UIC (« 87686006;87686030 »).
    const uics = String(r?.codes_uic ?? '')
      .split(/[;,\s]+/)
      .filter((u) => /^\d{8}$/.test(u));
    if (!name || !isNum(lat) || !isNum(lon) || uics.length === 0) continue;
    const g = { name, uics, lat, lon };
    gares.push(g);
    for (const u of uics) if (!byUic.has(u)) byUic.set(u, g);
  }
  if (gares.length < 1000) throw new Error(`SNCF gares : seulement ${gares.length} gares`);
  console.log(`SNCF : ${gares.length} gares de voyageurs`);
  return { gares, byUic };
}

/** Profil tarifaire normalisé, ou null s'il est ignoré (Tarif Réglementé…). */
function profilOf(raw) {
  const p = norm(raw);
  if (/\bnormal\b/.test(p)) return 'normal';
  if (/\bavantage\b/.test(p)) return 'avantage';
  if (/etudiant|eleve|apprenti/.test(p)) return 'etudiant';
  return null;
}

/** Transporteur normalisé ; OUIGO et OUIGO TRAIN CLASSIQUE fusionnent, toutes les offres Intercités aussi. */
function transporteurOf(raw) {
  const t = norm(clean(raw));
  if (t === 'tgv inoui') return 'TGV INOUI';
  if (t.startsWith('ouigo')) return 'OUIGO';
  if (t.startsWith('intercites')) return 'Intercités';
  return null;
}

/**
 * Lignes tarifaires de 2de classe, places assises : [{ o, d, carrier, profil, min, max }], plus
 * les libellés de gares (dataset tarifs) et le compte des lignes écartées par motif.
 */
async function fetchTarifs() {
  const ignored = new Map();
  const skip = (motif) => ignored.set(motif, (ignored.get(motif) ?? 0) + 1);
  const names = new Map();
  const rows = [];

  const add = ({ o, oName, d, dName, carrierRaw, profilRaw, min, max }) => {
    const carrier = transporteurOf(carrierRaw);
    if (!carrier) return skip(`transporteur « ${clean(carrierRaw)} »`);
    const profil = profilOf(profilRaw);
    if (!profil) return skip(`profil « ${clean(profilRaw)} »`);
    if (!/^\d{8}$/.test(o) || !/^\d{8}$/.test(d) || o === d) return skip('code UIC invalide');
    if (!isNum(min) || !isNum(max) || min < 0 || max < min) return skip('prix invalide');
    if (!names.has(o)) names.set(o, clean(oName));
    if (!names.has(d)) names.set(d, clean(dName));
    rows.push({ o, d, carrier, profil, min, max });
  };

  // 1re classe filtrée par l'API (classe = "2") pour alléger le téléchargement.
  const tgvQuery = new URLSearchParams({
    where: 'classe = "2"',
    select:
      'transporteur,gare_origine,gare_origine_code_uic,gare_destination,gare_destination_code_uic,profil_tarifaire,prix_minimum,prix_maximum',
  });
  const tgv = await fetchJson(`${SNCF_API}/tarifs-tgv-inoui-ouigo/exports/json?${tgvQuery}`, {
    timeoutMs: 120_000,
    label: 'SNCF tarifs TGV INOUI / OUIGO',
  });
  if (!Array.isArray(tgv) || tgv.length < 1000) throw new Error('SNCF tarifs TGV INOUI / OUIGO : réponse inattendue');
  for (const r of tgv) {
    add({
      o: String(r.gare_origine_code_uic ?? '').trim(),
      oName: r.gare_origine,
      d: String(r.gare_destination_code_uic ?? '').trim(),
      dName: r.gare_destination,
      carrierRaw: r.transporteur,
      profilRaw: r.profil_tarifaire,
      min: num(r.prix_minimum),
      max: num(r.prix_maximum),
    });
  }

  const icQuery = new URLSearchParams({
    where: 'classe = "2"',
    select: 'transporteur,origine,origine_uic8,destination,destination_uic8,profil_tarifaire,type_place,prix_min,prix_max',
  });
  const ic = await fetchJson(`${SNCF_API}/tarifs-intercites/exports/json?${icQuery}`, {
    timeoutMs: 120_000,
    label: 'SNCF tarifs Intercités',
  });
  if (!Array.isArray(ic) || ic.length < 100) throw new Error('SNCF tarifs Intercités : réponse inattendue');
  for (const r of ic) {
    if (norm(r.type_place) !== 'assise') {
      skip(`place « ${clean(r.type_place)} »`);
      continue;
    }
    add({
      o: String(r.origine_uic8 ?? '').trim(),
      oName: r.origine,
      d: String(r.destination_uic8 ?? '').trim(),
      dName: r.destination,
      carrierRaw: r.transporteur,
      profilRaw: r.profil_tarifaire,
      min: num(r.prix_min),
      max: num(r.prix_max),
    });
  }
  console.log(`SNCF tarifs (2de classe) : ${tgv.length} lignes TGV INOUI / OUIGO, ${ic.length} lignes Intercités, ${rows.length} retenues`);
  if (ignored.size) console.log(`  écartées : ${[...ignored].map(([m, n]) => `${m} ${n}`).join(' · ')}`);
  return { rows, names, ignored };
}

// ─── Flixbus ──────────────────────────────────────────────────────────────────────────────────

const flixCache = new Map();
let flixRequests = 0;

/** Villes Flixbus (is_flixbus_city) renvoyées par l'autocomplétion : [{ cityId, name, lat, lon }]. */
async function flixbusCities(q) {
  const key = norm(q).trim();
  if (flixCache.has(key)) return flixCache.get(key);
  if (flixRequests++ > 0) await sleep(FLIXBUS_PAUSE_MS);
  const params = new URLSearchParams({ q, lang: 'fr', country: 'fr', flixbus_cities_only: 'false', stations: 'true' });
  const list = await fetchJson(`${FLIXBUS_API}?${params}`, { tries: 4, timeoutMs: 20_000, label: `Flixbus (${q})` });
  if (!Array.isArray(list)) throw new Error(`Flixbus (${q}) : réponse inattendue`);
  const cities = list
    .filter((c) => c?.is_flixbus_city === true && typeof c.id === 'string')
    .map((c) => ({ cityId: c.id, name: clean(c.name), lat: num(c.location?.lat), lon: num(c.location?.lon) }))
    .filter((c) => c.name && isNum(c.lat) && isNum(c.lon));
  flixCache.set(key, cities);
  return cities;
}

/**
 * Ville Flixbus la plus proche du hub (≤ FLIXBUS_MAX_KM), cherchée par le nom du hub, du centre
 * et de la gare. { city, failed } : failed = au moins une requête a échoué.
 */
async function nearestFlixbus(queries, hub) {
  let best = null;
  let failed = false;
  for (const q of queries) {
    let cities;
    try {
      cities = await flixbusCities(q);
    } catch (err) {
      failed = true;
      console.warn(`  ⚠ ${err.message}`);
      continue;
    }
    for (const c of cities) {
      const km = haversineKm(hub.lat, hub.lon, c.lat, c.lon);
      if (km > FLIXBUS_MAX_KM) continue;
      if (!best || km < best.km || (km === best.km && c.cityId < best.cityId)) best = { ...c, km };
    }
  }
  const city = best
    ? { cityId: best.cityId, name: best.name, lat: round(best.lat, 5), lon: round(best.lon, 5), km: round(best.km, 1) }
    : null;
  return { city, failed };
}

// ─── Programme principal ──────────────────────────────────────────────────────────────────────

async function main() {
  const source = JSON.parse(await readFile(SOURCE_FILE, 'utf8'));
  validateSource(source);
  const spotsJson = JSON.parse(await readFile(SPOTS_FILE, 'utf8'));
  const spots = spotsJson?.spots;
  if (!Array.isArray(spots) || spots.length === 0) throw new Error('data/spots.json : aucun décollage');
  const spotIds = new Set(spots.map((s) => s.id));
  const prevDest = await readJsonIfAny(DEST_FILE, 'data/destinations.json');
  const prevFares = await readJsonIfAny(FARES_FILE, 'data/fares.json');
  console.log(`${source.length} destinations dans la source, ${spots.length} décollages dans data/spots.json`);

  // 1. Centres et hubs (une requête par commune distincte).
  const communes = new Map();
  for (const d of source) {
    for (const c of [d.center, d.hub]) {
      const k = `${compact(c.commune)}|${c.dept}`;
      if (!communes.has(k)) communes.set(k, c);
    }
  }
  const geo = new Map();
  const geoErrors = [];
  await pool([...communes], GEO_CONCURRENCE, async ([k, c]) => {
    try {
      geo.set(k, await geocodeCommune(c));
    } catch (err) {
      geoErrors.push(err.message);
    }
  });
  geoErrors.sort();
  if (geoErrors.length) throw new Error(`géocodage :\n  - ${geoErrors.join('\n  - ')}`);
  const geoOf = (c) => geo.get(`${compact(c.commune)}|${c.dept}`);
  console.log(`Communes : ${geo.size} géocodées (${elapsed()})`);

  const dests = source.map((d) => {
    const center = geoOf(d.center).centre;
    const hubGeo = geoOf(d.hub);
    return {
      src: d,
      center,
      hub: { name: hubGeo.name, lat: hubGeo.mairie.lat, lon: hubGeo.mairie.lon },
      exclude: new Set(Object.keys(d.exclude ?? {})),
      spots: [],
    };
  });

  // 2. Décos : à ≤ radiusKm du centre, rattachés à la seule destination la plus proche.
  const disputes = [];
  for (const s of spots) {
    if (!isNum(s?.lat) || !isNum(s?.lon)) continue;
    const hits = [];
    for (const d of dests) {
      if (d.exclude.has(s.id)) continue;
      const km = haversineKm(d.center.lat, d.center.lon, s.lat, s.lon);
      if (km <= d.src.radiusKm) hits.push({ d, km });
    }
    if (hits.length === 0) continue;
    hits.sort((a, b) => a.km - b.km); // tri stable : à égalité, ordre de la source
    hits[0].d.spots.push({ id: s.id, name: s.name, km: hits[0].km });
    if (hits.length > 1) disputes.push(`${s.id} ${s.name} → ${hits.map((h) => `${h.d.src.id} ${h.km.toFixed(1)} km`).join(', ')}`);
  }
  for (const d of dests) d.spots.sort((a, b) => a.km - b.km || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (disputes.length) console.log(`Décos à portée de plusieurs destinations (gardés par la plus proche) :\n  - ${disputes.join('\n  - ')}`);

  const empty = dests.filter((d) => d.spots.length === 0).map((d) => d.src.id);
  if (empty.length) throw new Error(`destinations sans aucun déco : ${empty.join(', ')} (à retirer de la source ou rayon à revoir)`);

  // Contrôles : décos phares attendus, exclusions périmées.
  const warnings = [];
  for (const d of dests) {
    const names = d.spots.map((s) => compact(s.name));
    for (const w of d.src.expect ?? []) {
      if (!names.some((n) => n.includes(compact(w)))) warnings.push(`${d.src.id} : aucun déco ne contient « ${w} »`);
    }
    for (const id of d.exclude) {
      if (!spotIds.has(id)) warnings.push(`${d.src.id} : exclusion ${id} absente de data/spots.json`);
    }
  }

  // 3. Gares, tarifs et gares tarifées autour de chaque hub.
  const { gares, byUic } = await fetchGares();
  const { rows, names, ignored } = await fetchTarifs();
  const tarifUics = new Set(rows.flatMap((r) => [r.o, r.d]));
  const tarifCoords = [...tarifUics].filter((u) => byUic.has(u)).sort();

  for (const d of dests) {
    let best = null;
    for (const g of gares) {
      const km = haversineKm(d.hub.lat, d.hub.lon, g.lat, g.lon);
      if (!best || km < best.km) best = { g, km };
    }
    d.station =
      best && best.km <= GARE_MAX_KM
        ? {
            name: best.g.name,
            // Code UIC présent dans les tarifs si la gare en a plusieurs, sinon le premier.
            uic: best.g.uics.find((u) => tarifUics.has(u)) ?? best.g.uics[0],
            lat: round(best.g.lat, 5),
            lon: round(best.g.lon, 5),
            km: round(best.km, 1),
          }
        : null;
    const radius = d.src.fareRadiusKm ?? FARE_RADIUS_KM;
    d.fareStations = tarifCoords
      .map((u) => ({ u, km: haversineKm(d.hub.lat, d.hub.lon, byUic.get(u).lat, byUic.get(u).lon) }))
      .filter((x) => x.km <= radius)
      .sort((a, b) => a.km - b.km || (a.u < b.u ? -1 : 1))
      .slice(0, FARE_STATIONS_MAX)
      .map((x) => x.u);
    if (d.fareStations.length === 0) warnings.push(`${d.src.id} : aucune gare tarifée à ≤ ${radius} km du hub ${d.hub.name}`);
  }

  // 4. Flixbus : hub, centre puis gare ; valeur précédente conservée si l'API échoue.
  const prevFlix = new Map((prevDest?.json?.destinations ?? []).map((p) => [p.id, p.flixbus]));
  for (const d of dests) {
    const queries = [d.hub.name, geoOf(d.src.center).name, d.station?.name.split(' - ')[0]].filter(Boolean);
    const unique = [...new Map(queries.map((q) => [norm(q).trim(), q])).values()];
    const { city, failed } = await nearestFlixbus(unique, d.hub);
    if (!city && failed && prevFlix.has(d.src.id)) {
      d.flixbus = prevFlix.get(d.src.id) ?? null;
      warnings.push(`${d.src.id} : Flixbus injoignable, valeur précédente conservée`);
    } else {
      d.flixbus = city;
    }
  }
  console.log(`Flixbus : ${flixRequests} requêtes (${elapsed()})`);

  // 5. fares.json : couples dont une extrémité est une gare tarifée d'une destination. Le jeu de
  //    données ne publie souvent qu'un sens par couple, et pas le même selon le transporteur
  //    (TGV INOUI Grenoble>Paris mais OUIGO dans les deux sens). Les prix étant symétriques, on
  //    oriente chaque clé « départ>arrivée », l'arrivée étant une gare de destination, et on
  //    complète chaque sens, transporteur par transporteur, avec le sens inverse.
  const destUics = new Set(dests.flatMap((d) => d.fareStations));
  const directed = new Map(); // "o>d" → Map("transporteur|profil" → [min, max])
  for (const r of rows) {
    const k = `${r.o}>${r.d}`;
    if (!directed.has(k)) directed.set(k, new Map());
    const m = directed.get(k);
    const ek = `${r.carrier}|${r.profil}`;
    const prev = m.get(ek);
    m.set(ek, prev ? [Math.min(prev[0], r.min), Math.max(prev[1], r.max)] : [r.min, r.max]);
  }
  const pairs = new Map();
  for (const k of directed.keys()) {
    const [a, b] = k.split('>');
    for (const [o, d] of [[a, b], [b, a]]) {
      const key = `${o}>${d}`;
      if (!destUics.has(d) || pairs.has(key)) continue;
      const native = directed.get(key) ?? new Map();
      const reverse = directed.get(`${d}>${o}`) ?? new Map();
      pairs.set(key, new Map([...reverse, ...native])); // le sens publié l'emporte
    }
  }
  const entriesOf = (m) =>
    [...m]
      .map(([ek, [min, max]]) => {
        const [carrier, profil] = ek.split('|');
        return [carrier, profil, round(min, 2), round(max, 2)];
      })
      .sort((a, b) => TRANSPORTEURS.indexOf(a[0]) - TRANSPORTEURS.indexOf(b[0]) || PROFILS.indexOf(a[1]) - PROFILS.indexOf(b[1]));
  const pairKeys = [...pairs.keys()].sort();
  const stationUics = [...new Set(pairKeys.flatMap((k) => k.split('>')))].sort();
  const sansCoords = stationUics.filter((u) => !byUic.has(u));
  const stationsOut = stationUics.map((u) => {
    const g = byUic.get(u);
    return [u, { name: names.get(u) ?? g?.name ?? u, lat: g ? round(g.lat, 5) : null, lon: g ? round(g.lon, 5) : null }];
  });
  if (sansCoords.length) {
    warnings.push(`fares.json : ${sansCoords.length} gares sans coordonnées (${sansCoords.map((u) => `${u} ${names.get(u)}`).join(', ')})`);
  }

  // 6. Garde-fous puis écriture.
  const prevPairs = Object.keys(prevFares?.json?.pairs ?? {}).length;
  if (prevPairs > 0 && pairKeys.length < prevPairs * PERTE_MAX && !process.argv.includes('--force')) {
    throw new Error(`${pairKeys.length} couples tarifés contre ${prevPairs} précédemment : fichiers conservés (--force pour passer outre)`);
  }

  const destLines = dests.map((d) =>
    JSON.stringify({
      id: d.src.id,
      name: d.src.name,
      dept: d.src.center.dept,
      center: { lat: round(d.center.lat, 5), lon: round(d.center.lon, 5) },
      radiusKm: d.src.radiusKm,
      hub: { name: d.hub.name, lat: round(d.hub.lat, 5), lon: round(d.hub.lon, 5) },
      spots: d.spots.map((s) => s.id),
      station: d.station,
      fareStations: d.fareStations,
      flixbus: d.flixbus,
      note: d.src.note?.trim() || null,
    }),
  );
  const renderDest = (generatedAt) =>
    `${JSON.stringify({ generatedAt, count: dests.length }).slice(0, -1)},"destinations":[\n${destLines.join(',\n')}\n]}\n`;

  const faresHead = { source: 'SNCF Open Data : tarifs-tgv-inoui-ouigo, tarifs-intercites', license: 'ODbL' };
  const renderFares = (generatedAt) =>
    `${JSON.stringify({ ...faresHead, generatedAt }).slice(0, -1)},` +
    `"stations":{\n${stationsOut.map(([u, s]) => `${JSON.stringify(u)}:${JSON.stringify(s)}`).join(',\n')}\n},` +
    `"pairs":{\n${pairKeys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(entriesOf(pairs.get(k)))}`).join(',\n')}\n}}\n`;

  // Récapitulatif.
  const stationName = (u) => names.get(u) ?? byUic.get(u)?.name ?? u;
  for (const d of dests) {
    console.log(
      `${d.src.id.padEnd(24)} ${String(d.spots.length).padStart(2)} décos · hub ${d.hub.name}` +
        ` · gare ${d.station ? `${d.station.name} (${d.station.km} km)` : '—'}` +
        ` · tarifs ${d.fareStations.map(stationName).join(', ') || '—'}` +
        ` · Flixbus ${d.flixbus ? `${d.flixbus.name} (${d.flixbus.km} km)` : '—'}`,
    );
  }
  console.log(`fares.json : ${pairKeys.length} couples, ${stationUics.length} gares`);
  const ignoredProfils = [...ignored.keys()].filter((m) => m.startsWith('profil'));
  if (ignoredProfils.length) console.log(`Profils ignorés : ${ignoredProfils.join(', ')}`);
  for (const w of warnings) console.warn(`⚠ ${w}`);

  await writeIfChanged(DEST_FILE, prevDest, renderDest, 'data/destinations.json');
  await writeIfChanged(FARES_FILE, prevFares, renderFares, 'data/fares.json');
  console.log(`Terminé en ${elapsed()}`);
}

main().catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
