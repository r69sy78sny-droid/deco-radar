// Réglages centraux de Déco Radar : seuils météo, pondérations du score, coûts de trajet.
// Tout ce qui relève d'un choix « métier » est ici, pour pouvoir l'ajuster sans toucher au code.

/** Profils pilote : limites éliminatoires (km/h). Valeurs prudentes, à faire valider par un moniteur. */
export const PROFILES = {
  debutant: {
    label: 'Débutant · brevet initial',
    windMax: 20, // vent moyen au déco
    gustMax: 25, // rafales
    gustSpread: 10, // écart rafales − vent moyen (turbulence)
    wind850Max: 30, // vent météo vers 1 500 m (850 hPa)
    idealWind: [5, 15],
  },
  pilote: {
    label: 'Pilote · brevet de pilote',
    windMax: 25,
    gustMax: 32,
    gustSpread: 12,
    wind850Max: 40,
    idealWind: [5, 18],
  },
  confirme: {
    label: 'Confirmé',
    windMax: 30,
    gustMax: 38,
    gustSpread: 15,
    wind850Max: 50,
    idealWind: [5, 22],
  },
};

export const WEATHER_RULES = {
  rainMm: 0.2, // mm/h : au-delà, l'heure est éliminée (pluie)
  thunderCodes: [95, 96, 99], // codes WMO d'orage : journée éliminée s'il y en a un dans le créneau
  fogCodes: [45, 48],
  lowCloudMax: 90, // % de nuages bas : au-delà, déco probablement dans le nuage…
  lowCloudMinAlt: 600, // …seulement pour les décos au-dessus de cette altitude (m)
  turbulentGustRatio: 0.75, // l'écart rafales/vent n'élimine que si les rafales dépassent 75 % de la limite
  calmWind: 6, // km/h : en dessous, la direction du vent n'est plus un critère
  minBlockHours: 2, // il faut au moins 2 h volables d'affilée pour que la journée compte
};

/** Pondération du score global (sur 100) une fois la météo validée. */
export const SCORE_WEIGHTS = {
  meteo: 0.6,
  trajet: 0.4,
  trajetTemps: 0.75, // part de la durée dans le score trajet (le reste = coût)
};

/** Barèmes du score trajet. */
export const TRAVEL_SCALE = {
  fullScoreHours: 1, // ≤ 1 h de trajet (aller) → 100
  zeroScoreHours: 12, // ≥ 12 h → 0 (un bus de nuit fait souvent 8 à 10 h)
  fullScoreEuros: 15, // coût aller-retour par personne ≤ 15 € → 100
  zeroScoreEuros: 200, // ≥ 200 € → 0
};

export const VERDICTS = {
  go: { label: 'Go', minScore: 65, minMeteo: 60 },
  jouable: { label: 'Jouable', minScore: 40 },
  non: { label: 'Passe ton chemin' },
};

/** Hypothèses de coût (modifiables dans « Réglages avancés »). */
export const COST_DEFAULTS = {
  fuelPrice: 1.85, // €/L
  consumption: 6.5, // L/100 km
  tolls: true,
  tollPerKm: 0.09, // €/km d'autoroute (moyenne des sociétés d'autoroute)
  passengers: 1,
  trainLongPerKm: 0.12, // €/km de TGV / Intercités (plein tarif moyen, hors promo)
  trainShortPerKm: 0.1, // €/km de TER
  taxiPerKm: 2.2, // €/km entre la gare et le déco
  taxiBase: 5,
};

/** Modèle de temps de trajet en train quand on n'a pas de clé API SNCF. */
export const TRAIN_MODEL = {
  longThresholdKm: 180, // distance à vol d'oiseau au-delà de laquelle on suppose un TGV
  longSpeed: 190, // km/h effectifs sur le réseau
  longOverhead: 0.6, // h : accès gare, attente, correspondance
  shortSpeed: 85,
  shortOverhead: 0.4,
  railDetour: 1.25, // distance ferroviaire / distance à vol d'oiseau
  walkMaxKm: 1.2, // au-delà, on compte un taxi / une navette
  lastMileSpeed: 40, // km/h sur route de montagne
  lastMileWait: 0.25, // h
  roadDetour: 1.4,
};

/** Flixbus avant d'avoir les vrais horaires : vitesse moyenne, attente, prix d'un aller. */
export const FLIXBUS_ESTIMATE = { detour: 1.3, speed: 65, overhead: 0.75, base: 6, perKm: 0.08 };

/** Estimation grossière d'un temps de route, utilisée seulement pour présélectionner les spots. */
export const ROAD_GUESS = { detour: 1.3, speed: 85, overhead: 0.25 };

/** Modèles Open-Meteo, du plus précis au plus grossier. */
export const MODELS = [
  { id: 'meteofrance_arome_france_hd', label: 'AROME HD', res: '1,3 km', precision: 'haute' },
  { id: 'meteofrance_arome_france', label: 'AROME', res: '2,5 km', precision: 'haute' },
  { id: 'meteofrance_arpege_europe', label: 'ARPEGE', res: '10 km', precision: 'moyenne' },
  { id: 'ecmwf_ifs', label: 'ECMWF IFS', res: '9 km', precision: 'moyenne' },
  { id: 'ecmwf_ifs025', label: 'ECMWF', res: '25 km', precision: 'faible' },
];

export const HOURLY_VARS = [
  'wind_speed_10m',
  'wind_gusts_10m',
  'wind_direction_10m',
  'precipitation',
  'cloud_cover',
  'cloud_cover_low',
  'weather_code',
  'cape',
  'wind_speed_850hPa',
];

export const API = {
  openMeteo: 'https://api.open-meteo.com/v1/forecast',
  communes: 'https://geo.api.gouv.fr/communes',
  osrmTable: 'https://router.project-osrm.org/table/v1/driving/',
  sncf: 'https://api.sncf.com/v1/coverage/sncf/journeys',
};

export const LIMITS = {
  weatherBatch: 50, // lieux par requête Open-Meteo
  weatherConcurrency: 2,
  weatherPointsPerRun: 250, // points météo par analyse (au-delà, l'analyse patiente pour respecter le quota)
  osrmBatch: 99, // destinations par requête OSRM
  sncfTop: 8, // trajets SNCF réels calculés pour les N meilleures destinations
  flixbusAuto: 5, // horaires Flixbus chargés d'office pour les N meilleures destinations
};

export const DEFAULTS = {
  city: { name: 'Paris', dept: '75', lat: 48.8566, lon: 2.3522 },
  mode: 'bus', // bus | train | car | best
  maxHours: 12,
  fareProfile: 'normal', // normal | avantage | etudiant
  profile: 'debutant',
  windowStart: 10,
  windowEnd: 18,
};
