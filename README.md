# Déco Radar

**Go ou passe ton chemin ?** Une application web qui passe en revue les décollages de parapente de France pour un jour donné. Elle croise la météo haute résolution (AROME 1,3 km de Météo-France) avec l'orientation de chaque déco, puis le temps et le coût du trajet depuis ta ville. Chaque déco reçoit un score sur 100 et un verdict : 🟢 **Go**, 🟠 **Jouable** ou 🔴 **Passe ton chemin**.

> Outil d'aide à la préparation, pas une autorisation de voler. Consulte la fiche du site, les balises et ton moniteur, et juge toujours sur place.

## Architecture

100 % front-end statique, hébergé gratuitement sur **GitHub Pages**. Pas de serveur, pas de build : HTML, CSS et JavaScript en modules ES natifs.

```
                    ┌────────────── GitHub (dépôt public) ──────────────┐
  chaque lundi      │  Action « Mise à jour des décollages »            │
  ───────────────►  │  scripts/build-spots.mjs → data/spots.json        │
                    │  (FFVL si clé, sinon ParaglidingEarth             │
                    │   + commune + gare SNCF la plus proche)           │
                    │                    │ commit                       │
                    │                    ▼                              │
                    │  Action « Publication GitHub Pages »              │
                    │  tests du moteur de score → mise en ligne         │
                    └───────────────────────┬───────────────────────────┘
                                            │ https://<compte>.github.io/deco-radar/
                                            ▼
  Navigateur ── data/spots.json (statique)
      │── geo.api.gouv.fr       ville de départ (autocomplétion)
      │── Open-Meteo            prévisions AROME HD → AROME → ARPEGE → ECMWF
      │── OSRM                  durées et distances routières (1 requête pour ~100 spots)
      └── API SNCF (facultatif) horaires réels de train, avec la clé de l'utilisateur
```

Pourquoi ce choix plutôt que Streamlit : aucun serveur à maintenir ni à réveiller (Streamlit Community Cloud met les applis en veille), chargement instantané, et toutes les API choisies acceptent les appels directs depuis un navigateur (CORS). Chaque visiteur consomme son propre quota Open-Meteo, pas celui d'un serveur commun. La seule tâche « serveur », reconstruire la liste des décollages, tourne une fois par semaine dans GitHub Actions. C'est aussi ce qui permet de garder une clé FFVL secrète.

## Sources de données et API

