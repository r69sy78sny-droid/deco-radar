// Tests des modules de trajet purs : js/flixbus.js, js/fares.js, js/destinations.js, js/transport.js.
// Lancement : npm test (node --test tests/*.test.mjs). Aucune dépendance, aucun appel réseau :
// Flixbus est testé sur une vraie réponse enregistrée (tests/fixtures), le reste sur des données synthétiques.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { COST_DEFAULTS, TRAIN_MODEL, PROFILES } from '../js/config.js';
import { haversineKm } from '../js/geo.js';
import { evaluateDay } from '../js/scoring.js';
import { parseRides, planRoundTrip, rideCost, shiftDate, rideTime, flixbusLink } from '../js/flixbus.js';
import { trainFares } from '../js/fares.js';
import { summarizeDestination } from '../js/destinations.js';
import { carCostDetail, carCost, railEstimate, accessTo, betterJourney } from '../js/transport.js';

// Filet de sécurité : un test qui tenterait un appel réseau échoue immédiatement.
globalThis.fetch = async (url) => {
  throw new Error(`Appel réseau interdit dans les tests : ${url}`);
};

const proche = (reel, attendu, eps = 1e-9, msg) =>
  assert.ok(Math.abs(reel - attendu) <= eps, msg ?? `${reel} ≠ ${attendu} (± ${eps})`);

/** Exécute `fn` avec un fuseau horaire imposé, puis rétablit le précédent. */
function avecFuseau(tz, fn) {
  const avant = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (avant === undefined) delete process.env.TZ;
    else process.env.TZ = avant;
  }
}

// ---------------------------------------------------------------------------
// parseRides : vraie réponse Flixbus Paris → Annecy du 26/09/2026
// ---------------------------------------------------------------------------

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/flixbus-paris-annecy-2026-09-26.json', import.meta.url), 'utf8'));
const RESULTATS = Object.values(FIXTURE.trips[0].results);
const GARES_PARIS = ['Paris (Bercy Seine)', 'Paris (Porte Maillot)', 'Paris - Massy'];

describe('parseRides (réponse Flixbus réelle)', () => {
  const trajets = parseRides(FIXTURE);
  const trouve = (dep, from) => trajets.find((t) => t.dep === dep && (!from || t.from === from));

  test('la réponse contient bien 17 trajets, dont un complet', () => {
    assert.equal(RESULTATS.length, 17);
    assert.equal(RESULTATS.filter((r) => r.status !== 'available').length, 1);
  });

  test('les trajets non « available » sont ignorés : 16 trajets réservables', () => {
    assert.equal(trajets.length, 16);
    // Le bus de 20h00 depuis Bercy est complet (prix 0) : il ne doit pas apparaître.
    assert.equal(trouve('2026-09-26T20:00:00+02:00'), undefined);
    assert.ok(trajets.every((t) => t.price > 0));
  });

  test('trajets triés par heure de départ', () => {
    for (let i = 1; i < trajets.length; i++) {
      assert.ok(trajets[i - 1].dep <= trajets[i].dep, `${trajets[i - 1].dep} après ${trajets[i].dep}`);
    }
    assert.equal(trajets[0].dep, '2026-09-26T00:30:00+02:00');
    assert.equal(trajets.at(-1).dep, '2026-09-27T01:45:00+02:00');
  });

  test("le tri ne dépend pas de l'ordre de la réponse", () => {
    const melange = structuredClone(FIXTURE);
    melange.trips[0].results = Object.fromEntries(Object.entries(melange.trips[0].results).reverse());
    assert.deepEqual(
      parseRides(melange).map((t) => t.dep),
      trajets.map((t) => t.dep),
    );
  });

  test('prix = total_with_platform_fee (frais de plateforme inclus), pas total', () => {
    for (const r of RESULTATS.filter((x) => x.status === 'available')) {
      const t = trouve(r.departure.date, FIXTURE.stations[r.departure.station_id].name);
      assert.ok(t, `trajet ${r.departure.date} absent`);
      assert.equal(t.price, r.price.total_with_platform_fee);
      assert.notEqual(t.price, r.price.total);
    }
    assert.equal(trouve('2026-09-26T00:30:00+02:00').price, 59.47);
  });

  test('noms de gares au départ et à l’arrivée', () => {
    assert.ok(trajets.every((t) => GARES_PARIS.includes(t.from)), trajets.map((t) => t.from).join(', '));
    assert.ok(trajets.every((t) => t.to === 'Annecy'));
    assert.equal(trouve('2026-09-26T19:50:00+02:00').from, 'Paris - Massy');
    assert.equal(trouve('2026-09-26T01:45:00+02:00').from, 'Paris (Porte Maillot)');
  });

  test('correspondances et villes « via »', () => {
    const viaChambery = trouve('2026-09-26T00:30:00+02:00');
    assert.equal(viaChambery.transfers, 1);
    assert.deepEqual(viaChambery.via, ['Chambéry']);
    assert.deepEqual(trouve('2026-09-26T01:10:00+02:00').via, ['Lyon']);
    assert.deepEqual(trouve('2026-09-26T11:05:00+02:00').via, ['Genève']);

    const direct = trouve('2026-09-26T23:10:00+02:00', 'Paris (Porte Maillot)');
    assert.equal(direct.transfers, 0);
    assert.deepEqual(direct.via, []);
    assert.equal(trajets.filter((t) => t.transfers === 0).length, 1);
    assert.ok(trajets.every((t) => t.via.length === t.transfers));
  });

  test('durée, places et moyen de transport', () => {
    const t = trouve('2026-09-26T00:30:00+02:00');
    assert.equal(t.minutes, 8 * 60 + 50);
    assert.equal(t.seats, 17);
    assert.equal(t.train, false);
    // La durée annoncée correspond à l'écart entre départ et arrivée pour tous les trajets.
    for (const x of trajets) assert.equal(x.minutes, (Date.parse(x.arr) - Date.parse(x.dep)) / 60000, x.dep);
  });

  test('les dates restent des chaînes locales, sans conversion de fuseau', () => {
    const t = trouve('2026-09-26T23:10:00+02:00', 'Paris (Porte Maillot)');
    assert.equal(t.arr, '2026-09-27T06:40:00+02:00');
  });

  test('réponse vide ou mal formée → []', () => {
    const malFormees = [
      undefined,
      null,
      '<html>erreur</html>',
      42,
      {},
      { message: 'Too many requests' },
      { trips: null },
      { trips: [] },
      { trips: {} },
      { trips: [null] },
      { trips: [{}] },
      { trips: [{ results: null }] },
      { trips: [{ results: {} }] },
      { trips: [{ results: { a: null } }] },
      { trips: [{ results: { a: { status: 'available' } } }] }, // ni prix ni dates
      { trips: [{ results: { a: { status: 'available', price: { total: 10 } } } }] }, // prix mais pas de dates
    ];
    for (const json of malFormees) assert.deepEqual(parseRides(json), [], JSON.stringify(json));
  });
});

