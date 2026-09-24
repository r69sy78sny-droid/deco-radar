// Prévisions Open-Meteo : on interroge explicitement les modèles Météo-France (AROME HD 1,3 km
// en priorité), et on complète heure par heure avec le modèle suivant quand une variable manque.

import { API, MODELS, HOURLY_VARS, LIMITS } from './config.js';

const FIELD = {
  wind_speed_10m: 'wind',
  wind_gusts_10m: 'gust',
  wind_direction_10m: 'dir',
  precipitation: 'rain',
  cloud_cover: 'cloud',
  cloud_cover_low: 'cloudLow',
  weather_code: 'code',
  cape: 'cape',
  wind_speed_850hPa: 'wind850',
};

/** Clé de regroupement : deux décos dans la même maille (~1 km) et à altitude voisine partagent la prévision. */
export function weatherKey(spot) {
  return `${spot.lat.toFixed(2)}|${spot.lon.toFixed(2)}|${Math.round((spot.alt ?? 0) / 150)}`;
}

export class WeatherError extends Error {}

// Quota gratuit d'Open-Meteo : 600 appels/min, un lieu comptant max(variables / 10, 1) appels.
// On garde la trace des appels de la dernière minute (même d'une analyse à l'autre) et on patiente
// avant d'envoyer un paquet qui ferait dépasser la marge.
const QUOTA_PER_MIN = 540;
const sent = [];

async function throttle(weight, signal, onWait) {
  for (;;) {
    const now = Date.now();
    while (sent.length && now - sent[0].t > 60000) sent.shift();
    const used = sent.reduce((s, x) => s + x.w, 0);
    if (used + weight <= QUOTA_PER_MIN || !sent.length) break;
    const wait = 60000 - (now - sent[0].t) + 250;
    onWait?.(Math.ceil(wait / 1000));
    await sleep(Math.min(wait, 5000), signal);
  }
  sent.push({ t: Date.now(), w: weight });
}

const callWeight = (nLocations, nVars) => nLocations * Math.max(nVars / 10, 1);

// Cache mémoire (30 min) : changer de ville, de niveau ou de créneau ne retélécharge pas la météo.
const CACHE_MS = 30 * 60 * 1000;
const cache = new Map();
const cached = (k) => {
  const hit = cache.get(k);
  return hit && Date.now() - hit.t < CACHE_MS ? hit.value : undefined;
};

async function getJson(url, signal, onWait, retries = 3) {
  let quotaWaits = 0;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { signal });
    } catch (err) {
      if (err.name === 'AbortError' || attempt >= retries) throw err;
      await sleep(1000 * attempt, signal);
      continue;
    }
    if (res.ok) return res.json();
    const body = await res.json().catch(() => ({}));
    if (res.status === 429) {
      if (/hourly|daily/i.test(body.reason ?? '')) {
        const when = /daily/i.test(body.reason) ? 'demain' : "dans l'heure";
        throw new WeatherError(`Quota gratuit d'Open-Meteo épuisé pour ta connexion : réessaie ${when}.`);
      }
      // Quota de la minute dépassé (par exemple après un rechargement de page) : on patiente et on réessaie.
      if (++quotaWaits > 4) {
        throw new WeatherError(
          "Quota gratuit d'Open-Meteo atteint. Patiente quelques minutes ou réduis le nombre de points météo.",
        );
      }
      for (let left = 20; left > 0; left -= 5) {
        onWait?.(left);
        await sleep(5000, signal);
      }
      attempt--;
      continue;
    }
    if (attempt >= retries || res.status < 500) {
      throw new WeatherError(`Open-Meteo : ${body.reason ?? `erreur ${res.status}`}`);
    }
    await sleep(1500 * attempt, signal);
  }
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new DOMException('Annulé', 'AbortError'));
    });
  });
}

function buildUrl(points, date, models, vars = HOURLY_VARS) {
  const p = new URLSearchParams({
    latitude: points.map((x) => x.lat.toFixed(4)).join(','),
    longitude: points.map((x) => x.lon.toFixed(4)).join(','),
    // L'altitude du déco sert à choisir une maille d'altitude voisine (cell_selection=land par défaut).
    elevation: points.map((x) => (x.alt == null ? 'nan' : Math.round(x.alt))).join(','),
    hourly: vars.join(','),
    models: models.join(','),
    start_date: date,
    end_date: date,
    timezone: 'Europe/Paris',
    wind_speed_unit: 'kmh',
  });
  return `${API.openMeteo}?${p}`;
}