| Besoin | API | Clé | Détails |
|---|---|---|---|
| Décollages | [API FFVL](https://data.ffvl.fr/api) `base=terrains` | clé personnelle gratuite, à demander à informatique@ffvl.fr | Utilisée par l'Action hebdomadaire si le secret `FFVL_API_KEY` est défini. Les anciens fichiers publics `data.ffvl.fr/json/*.json` exigent eux aussi une clé. |
| Décollages (repli) | [ParaglidingEarth](https://www.paraglidingearth.com/) | aucune | CC BY-SA 3.0. 1 051 décollages en France (hors treuils, sites privés ou interdits), orientations pour 83 % d'entre eux. |
| Ville rattachée | [geo.api.gouv.fr](https://geo.api.gouv.fr/decoupage-administratif/communes) | aucune | Géocodage inverse côté script, recherche de la ville de départ côté navigateur. |
| Gare la plus proche | [SNCF Open Data, gares de voyageurs](https://ressources.data.sncf.com/explore/dataset/gares-de-voyageurs/) | aucune | ODbL, 2 782 gares. |
| Météo | [Open-Meteo](https://open-meteo.com/en/docs/meteofrance-api) | aucune | Gratuit pour un usage non commercial (600 appels/min, 10 000/jour par visiteur). |
| Route | [OSRM](https://project-osrm.org/) (serveur de démonstration) | aucune | Service `table` : durées et distances vers ~100 spots en une requête. Données © OpenStreetMap. |
| Train (facultatif) | [API SNCF / Navitia](https://numerique.sncf.com/startup/api/) | clé gratuite (5 000 requêtes/mois) | L'utilisateur colle sa clé dans « Réglages avancés ». Elle reste dans son navigateur. Sans clé : temps de train estimé. |

### Modèles météo

L'application ne se contente pas de `best_match` : elle interroge explicitement les modèles, du plus fin au plus grossier, et complète heure par heure les variables manquantes avec le modèle suivant :

| Modèle | Maille | Échéance | Rôle |
|---|---|---|---|
| AROME France HD | 1,3 km | ~J+2 | vent, rafales, direction, pluie, nuages bas, CAPE |
| AROME France | 2,5 km | ~J+2 | couverture totale, code météo (orages), vent à 850 hPa |
| ARPEGE Europe | 10 km | ~J+4 | relais au-delà d'AROME |
| ECMWF IFS | 9 km, puis 25 km | J+7 | tendance pour J+5 et J+6 |

Une requête de sonde sur un point détermine la chaîne réellement disponible pour la date choisie. Le modèle utilisé est affiché sur chaque fiche. L'altitude du déco est transmise à Open-Meteo pour qu'il choisisse une maille d'altitude voisine.

Variables analysées : vent moyen et rafales à 10 m, direction, précipitations, couverture nuageuse totale et basse, code météo WMO (orage, brouillard), CAPE (instabilité), vent à 850 hPa (~1 500 m).

## Algorithme de score

Les seuils sont dans [`js/config.js`](js/config.js), le calcul dans [`js/scoring.js`](js/scoring.js) (fonctions pures, testées).

**1. La météo est éliminatoire.** Chaque heure du créneau de vol (10h–18h par défaut) est jugée selon le niveau du pilote :

| Critère éliminatoire | Débutant | Pilote | Confirmé |
|---|---|---|---|
| Vent moyen | > 20 km/h | > 25 | > 30 |
| Rafales | > 25 km/h | > 32 | > 38 |
| Air turbulent : écart rafales − vent, quand les rafales dépassent 75 % de la limite | > 10 km/h | > 12 | > 15 |
| Vent à 850 hPa (~1 500 m) | > 30 km/h | > 40 | > 50 |
| Vent mal orienté (hors secteur favorable ±45°, sauf vent calme < 6 km/h) | ✗ | ✗ | ✗ |
| Pluie ≥ 0,2 mm/h, brouillard, déco (> 600 m) dans les nuages bas > 90 % | ✗ | ✗ | ✗ |

La journée n'est retenue que s'il existe **au moins 2 heures volables d'affilée** et **aucun orage** dans le créneau. Sinon le score tombe à **0** et le motif principal s'affiche (« Pluie (11h–16h, 3,2 mm) », « Vent mal orienté (SO pour un déco N-NE) »…).

**2. Qualité météo (0–100)** : chaque heure volable reçoit une note de confort (vent dans la plage idéale, rafales faibles, vent dans l'axe du déco, ciel partiellement nuageux, instabilité modérée, vent faible en altitude). Le meilleur créneau est celui qui maximise *note moyenne × bonus de durée* (0,85 pour 2 h, plein à partir de 4 h).

**3. Trajet (0–100)** : 75 % durée aller (100 à 1 h, 0 à 8 h) et 25 % coût aller-retour par personne (100 à 15 €, 0 à 200 €). Un spot à 2 h passe donc devant un spot à 7 h à météo égale.

- Voiture : durée et distance OSRM, carburant (6,5 L/100 km à 1,85 €/L), péages estimés, partage entre passagers.
- Train : gare la plus proche du déco, temps estimé (TGV au-delà de 180 km), puis taxi ou navette jusqu'au déco. Avec une clé SNCF, horaires réels pour les 8 meilleurs spots.

**4. Score global** = 60 % météo + 40 % trajet (curseur réglable). **Go** si score ≥ 65 *et* météo ≥ 60 *et* orientation connue. **Jouable** si score ≥ 40. **Passe ton chemin** sinon.

## Structure

```
index.html                     page unique
css/style.css                  thème clair / sombre, responsive
js/config.js                   seuils, pondérations, coûts, modèles, URL des API
js/geo.js                      distances, angles, secteurs de vent
js/scoring.js                  moteur de score (pur, testé)
js/weather.js                  Open-Meteo : sonde des modèles, paquets, quota, fusion
js/transport.js                communes, OSRM, coûts, train estimé, API SNCF
js/app.js                      formulaire, orchestration, liste, carte Leaflet, rose des vents
data/spots.json                décollages (généré)
scripts/build-spots.mjs        génération de data/spots.json (Node ≥ 20, sans dépendance)
tests/scoring.test.mjs         tests du moteur de score (node --test)
tests/weather.test.mjs         tests du module météo avec réponses Open-Meteo simulées
.github/workflows/pages.yml         tests + publication GitHub Pages
.github/workflows/update-spots.yml  mise à jour hebdomadaire des décollages
```

## Lancer en local

Il faut un petit serveur HTTP, parce que les modules ES ne se chargent pas en `file://` :

```bash
python3 -m http.server 8000
```

Puis ouvre <http://localhost:8000>. Tests (Node ≥ 20, 93 tests, sans réseau) :

```bash
npm test
```

Régénérer la liste des décollages (80 s au premier passage, ~10 s ensuite) :

```bash
node scripts/build-spots.mjs
```

## Mise en ligne sur GitHub Pages

1. **Crée le dépôt** sur GitHub (bouton *New repository*), par exemple `deco-radar`, en **public** (GitHub Pages gratuit l'exige). Ne coche ni README ni licence.
2. **Pousse le code** depuis ce dossier :
   ```bash
   git init -b main
   git add .
   git commit -m "Déco Radar"
   git remote add origin https://github.com/<ton-compte>/deco-radar.git
   git push -u origin main
   ```
3. **Active Pages** : *Settings → Pages → Build and deployment → Source : GitHub Actions*.
4. **Lance la publication** : onglet *Actions → Publication GitHub Pages → Run workflow*. Elle se relance ensuite seule à chaque push. Au bout d'une minute environ, le site est en ligne sur `https://<ton-compte>.github.io/deco-radar/`.
5. **(Facultatif) Données FFVL officielles** : demande une clé à informatique@ffvl.fr, puis ajoute-la dans *Settings → Secrets and variables → Actions → New repository secret*, nom `FFVL_API_KEY`. Lance *Actions → Mise à jour des décollages → Run workflow* : `data/spots.json` est reconstruit depuis la FFVL, commité, et le site se republie tout seul. Sans clé, la mise à jour du lundi repart de ParaglidingEarth.

Si la mise à jour hebdomadaire échoue au moment du push, vérifie *Settings → Actions → General → Workflow permissions : Read and write permissions*.

## Limites connues

- Quota Open-Meteo gratuit : 600 appels/min, 5 000/h et 10 000/jour par connexion. Une analyse par défaut (250 points, AROME HD + AROME) coûte environ 450 appels, soit une dizaine d'analyses nouvelles par heure. Les prévisions sont gardées 30 min en mémoire : changer de ville, de niveau ou de créneau ne les retélécharge pas.
- Le serveur OSRM de démonstration est gratuit mais sans garantie. S'il ne répond pas, l'appli bascule sur une estimation à vol d'oiseau et le signale.
- Les prix de train sont des estimations (tarif moyen au km, hors promotions et cartes). Seule l'API SNCF donne des horaires réels, et pas de prix.
- Le temps de trajet vise le décollage. Un déco qui se rejoint à pied (hike & fly) compte comme la route la plus proche.
- La couverture des orientations dépend de la source : un déco sans orientation connue ne peut pas être « Go », au mieux « Jouable ».
- Le parsing de l'API FFVL est défensif mais n'a pas pu être testé avec une vraie clé : les points incertains sont signalés dans `scripts/build-spots.mjs`.

## Licences des données

Météo : Open-Meteo (CC BY 4.0), modèles Météo-France et ECMWF. Décollages : ParaglidingEarth (CC BY-SA 3.0) ou FFVL. Gares : SNCF Open Data (ODbL). Itinéraires et fond de carte : © contributeurs OpenStreetMap (ODbL).