describe('parseRides (cas synthétiques)', () => {
  const reponse = (resultat, extra = {}) => ({
    trips: [{ results: { r1: { status: 'available', ...resultat } } }],
    cities: { c1: { name: 'Paris' }, c2: { name: 'Lyon' }, c3: { name: 'Annecy' } },
    stations: { s1: { name: 'Paris (Bercy Seine)' } },
    ...extra,
  });
  const base = {
    departure: { date: '2026-09-26T07:00:00+02:00', city_id: 'c1', station_id: 's1' },
    arrival: { date: '2026-09-26T12:00:00+02:00', city_id: 'c3', station_id: 'inconnue' },
    duration: { hours: 5, minutes: 0 },
    price: { total: 20, total_with_platform_fee: 21 },
  };

  test('sans total_with_platform_fee, on se rabat sur total ; sans prix, trajet ignoré', () => {
    assert.equal(parseRides(reponse({ ...base, price: { total: 20 } }))[0].price, 20);
    assert.deepEqual(parseRides(reponse({ ...base, price: {} })), []);
    assert.deepEqual(parseRides(reponse({ ...base, price: undefined })), []);
  });

  test('gare inconnue → nom de la ville, puis « ? »', () => {
    const [t] = parseRides(reponse(base));
    assert.equal(t.from, 'Paris (Bercy Seine)');
    assert.equal(t.to, 'Annecy');
    const [u] = parseRides(reponse({ ...base, arrival: { ...base.arrival, city_id: 'inconnue' } }));
    assert.equal(u.to, '?');
  });

  test('un tronçon en train est signalé, les places inconnues valent null', () => {
    const legs = [
      { arrival: { city_id: 'c2', station_id: 'x' }, means_of_transport: 'bus' },
      { arrival: { city_id: 'c3', station_id: 'y' }, means_of_transport: 'train' },
    ];
    const [t] = parseRides(reponse({ ...base, legs }));
    assert.equal(t.train, true);
    assert.equal(t.transfers, 1);
    assert.deepEqual(t.via, ['Lyon']);
    assert.equal(t.seats, null);
  });
});

// ---------------------------------------------------------------------------
// planRoundTrip : trajets synthétiques au format de parseRides
// ---------------------------------------------------------------------------

const J = '2026-09-26'; // samedi : jour de vol
const VEILLE = '2026-09-25';
const LENDEMAIN = '2026-09-27';

/** Trajet au format parseRides. `dep` / `arr` : « AAAA-MM-JJTHH:MM » (heure locale d'été). */
function trajet(dep, arr, price, extra = {}) {
  const d = `${dep}:00+02:00`;
  const a = `${arr}:00+02:00`;
  return {
    dep: d,
    arr: a,
    from: 'Paris (Bercy Seine)',
    to: 'Annecy',
    minutes: (Date.parse(a) - Date.parse(d)) / 60000,
    price,
    transfers: 0,
    via: [],
    seats: 20,
    train: false,
    ...extra,
  };
}

const estTrie = (liste, cle) => liste.every((r, i) => i === 0 || liste[i - 1][cle] <= r[cle]);