/** Série horaire d'une variable pour un modèle (sans suffixe quand un seul modèle est demandé). */
function series(hourly, v, modelId, single) {
  return hourly[`${v}_${modelId}`] ?? (single ? hourly[v] : undefined) ?? [];
}

/**
 * Sonde un point pour savoir quels modèles couvrent le créneau à cette date, et renvoie la chaîne
 * minimale : on s'arrête au premier modèle qui fournit toutes les variables sur tout le créneau.
 */
export async function chooseModels(point, date, window, signal, onWait) {
  const cacheKey = `chain|${date}|${window.start}|${window.end}`;
  const hit = cached(cacheKey);
  if (hit) return hit;
  const vars = ['wind_speed_10m', 'cloud_cover', 'weather_code', 'wind_speed_850hPa'];
  await throttle(callWeight(1, vars.length * MODELS.length), signal);
  const data = await getJson(buildUrl([point], date, MODELS.map((m) => m.id), vars), signal, onWait);
  const hours = data.hourly.time.map((t) => Number(t.slice(11, 13)));
  const inWindow = hours.map((h) => h >= window.start && h < window.end);
  const chain = [];
  for (const m of MODELS) {
    const covered = vars.map((v) => series(data.hourly, v, m.id, false).filter((x, i) => inWindow[i] && x != null).length);
    if (covered.every((n) => n === 0)) continue;
    chain.push(m);
    if (covered.every((n) => n === inWindow.filter(Boolean).length)) break;
  }
  if (!chain.length) throw new WeatherError('Aucun modèle météo ne couvre cette date.');
  cache.set(cacheKey, { t: Date.now(), value: chain });
  return chain;
}

/**
 * Prévisions horaires (24 h) pour une liste de points, fusionnées selon la chaîne de modèles.
 * @returns {Promise<Map<string, object[]>>} clé weatherKey → heures { hour, wind, gust, dir, …, model }
 */
export async function fetchWeather(points, date, chain, { signal, onProgress, onWait } = {}) {
  const ids = chain.map((m) => m.id);
  const single = ids.length === 1;
  const tag = `wx|${date}|${ids.join(',')}|`;
  const out = new Map();
  const todo = [];
  for (const p of points) {
    const hit = cached(tag + p.key);
    if (hit) out.set(p.key, hit);
    else todo.push(p);
  }
  const batches = [];
  for (let i = 0; i < todo.length; i += LIMITS.weatherBatch) batches.push(todo.slice(i, i + LIMITS.weatherBatch));

  let done = points.length - todo.length;
  onProgress?.(done, points.length);
  const worker = async () => {
    while (batches.length) {
      const batch = batches.shift();
      await throttle(callWeight(batch.length, HOURLY_VARS.length * ids.length), signal, onWait);
      const data = await getJson(buildUrl(batch, date, ids), signal, onWait);
      const list = Array.isArray(data) ? data : [data];
      list.forEach((loc, i) => {
        const hours = mergeHours(loc.hourly, chain, single);
        out.set(batch[i].key, hours);
        cache.set(tag + batch[i].key, { t: Date.now(), value: hours });
      });
      done += batch.length;
      onProgress?.(done, points.length);
    }
  };
  await Promise.all(Array.from({ length: LIMITS.weatherConcurrency }, worker));
  return out;
}

function mergeHours(hourly, chain, single) {
  return hourly.time.map((time, i) => {
    const h = { time, hour: Number(time.slice(11, 13)), model: null };
    for (const v of HOURLY_VARS) {
      h[FIELD[v]] = null;
      for (const m of chain) {
        const x = series(hourly, v, m.id, single)[i];
        if (x != null) {
          h[FIELD[v]] = x;
          if (v === 'wind_speed_10m') h.model = m;
          break;
        }
      }
    }
    return h;
  });
}

/** Modèle ayant fourni le vent sur la majorité du créneau (pour l'afficher sur la fiche). */
export function dominantModel(hours) {
  const count = new Map();
  for (const h of hours) if (h.model) count.set(h.model, (count.get(h.model) ?? 0) + 1);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
