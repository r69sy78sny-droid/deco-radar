// Tests du module météo avec des réponses Open-Meteo simulées (aucun appel réseau).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModels, fetchWeather, weatherKey, dominantModel } from '../js/weather.js';
import { MODELS, HOURLY_VARS } from '../js/config.js';

const HD = MODELS[0];
const AROME = MODELS[1];
const WINDOW = { start: 10, end: 18 };

/** Série horaire de 24 valeurs, `null` en dehors de [from, to[. */
const serie = (value, from = 0, to = 24) => Array.from({ length: 24 }, (_, h) => (h >= from && h < to ? value : null));
const times = (date) => Array.from({ length: 24 }, (_, h) => `${date}T${String(h).padStart(2, '0')}:00`);

/** AROME HD fournit le vent (jusqu'à 14h) mais pas la couverture totale ni le vent à 850 hPa ; AROME fournit tout. */
function locationPayload(date, models) {
  const hourly = { time: times(date) };
  for (const m of models) {
    for (const v of HOURLY_VARS) {
      let values;
      if (m === HD.id) {
        values = ['cloud_cover', 'weather_code', 'wind_speed_850hPa'].includes(v) ? serie(null) : serie(v === 'wind_speed_10m' ? 11 : 1, 0, 14);
      } else {
        values = serie(v === 'wind_speed_10m' ? 22 : v === 'cloud_cover' ? 40 : 2);
      }
      hourly[models.length === 1 ? v : `${v}_${m}`] = values;
    }
  }
  return { hourly };
}

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return handler(new URL(url), calls.length);
  };
  return calls;
}

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

test('chooseModels : chaîne minimale AROME HD → AROME quand AROME couvre tout le créneau', async () => {
  mockFetch((url) => json(locationPayload('2030-01-01', url.searchParams.get('models').split(','))));
  const chain = await chooseModels({ lat: 45, lon: 6, alt: 1000 }, '2030-01-01', WINDOW);
  assert.deepEqual(chain.map((m) => m.id), [HD.id, AROME.id]);
});

test('fetchWeather : fusion heure par heure, AROME HD prioritaire, AROME en relais', async () => {
  const date = '2030-01-02';
  mockFetch((url) => {
    const n = url.searchParams.get('latitude').split(',').length;
    const one = locationPayload(date, url.searchParams.get('models').split(','));
    return json(n === 1 ? one : Array.from({ length: n }, () => one));
  });
  const spots = [
    { lat: 45.81, lon: 6.25, alt: 1250 },
    { lat: 45.9, lon: 6.1, alt: 900 },
  ].map((s) => ({ ...s, key: weatherKey(s) }));
  const out = await fetchWeather(spots, date, [HD, AROME]);
  const hours = out.get(spots[0].key);
  assert.equal(hours.length, 24);
  assert.equal(hours[10].wind, 11, 'vent AROME HD le matin');
  assert.equal(hours[10].model, HD);
  assert.equal(hours[15].wind, 22, 'vent AROME après la fin d’AROME HD');
  assert.equal(hours[15].model, AROME);
  assert.equal(hours[10].cloud, 40, 'couverture totale prise dans AROME');
  assert.equal(dominantModel(hours.slice(12, 18)), AROME, "2 h AROME HD contre 4 h AROME");
});

test('fetchWeather : les points déjà téléchargés viennent du cache', async () => {
  const date = '2030-01-03';
  const calls = mockFetch((url) => {
    const n = url.searchParams.get('latitude').split(',').length;
    const one = locationPayload(date, url.searchParams.get('models').split(','));
    return json(n === 1 ? one : Array.from({ length: n }, () => one));
  });
  const a = { lat: 44.1, lon: 5.1, alt: 800 };
  const b = { lat: 44.2, lon: 5.2, alt: 800 };
  const pts = [a, b].map((s) => ({ ...s, key: weatherKey(s) }));
  await fetchWeather([pts[0]], date, [HD, AROME]);
  assert.equal(calls.length, 1);
  await fetchWeather(pts, date, [HD, AROME]);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1]).searchParams.get('latitude').split(',').length, 1, 'seul le point nouveau est demandé');
});

test('quota horaire épuisé : erreur claire immédiate, sans nouvelle tentative', async () => {
  const calls = mockFetch(() => json({ error: true, reason: 'Hourly API request limit exceeded.' }, 429));
  const p = { lat: 43, lon: 5, alt: 500 };
  await assert.rejects(fetchWeather([{ ...p, key: weatherKey(p) }], '2030-01-04', [HD, AROME]), /dans l'heure/);
  assert.equal(calls.length, 1);
});

test('quota journalier épuisé : le message renvoie à demain', async () => {
  mockFetch(() => json({ error: true, reason: 'Daily API request limit exceeded.' }, 429));
  const p = { lat: 43.5, lon: 5.5, alt: 500 };
  await assert.rejects(fetchWeather([{ ...p, key: weatherKey(p) }], '2030-01-05', [HD, AROME]), /demain/);
});