describe('planRoundTrip : aller', () => {
  test('le moins cher parmi les arrivées du jour J entre 5 h et arriveBy', () => {
    const plan = planRoundTrip(
      {
        outPrev: [
          trajet(`${VEILLE}T23:10`, `${J}T06:40`, 30),
          trajet(`${VEILLE}T08:00`, `${VEILLE}T17:00`, 3), // arrive la veille : hors jeu
        ],
        outDay: [
          trajet(`${J}T00:30`, `${J}T09:20`, 45),
          trajet(`${J}T06:40`, `${J}T11:55`, 25),
          trajet(`${J}T08:40`, `${J}T18:15`, 10), // moins cher mais arrive trop tard
          trajet(`${J}T23:10`, `${LENDEMAIN}T06:40`, 5), // arrive le lendemain
        ],
      },
      J,
    );
    assert.equal(plan.out.dep, `${J}T06:40:00+02:00`);
    assert.equal(plan.out.price, 25);
    assert.equal(plan.outNight, false);
    assert.equal(plan.outLate, false);
    assert.deepEqual(
      plan.outOptions.map((r) => r.price),
      [30, 45, 25],
    );
  });

  test('le bus de nuit parti la veille est retenu quand il est le moins cher', () => {
    const plan = planRoundTrip(
      {
        outPrev: [trajet(`${VEILLE}T23:10`, `${J}T06:40`, 19)],
        outDay: [trajet(`${J}T00:30`, `${J}T09:20`, 45)],
      },
      J,
    );
    assert.equal(plan.out.dep, `${VEILLE}T23:10:00+02:00`);
    assert.equal(plan.outNight, false);
  });

  test('bornes : 5 h pile et arriveBy pile sont acceptés, 4 h 59 et arriveBy + 1 min non', () => {
    const cinqH = planRoundTrip({ outDay: [trajet(`${J}T00:00`, `${J}T05:00`, 20)] }, J);
    assert.equal(cinqH.out.price, 20);
    assert.equal(cinqH.outNight, false);

    const avantCinq = planRoundTrip({ outDay: [trajet(`${J}T00:00`, `${J}T04:59`, 20)] }, J);
    assert.equal(avantCinq.outNight, true);

    const midi = planRoundTrip({ outDay: [trajet(`${J}T07:00`, `${J}T12:00`, 20)] }, J);
    assert.equal(midi.outLate, false);

    const midiUne = planRoundTrip({ outDay: [trajet(`${J}T07:01`, `${J}T12:01`, 20)] }, J);
    assert.equal(midiUne.outLate, true);
  });

  test('arriveBy personnalisé', () => {
    const rides = { outDay: [trajet(`${J}T04:00`, `${J}T09:00`, 40), trajet(`${J}T06:00`, `${J}T10:30`, 20)] };
    assert.equal(planRoundTrip(rides, J, { arriveBy: 10 }).out.price, 40);
    assert.equal(planRoundTrip(rides, J, { arriveBy: 11 }).out.price, 20);
  });

  test('à prix égal, le trajet le plus court ; à coût ressenti égal, la première arrivée', () => {
    const plusCourt = planRoundTrip(
      { outDay: [trajet(`${J}T06:00`, `${J}T11:00`, 25), trajet(`${J}T02:00`, `${J}T08:00`, 25)] },
      J,
    );
    assert.equal(plusCourt.out.arr, `${J}T11:00:00+02:00`);
    const egal = planRoundTrip(
      { outDay: [trajet(`${J}T06:00`, `${J}T11:00`, 25), trajet(`${J}T03:00`, `${J}T08:00`, 25)] },
      J,
    );
    assert.equal(egal.out.arr, `${J}T08:00:00+02:00`);
  });

  test('coût ressenti : un direct un peu plus cher bat un trajet bien plus long (cas réel Paris → Clermont)', () => {
    // 25/09/2026 : 19h50 → 8h15 (12 h 25, 1 corresp.) à 43,47 € contre 23h30 → 8h45 (9 h 15) à 43,97 €.
    const long = trajet(`${VEILLE}T19:50`, `${J}T08:15`, 43.47, { transfers: 1 });
    const court = trajet(`${VEILLE}T23:30`, `${J}T08:45`, 43.97, { transfers: 1 });
    assert.ok(rideCost(court) < rideCost(long));
    assert.equal(planRoundTrip({ outPrev: [long, court] }, J).out, court);
    // Sans valeur du temps, on retombe sur le moins cher.
    assert.equal(planRoundTrip({ outPrev: [long, court] }, J, { timeValue: 0 }).out, long);
  });

  test('à défaut, une arrivée en pleine nuit (outNight), préférée à une arrivée tardive même moins chère', () => {
    const plan = planRoundTrip(
      {
        outPrev: [trajet(`${VEILLE}T20:00`, `${J}T03:30`, 60), trajet(`${VEILLE}T21:00`, `${J}T04:15`, 50)],
        outDay: [trajet(`${J}T08:40`, `${J}T18:15`, 10)],
      },
      J,
    );
    assert.equal(plan.out.price, 50);
    assert.equal(plan.outNight, true);
    assert.equal(plan.outLate, false);
    assert.ok(plan.outOptions.every((r) => r.arr < `${J}T05`));
  });

  test('sinon, l’arrivée la plus tôt du jour J (outLate), même si une autre est moins chère', () => {
    const plan = planRoundTrip(
      {
        outDay: [
          trajet(`${J}T10:25`, `${J}T20:35`, 20),
          trajet(`${J}T08:40`, `${J}T18:15`, 45),
          trajet(`${J}T11:05`, `${J}T21:00`, 15),
        ],
      },
      J,
    );
    assert.equal(plan.out.arr, `${J}T18:15:00+02:00`);
    assert.equal(plan.outLate, true);
    assert.equal(plan.outNight, false);
    assert.ok(plan.outOptions.includes(plan.out));
  });

  test("un même bus d'après minuit renvoyé par les recherches de la veille et du jour n'est proposé qu'une fois", () => {
    // Avec include_after_midnight_rides, la recherche du 25 renvoie aussi les départs du 26 à 0h30,
    // que la recherche du 26 renvoie également (voir la fixture : départs du 27 à 0h30, 1h10, 1h45).
    const nuit = () => trajet(`${J}T00:30`, `${J}T09:20`, 59.47);
    const plan = planRoundTrip(
      { outPrev: [trajet(`${VEILLE}T23:10`, `${J}T06:40`, 52.98), nuit()], outDay: [nuit(), trajet(`${J}T06:40`, `${J}T11:55`, 46.47)] },
      J,
    );
    assert.deepEqual(
      plan.outOptions.map((r) => r.dep),
      [`${VEILLE}T23:10:00+02:00`, `${J}T00:30:00+02:00`, `${J}T06:40:00+02:00`],
    );
  });
});

