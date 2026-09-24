#!/usr/bin/env node
/**
 * Vérifie une clé API SNCF (Navitia) avec la même fonction que le site, sans jamais afficher la clé.
 *
 *   read -s "SNCF_API_KEY?Clé API SNCF : " && export SNCF_API_KEY && node scripts/check-sncf.mjs
 *
 * (`read -s` masque la saisie et la clé ne va pas dans l'historique du terminal.)
 */
import { readFileSync } from 'node:fs';
import { API } from '../js/config.js';
import { sncfJourney } from '../js/transport.js';
import { trainFares } from '../js/fares.js';

const key = process.env.SNCF_API_KEY?.trim();
if (!key) {
  console.error('Variable SNCF_API_KEY absente : voir la commande en tête de ce fichier.');
  process.exit(1);
}

// 1. La clé est-elle acceptée ?
const auth = await fetch(API.sncf.replace('/journeys', ''), { headers: { Authorization: key } });
console.log(`Clé : ${auth.ok ? 'acceptée' : `refusée (HTTP ${auth.status})`}`);
if (!auth.ok) process.exit(1);

// 2. Trajets réels vers les gares des sites prioritaires, samedi prochain.
const { destinations } = JSON.parse(readFileSync(new URL('../data/destinations.json', import.meta.url), 'utf8'));
const byId = Object.fromEntries(destinations.map((d) => [d.id, d]));
const fares = JSON.parse(readFileSync(new URL('../data/fares.json', import.meta.url), 'utf8'));
const now = new Date();
const saturday = new Date(now.getTime() + (((6 - now.getDay() + 7) % 7) || 7) * 86400000);
const date = saturday.toISOString().slice(0, 10);
const origins = { Paris: { lat: 48.8566, lon: 2.3522 }, Lyon: { lat: 45.758, lon: 4.8351 } };
const cases = [
  ['Paris', 'annecy'],
  ['Paris', 'chamonix'],
  ['Paris', 'puy-de-dome'],
  ['Paris', 'saint-hilaire-du-touvet'],
  ['Lyon', 'chamonix'],
  ['Lyon', 'millau'],
];
console.log(`Date testée : ${date}`);
for (const [from, id] of cases) {
  const st = byId[id]?.station;
  if (!st) {
    console.log(`${from} → ${id} : pas de gare dans destinations.json`);
    continue;
  }
  try {
    // Même départ que le site : la gare du tarif SNCF retenu, sinon l'arrêt le plus proche.
    const f = trainFares(fares, origins[from], byId[id]);
    const j = await sncfJourney(origins[from], st, date, key, undefined, f?.fromUics);
    const hm = (s) => `${s.slice(0, 2)}h${s.slice(2)}`;
    console.log(
      j
        ? `${j.from ?? from} → ${st.name} : ${hm(j.departure)} → ${hm(j.arrival)}, ${(j.hours).toFixed(1).replace('.', ',')} h, ${j.transfers} corresp. (${j.modes.join(', ')})`
        : `${from} → ${st.name} : aucun trajet renvoyé`,
    );
  } catch (err) {
    console.log(`${from} → ${st.name} : erreur ${err.message}`);
  }
}