describe('planRoundTrip : retour', () => {
  const allerMatin = { outDay: [trajet(`${J}T00:30`, `${J}T09:20`, 50)] };

  test('le soir même après leaveAfter, au plus faible coût ressenti', () => {
    const plan = planRoundTrip(
      {
        ...allerMatin,
        backDay: [
          trajet(`${J}T14:00`, `${J}T23:00`, 5), // trop tôt
          trajet(`${J}T17:00`, `${LENDEMAIN}T02:00`, 30),
          trajet(`${J}T21:00`, `${LENDEMAIN}T06:00`, 20),
          trajet(`${J}T19:30`, `${LENDEMAIN}T05:00`, 20),
          trajet(`${LENDEMAIN}T00:30`, `${LENDEMAIN}T09:00`, 1), // départ après minuit : pas « le soir même »
        ],
        backNext: [trajet(`${LENDEMAIN}T08:00`, `${LENDEMAIN}T17:00`, 3)],
      },
      J,
    );
    // 21h00 et 19h30 coûtent 20 € ; 21h00 dure 9 h contre 9 h 30 : il l'emporte.
    assert.equal(plan.back.dep, `${J}T21:00:00+02:00`);
    assert.equal(plan.backNextDay, false);
    assert.deepEqual(
      plan.backOptions.map((r) => r.dep.slice(11, 16)),
      ['17:00', '19:30', '21:00'],
    );
  });

  test('leaveAfter pile est accepté, et le réglage est respecté', () => {
    const backDay = [trajet(`${J}T16:00`, `${J}T23:00`, 10), trajet(`${J}T20:00`, `${LENDEMAIN}T04:00`, 30)];
    assert.equal(planRoundTrip({ ...allerMatin, backDay }, J).back.price, 10);
    assert.equal(planRoundTrip({ ...allerMatin, backDay }, J, { leaveAfter: 17 }).back.price, 30);
  });

  test('à défaut, le lendemain (backNextDay), le moins cher du lendemain seulement', () => {
    const plan = planRoundTrip(
      {
        ...allerMatin,
        backDay: [trajet(`${J}T08:00`, `${J}T17:00`, 5)],
        backNext: [
          trajet(`${LENDEMAIN}T07:00`, `${LENDEMAIN}T16:00`, 40),
          trajet(`${LENDEMAIN}T13:00`, `${LENDEMAIN}T22:00`, 25),
          trajet(`2026-09-28T00:30`, `2026-09-28T09:00`, 2), // renvoyé par la recherche du 27 mais parti le 28
        ],
      },
      J,
    );
    assert.equal(plan.back.dep, `${LENDEMAIN}T13:00:00+02:00`);
    assert.equal(plan.backNextDay, true);
    assert.equal(plan.backOptions.length, 2);
  });

  test("le retour ne part jamais avant l'arrivée de l'aller", () => {
    // Aller tardif (arrivée 18h15) : le bus de 17h30 est impossible à prendre.
    const rides = {
      outDay: [trajet(`${J}T08:40`, `${J}T18:15`, 45)],
      backDay: [trajet(`${J}T17:30`, `${LENDEMAIN}T03:00`, 10), trajet(`${J}T19:30`, `${LENDEMAIN}T05:00`, 30)],
      backNext: [trajet(`${LENDEMAIN}T08:00`, `${LENDEMAIN}T17:00`, 20)],
    };
    const plan = planRoundTrip(rides, J);
    assert.equal(plan.outLate, true);
    assert.equal(plan.back.dep, `${J}T19:30:00+02:00`);
    assert.ok(plan.backOptions.every((r) => r.dep > plan.out.arr));

    // S'il n'y a plus aucun départ après l'arrivée, on passe au lendemain.
    const sansSoir = planRoundTrip({ ...rides, backDay: [rides.backDay[0]] }, J);
    assert.equal(sansSoir.back.dep, `${LENDEMAIN}T08:00:00+02:00`);
    assert.equal(sansSoir.backNextDay, true);
  });
});

describe('planRoundTrip sur la vraie réponse Flixbus', () => {
  test('aller du 26/09 : le 1h45 de Porte Maillot (58,47 €), même si la veille renvoie les mêmes bus', () => {
    const trajets = parseRides(FIXTURE);
    // La recherche de la veille renverrait aussi les départs du 26 après minuit : on simule le doublon.
    const plan = planRoundTrip({ outPrev: parseRides(FIXTURE), outDay: trajets }, J);
    assert.equal(plan.out.dep, `${J}T01:45:00+02:00`);
    assert.equal(plan.out.from, 'Paris (Porte Maillot)');
    assert.equal(plan.out.price, 58.47);
    assert.equal(plan.outNight, false);
    assert.equal(plan.outLate, false);
    assert.deepEqual(
      plan.outOptions.map((r) => r.dep.slice(11, 16)),
      ['00:30', '01:10', '01:45'],
    );
  });
});

describe('planRoundTrip : total, options, cas vides', () => {
  test('total = prix aller + prix retour', () => {
    const plan = planRoundTrip(
      { outDay: [trajet(`${J}T00:30`, `${J}T09:20`, 59.47)], backDay: [trajet(`${J}T18:00`, `${LENDEMAIN}T03:00`, 44.97)] },
      J,
    );
    proche(plan.total, 59.47 + 44.97, 1e-9);
  });

  test('total null s’il manque l’aller ou le retour', () => {
    const sansRetour = planRoundTrip({ outDay: [trajet(`${J}T00:30`, `${J}T09:20`, 30)] }, J);
    assert.ok(sansRetour.out);
    assert.equal(sansRetour.back, null);
    assert.equal(sansRetour.total, null);

    const sansAller = planRoundTrip({ backDay: [trajet(`${J}T18:00`, `${LENDEMAIN}T03:00`, 30)] }, J);
    assert.equal(sansAller.out, null);
    assert.ok(sansAller.back);
    assert.equal(sansAller.total, null);
  });

  test('options limitées à 5, triées par départ, sans modifier les listes reçues', () => {
    const heures = ['07', '02', '05', '00', '06', '03', '04']; // départs dans le désordre
    // Le moins cher (40 €) part à 7h10 : il n'est pas parmi les 5 premiers départs.
    const outDay = heures.map((h, i) => trajet(`${J}T${h}:10`, `${J}T${String(Number(h) + 5).padStart(2, '0')}:00`, 40 + i));
    const backDay = heures.map((h, i) => trajet(`${J}T${Number(h) + 16}:10`, `${LENDEMAIN}T06:00`, 30 + i));
    const copieOut = [...outDay];
    const copieBack = [...backDay];
    const plan = planRoundTrip({ outDay, backDay }, J);

    assert.equal(plan.outOptions.length, 5);
    assert.ok(estTrie(plan.outOptions, 'dep'));
    assert.equal(plan.outOptions[0].dep, `${J}T00:10:00+02:00`);
    assert.equal(plan.backOptions.length, 5);
    assert.ok(estTrie(plan.backOptions, 'dep'));
    assert.equal(plan.out.price, 40); // le choix porte sur tous les trajets, pas seulement sur les 5 affichés
    assert.equal(plan.back.price, 30); // retour de 23h10, lui aussi hors des 5 premiers départs
    assert.deepEqual(outDay, copieOut);
    assert.deepEqual(backDay, copieBack);
  });

  test('aucun trajet : tout est vide et aucun drapeau levé', () => {
    const attendu = {
      out: null,
      outNight: false,
      outLate: false,
      outOptions: [],
      back: null,
      backNextDay: false,
      backOptions: [],
      total: null,
    };
    assert.deepEqual(planRoundTrip({}, J), attendu);
    assert.deepEqual(planRoundTrip({ outPrev: [], outDay: [], backDay: [], backNext: [] }, J), attendu);
    // Des trajets existent, mais aucun ne tombe les bons jours.
    assert.deepEqual(
      planRoundTrip(
        {
          outDay: [trajet(`${J}T23:10`, `${LENDEMAIN}T06:40`, 20)],
          backNext: [trajet(`2026-09-28T08:00`, `2026-09-28T17:00`, 20)],
        },
        J,
      ),
      attendu,
    );
  });
});

// ---------------------------------------------------------------------------
// shiftDate, rideTime, flixbusLink
// ---------------------------------------------------------------------------

describe('shiftDate', () => {
  test('décalages simples', () => {
    assert.equal(shiftDate('2026-09-26', 0), '2026-09-26');
    assert.equal(shiftDate('2026-09-26', 1), '2026-09-27');
    assert.equal(shiftDate('2026-09-26', -1), '2026-09-25');
    assert.equal(shiftDate('2026-09-26', 365), '2027-09-26');
  });

  test('fin de mois (y compris février bissextile)', () => {
    assert.equal(shiftDate('2026-09-30', 1), '2026-10-01');
    assert.equal(shiftDate('2026-10-01', -1), '2026-09-30');
    assert.equal(shiftDate('2026-02-28', 1), '2026-03-01');
    assert.equal(shiftDate('2028-02-28', 1), '2028-02-29');
    assert.equal(shiftDate('2028-03-01', -1), '2028-02-29');
  });

  test("fin d'année", () => {
    assert.equal(shiftDate('2026-12-31', 1), '2027-01-01');
    assert.equal(shiftDate('2027-01-01', -1), '2026-12-31');
  });

  test("passage à l'heure d'hiver (nuit du 24 au 25 octobre 2026), quel que soit le fuseau de la machine", () => {
    for (const tz of ['Europe/Paris', 'America/New_York', 'Pacific/Auckland', 'UTC']) {
      avecFuseau(tz, () => {
        assert.equal(shiftDate('2026-10-24', 1), '2026-10-25', tz);
        assert.equal(shiftDate('2026-10-25', 1), '2026-10-26', tz);
        assert.equal(shiftDate('2026-10-26', -1), '2026-10-25', tz);
        assert.equal(shiftDate('2026-10-25', -1), '2026-10-24', tz);
        // Dix jours d'affilée autour du changement d'heure : ni doublon ni trou.
        const jours = Array.from({ length: 10 }, (_, i) => shiftDate('2026-10-20', i));
        assert.deepEqual(
          jours.map((d) => Number(d.slice(8))),
          [20, 21, 22, 23, 24, 25, 26, 27, 28, 29],
          tz,
        );
      });
    }
  });
});

describe('rideTime', () => {
  test('heure seule au format 22h15', () => {
    assert.equal(rideTime('2026-09-25T22:15:00+02:00'), '22h15');
    assert.equal(rideTime('2026-09-26T07:05:00+02:00'), '07h05');
  });

  test('avec le jour : « ven. 25 · 22h15 »', () => {
    assert.equal(rideTime('2026-09-25T22:15:00+02:00', true), 'ven. 25 · 22h15');
    assert.equal(rideTime('2026-09-27T00:30:00+02:00', true), 'dim. 27 · 00h30');
  });

  test("lit l'heure locale telle quelle, sans conversion, quel que soit le fuseau de la machine", () => {
    for (const tz of ['America/Los_Angeles', 'Asia/Tokyo', 'UTC']) {
      avecFuseau(tz, () => {
        assert.equal(rideTime('2026-09-26T00:30:00+02:00', true), 'sam. 26 · 00h30', tz);
        assert.equal(rideTime('2026-10-25T02:30:00+01:00', true), 'dim. 25 · 02h30', tz);
      });
    }
  });
});

describe('flixbusLink', () => {
  test('recherche pré-remplie sur shop.flixbus.fr', () => {
    const url = new URL(flixbusLink('40de8964-8646-11e6-9066-549f350fcb0c', '40dfe930-8646-11e6-9066-549f350fcb0c', '2026-09-26'));
    assert.equal(url.origin, 'https://shop.flixbus.fr');
    assert.equal(url.pathname, '/search');
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      departureCity: '40de8964-8646-11e6-9066-549f350fcb0c',
      arrivalCity: '40dfe930-8646-11e6-9066-549f350fcb0c',
      rideDate: '26.09.2026',
      adult: '1',
    });
  });

  test('les identifiants sont encodés', () => {
    const url = new URL(flixbusLink('a b', 'c&d', '2027-01-05'));
    assert.equal(url.searchParams.get('departureCity'), 'a b');
    assert.equal(url.searchParams.get('arrivalCity'), 'c&d');
    assert.equal(url.searchParams.get('rideDate'), '05.01.2027');
    assert.equal([...url.searchParams.keys()].length, 4);
  });
});

// ---------------------------------------------------------------------------
// trainFares : table de tarifs synthétique
// ---------------------------------------------------------------------------

const PARIS = { lat: 48.8566, lon: 2.3522 };
const BREST = { lat: 48.3904, lon: -4.4861 };

const FARES = {
  stations: {
    '87686006': { name: 'Paris Gare de Lyon', lat: 48.8443, lon: 2.373 }, // ≈ 2 km du centre
    '87391003': { name: 'Paris Montparnasse', lat: 48.8412, lon: 2.3203 }, // ≈ 3 km
    '87393702': { name: 'Massy TGV', lat: 48.7255, lon: 2.26 }, // ≈ 16 km
    '87543009': { name: 'Orléans', lat: 47.9078, lon: 1.9048 }, // ≈ 110 km : trop loin
    '87746008': { name: 'Annecy', lat: 45.902, lon: 6.1216 },
    '87741009': { name: 'Aix-les-Bains-le-Revard', lat: 45.6878, lon: 5.9094 },
  },
  pairs: {
    '87686006>87746008': [
      ['TGV INOUI', 'normal', 45, 120],
      ['TGV INOUI', 'avantage', 30, 80],
      ['OUIGO', 'normal', 29, 89],
    ],
    '87391003>87746008': [['TGV INOUI', 'normal', 60, 130]],
    '87393702>87746008': [['OUIGO', 'normal', 19, 69]],
    '87543009>87746008': [['TER', 'normal', 5, 10]],
  },
};
const ANNECY = { id: 'annecy', fareStations: ['87746008'] };

describe('trainFares', () => {
  test('couple le moins cher parmi les gares à ≤ 40 km du départ (une gare plus loin, même moins chère, est ignorée)', () => {
    const f = trainFares(FARES, PARIS, ANNECY);
    assert.equal(f.from, 'Massy TGV');
    assert.equal(f.to, 'Annecy');
    assert.equal(f.min, 19);
    assert.equal(f.max, 69);
    assert.equal(f.mid, 44);
    assert.deepEqual(f.offers, [{ carrier: 'OUIGO', profile: 'normal', min: 19, max: 69 }]);
  });

  test('rayon maxKm personnalisé', () => {
    const f = trainFares(FARES, PARIS, ANNECY, 'normal', 10); // Massy (≈ 16 km) sort du rayon
    assert.equal(f.from, 'Paris Gare de Lyon');
    assert.equal(f.min, 29); // OUIGO
    assert.equal(f.max, 120); // TGV INOUI plein tarif
    assert.equal(f.mid, (29 + 120) / 2);
    assert.equal(f.offers.length, 2);
    // Avec un rayon de 150 km, Orléans entre en jeu.
    assert.equal(trainFares(FARES, PARIS, ANNECY, 'normal', 150).from, 'Orléans');
  });

  test('profil demandé quand il existe, sinon tarif normal ; OUIGO n’a que le tarif normal', () => {
    const f = trainFares(FARES, PARIS, ANNECY, 'avantage', 10);
    const parTransporteur = Object.fromEntries(f.offers.map((o) => [o.carrier, o]));
    assert.deepEqual(parTransporteur['TGV INOUI'], { carrier: 'TGV INOUI', profile: 'avantage', min: 30, max: 80 });
    assert.deepEqual(parTransporteur.OUIGO, { carrier: 'OUIGO', profile: 'normal', min: 29, max: 89 });
    assert.equal(f.min, 29);
    assert.equal(f.max, 89);

    // Profil absent de la table pour TGV INOUI : repli sur le tarif normal.
    const e = trainFares(FARES, PARIS, ANNECY, 'etudiant', 10);
    assert.ok(e.offers.every((o) => o.profile === 'normal'));
    assert.equal(e.max, 120);
  });

  test("le profil demandé l'emporte quel que soit l'ordre des lignes", () => {
    const fares = { ...FARES, pairs: { '87686006>87746008': [['TGV INOUI', 'avantage', 30, 80], ['TGV INOUI', 'normal', 45, 120]] } };
    const f = trainFares(fares, PARIS, ANNECY, 'avantage');
    assert.deepEqual(f.offers, [{ carrier: 'TGV INOUI', profile: 'avantage', min: 30, max: 80 }]);
  });

  test('à prix égal, la gare de départ la plus proche', () => {
    const fares = {
      ...FARES,
      pairs: { '87391003>87746008': [['TGV INOUI', 'normal', 25, 90]], '87686006>87746008': [['TGV INOUI', 'normal', 25, 100]] },
    };
    assert.equal(trainFares(fares, PARIS, ANNECY).from, 'Paris Gare de Lyon');
  });

  test('plusieurs gares à destination : la plus proche du site qui a un tarif, même si une autre est moins chère', () => {
    const fares = {
      ...FARES,
      pairs: { ...FARES.pairs, '87393702>87741009': [['OUIGO', 'normal', 15, 50]], '87393702>87999999': [['TER', 'normal', 12, 20]] },
    };
    const proche = trainFares(fares, PARIS, { fareStations: ['87746008', '87741009'] });
    assert.equal(proche.toUic, '87746008');
    assert.equal(proche.to, FARES.stations['87746008'].name);
    // Gare la plus proche sans tarif : on passe à la suivante ; nom inconnu → code UIC.
    const inconnue = trainFares(fares, PARIS, { fareStations: ['87000000', '87999999'] });
    assert.equal(inconnue.to, '87999999');
    assert.equal(inconnue.toUic, '87999999');
    assert.equal(inconnue.min, 12);
  });

  test('destination sans fareStations → null', () => {
    assert.equal(trainFares(FARES, PARIS, { id: 'x' }), null);
    assert.equal(trainFares(FARES, PARIS, { id: 'x', fareStations: [] }), null);
  });

  test('aucune gare à moins de 40 km du départ → null', () => {
    assert.equal(trainFares(FARES, BREST, ANNECY), null);
  });

  test('table absente, sans couple utile ou sans tarif du profil → null', () => {
    assert.equal(trainFares(null, PARIS, ANNECY), null);
    assert.equal(trainFares({ stations: FARES.stations }, PARIS, ANNECY), null);
    assert.equal(trainFares({ ...FARES, pairs: {} }, PARIS, ANNECY), null);
    assert.equal(trainFares({ ...FARES, pairs: { '87686006>87746008': [] } }, PARIS, ANNECY), null);
    const seulementAvantage = { ...FARES, pairs: { '87686006>87746008': [['TGV INOUI', 'avantage', 30, 80]] } };
    assert.equal(trainFares(seulementAvantage, PARIS, ANNECY, 'etudiant'), null);
  });
});

// ---------------------------------------------------------------------------
// summarizeDestination
// ---------------------------------------------------------------------------

const volable = (id, meteoScore, flyableHours) => ({ spot: { id }, day: { flyable: true, meteoScore, flyableHours, mainReason: null } });
const nonVolable = (id, mainReason) => ({ spot: { id }, day: { flyable: false, meteoScore: 0, mainReason } });

describe('summarizeDestination', () => {
  test('meilleur déco = meilleure note météo', () => {
    const r = summarizeDestination([volable('planfait', 62, 8), volable('forclaz', 81, 4), nonVolable('semnoz', 'Pluie (10h–12h, 1 mm)')]);
    assert.equal(r.best.spot.id, 'forclaz');
    assert.equal(r.day.meteoScore, 81);
    assert.deepEqual(
      r.flyable.map((x) => x.spot.id),
      ['forclaz', 'planfait'],
    );
    assert.equal(r.total, 3);
  });

  test('égalité de note : le plus d’heures volables, puis l’identifiant', () => {
    assert.equal(summarizeDestination([volable('a', 70, 4), volable('b', 70, 6)]).best.spot.id, 'b');
    assert.equal(summarizeDestination([volable('b', 70, 6), volable('a', 70, 6)]).best.spot.id, 'a');
    assert.equal(summarizeDestination([volable('a', 70, 6), volable('b', 70, 6)]).best.spot.id, 'a');
  });

  test('destination non volable : journée du motif le plus fréquent (détails ignorés)', () => {
    const r = summarizeDestination([
      nonVolable('pluie', 'Pluie (10h–14h, 3 mm)'),
      nonVolable('vent1', "Vent trop fort (jusqu'à 35 km/h)"),
      nonVolable('vent2', "Vent trop fort (jusqu'à 28 km/h)"),
    ]);
    assert.equal(r.best, null);
    assert.deepEqual(r.flyable, []);
    assert.equal(r.total, 3);
    assert.equal(r.day.mainReason, "Vent trop fort (jusqu'à 35 km/h)"); // le premier déco de ce motif
  });

  test('motifs à égalité : choix stable, indépendant de l’ordre des décos', () => {
    const a = nonVolable('a', 'Pluie (10h–14h, 3 mm)');
    const b = nonVolable('b', "Vent trop fort (jusqu'à 35 km/h)");
    assert.equal(summarizeDestination([a, b]).day.mainReason, summarizeDestination([b, a]).day.mainReason);
  });

  test('liste vide', () => {
    const r = summarizeDestination([]);
    assert.equal(r.best, null);
    assert.deepEqual(r.flyable, []);
    assert.equal(r.total, 0);
    assert.equal(r.day.flyable, false);
    assert.equal(r.day.meteoScore, 0);
    assert.equal(r.day.mainReason, 'Aucun déco analysé');
  });

  test('fonctionne avec de vraies journées evaluateDay', () => {
    const heure = (hour, extra = {}) => ({ hour, wind: 10, gust: 15, dir: 0, rain: 0, cloud: 30, cloudLow: 0, code: 1, cape: 100, wind850: 15, ...extra });
    const creneau = (extra = () => ({})) => Array.from({ length: 8 }, (_, i) => heure(10 + i, extra(10 + i)));
    const deco = (id) => ({ id, alt: 1000, orient: ['N'], orientOk: [] });
    const jour = (id, hours) => ({ spot: deco(id), day: evaluateDay(hours, deco(id), PROFILES.debutant) });

    const bon = jour('bon', creneau());
    const orage = jour('orage', creneau((h) => (h === 12 ? { code: 95 } : {})));
    assert.equal(bon.day.flyable, true);
    assert.equal(summarizeDestination([orage, bon]).best.spot.id, 'bon');

    const pluie = jour('pluie', creneau(() => ({ rain: 2 })));
    const r = summarizeDestination([orage, pluie, jour('pluie2', creneau(() => ({ rain: 1 })))]);
    assert.equal(r.best, null);
    assert.match(r.day.mainReason, /^Pluie \(/);
  });
});

// ---------------------------------------------------------------------------
// Voiture, train estimé, accès au déco
// ---------------------------------------------------------------------------

const COUT = { fuelPrice: 2, consumption: 5, tolls: true, tollPerKm: 0.1, passengers: 1 };
const KM_PAR_DEGRE = (6371 * Math.PI) / 180; // le long d'un méridien, haversineKm est exactement linéaire
const auNord = (p, km) => ({ lat: p.lat + km / KM_PAR_DEGRE, lon: p.lon });

describe('carCostDetail / carCost', () => {
  test('carburant et péages aller-retour (80 % d’autoroute au-delà des 50 premiers km)', () => {
    const d = carCostDetail(250, COUT);
    proche(d.fuel, 2 * 250 * 0.05 * 2); // 50 €
    proche(d.tolls, 2 * (250 - 50) * 0.8 * 0.1); // 32 €
    proche(d.total, 82);
    proche(d.euros, 82);
  });

  test('partage entre passagers ; 0 passager compte pour 1', () => {
    proche(carCostDetail(250, { ...COUT, passengers: 2 }).euros, 41);
    proche(carCostDetail(250, { ...COUT, passengers: 4 }).euros, 20.5);
    proche(carCostDetail(250, { ...COUT, passengers: 4 }).total, 82); // le total ne change pas
    proche(carCostDetail(250, { ...COUT, passengers: 0 }).euros, 82);
  });

  test('péages désactivés', () => {
    const d = carCostDetail(250, { ...COUT, tolls: false });
    assert.equal(d.tolls, 0);
    proche(d.total, d.fuel);
  });

  test('pas de péage jusqu’à 100 km', () => {
    for (const km of [0, 30, 80, 100]) assert.equal(carCostDetail(km, COUT).tolls, 0, `${km} km`);
    assert.ok(carCostDetail(101, COUT).tolls > 0);
    proche(carCostDetail(100, COUT).total, 2 * 100 * 0.05 * 2);
  });

  test('carCost = part par personne de carCostDetail', () => {
    for (const km of [40, 150, 600]) {
      for (const passengers of [1, 3]) {
        const c = { ...COST_DEFAULTS, passengers };
        assert.equal(carCost(km, c), carCostDetail(km, c).euros);
      }
    }
  });
});

describe('railEstimate', () => {
  const COUT_TRAIN = { trainLongPerKm: 0.12, trainShortPerKm: 0.1 };
  const origine = { lat: 45, lon: 5 };
  const m = TRAIN_MODEL;

  test(`sous ${m.longThresholdKm} km à vol d’oiseau : TER (vitesse, attente et prix au km du trajet court)`, () => {
    const gare = auNord(origine, m.longThresholdKm - 1);
    const crow = haversineKm(origine, gare);
    const r = railEstimate(origine, gare, COUT_TRAIN);
    proche(r.hours, (crow * m.railDetour) / m.shortSpeed + m.shortOverhead);
    proche(r.euros, 2 * crow * m.railDetour * COUT_TRAIN.trainShortPerKm);
  });

  test(`à partir de ${m.longThresholdKm} km : TGV`, () => {
    const gare = auNord(origine, m.longThresholdKm + 1);
    const crow = haversineKm(origine, gare);
    const r = railEstimate(origine, gare, COUT_TRAIN);
    proche(r.hours, (crow * m.railDetour) / m.longSpeed + m.longOverhead);
    proche(r.euros, 2 * crow * m.railDetour * COUT_TRAIN.trainLongPerKm);
  });

  test('le seuil vient du modèle passé en paramètre', () => {
    const gare = auNord(origine, 100);
    const court = railEstimate(origine, gare, COUT_TRAIN);
    const long = railEstimate(origine, gare, COUT_TRAIN, { ...m, longThresholdKm: 50 });
    assert.ok(long.hours < court.hours);
    assert.ok(long.euros > court.euros);
  });

  test('même gare : seulement le temps d’accès, 0 €', () => {
    const r = railEstimate(origine, origine, COUT_TRAIN);
    assert.equal(r.hours, m.shortOverhead);
    assert.equal(r.euros, 0);
  });
});

describe('accessTo', () => {
  const gare = { lat: 45.9, lon: 6.12 };
  const m = TRAIN_MODEL;
  const COUT_TAXI = { taxiBase: 5, taxiPerKm: 2.2, passengers: 1 };
  // Distance routière = distance à vol d'oiseau × roadDetour.
  const aRoute = (kmRoute) => auNord(gare, kmRoute / m.roadDetour);

  test(`à pied jusqu’à ${m.walkMaxKm} km de route`, () => {
    const a = accessTo(gare, aRoute(m.walkMaxKm - 0.01), COUT_TAXI);
    assert.equal(a.walk, true);
    assert.equal(a.taxi, 0);
    proche(a.km, m.walkMaxKm - 0.01, 1e-6);
    proche(a.hours, a.km / 4.5);
  });

  test('au-delà : taxi ou navette, aller-retour partagé entre passagers', () => {
    const a = accessTo(gare, aRoute(m.walkMaxKm + 0.01), COUT_TAXI);
    assert.equal(a.walk, false);
    proche(a.hours, a.km / m.lastMileSpeed + m.lastMileWait);
    proche(a.taxi, 2 * (5 + a.km * 2.2));

    const loin = accessTo(gare, aRoute(12), COUT_TAXI);
    proche(loin.km, 12, 1e-6);
    proche(loin.taxi, 2 * (5 + 12 * 2.2), 1e-6); // 62,80 €
    proche(accessTo(gare, aRoute(12), { ...COUT_TAXI, passengers: 3 }).taxi, loin.taxi / 3, 1e-9);
    proche(accessTo(gare, aRoute(12), { ...COUT_TAXI, passengers: 0 }).taxi, loin.taxi, 1e-9);
  });

  test('déco sur place : 0 km, à pied', () => {
    const a = accessTo(gare, gare, COST_DEFAULTS);
    assert.deepEqual(a, { km: 0, hours: 0, taxi: 0, walk: true });
  });
});

describe('betterJourney (choix du train avec la clé SNCF)', () => {
  const j = (dep, arr, hours) => ({
    departure: dep.replace(':', ''),
    arrival: arr.replace(':', ''),
    arrivalAt: `20260926T${arr.replace(':', '')}00`,
    arrivalHour: Number(arr.slice(0, 2)),
    hours,
  });

  test('arrivée avant midi : le plus court gagne (cas réel Paris → Clermont)', () => {
    const viaLyon = j('06:53', '11:11', 4.3);
    const direct = j('06:57', '10:33', 3.6);
    assert.deepEqual([viaLyon, direct].sort(betterJourney)[0], direct);
  });

  test('une arrivée avant midi bat toujours une arrivée l’après-midi, même plus courte', () => {
    const matin = j('05:10', '11:50', 6.7);
    const aprem = j('14:10', '20:13', 6.0);
    assert.deepEqual([aprem, matin].sort(betterJourney)[0], matin);
  });

  test('aucune arrivée le matin : la plus tôt, à égalité la plus courte (cas réel Paris → Chamonix)', () => {
    const a = j('06:10', '13:13', 7.0);
    const b = j('06:40', '13:13', 6.5);
    const c = j('14:10', '20:13', 6.0);
    assert.deepEqual([c, a, b].sort(betterJourney)[0], b);
  });
});
