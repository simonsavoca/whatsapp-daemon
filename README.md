# whatsapp-daemon

Daemon Node.js qui se connecte à WhatsApp via [Baileys](https://github.com/WhiskeySockets/Baileys) (session persistante, appairée par scan de QR code une seule fois) et expose une API HTTP locale pour lire l'historique, envoyer des messages, rejoindre des groupes et gérer la session. Un petit dashboard web en lecture seule est aussi servi par le daemon.

## Prérequis

- Node.js 24+
- [PM2](https://pm2.keymetrics.io/) (optionnel, recommandé pour un fonctionnement en arrière-plan)

## Installation

```bash
npm install
```

`better-sqlite3` est un module natif : `npm install` récupère/compile le binaire adapté à votre plateforme.

## Démarrage

Avec PM2 (process nommé `whatsapp-daemon`) :

```bash
pm2 start ecosystem.config.js
```

Ou directement :

```bash
npm start
```

## Première connexion

Au premier démarrage, un QR code s'affiche dans le terminal — à scanner depuis WhatsApp mobile (Appareils liés). Il peut aussi être récupéré via le dashboard à l'adresse `http://127.0.0.1:3099/`. La session est ensuite persistée dans `data/whatsapp_auth/` et réutilisée aux démarrages suivants.

## Stockage

- `data/whatsapp.db` — base SQLite (messages, chats), source de vérité.
- `data/whatsapp_auth/` — état de session Baileys (credentials de connexion). **Ne jamais committer ce dossier** : sa perte oblige à rescanner un QR code et à re-appairer l'appareil.

## API HTTP

Le serveur écoute en local uniquement sur `127.0.0.1:3099`. C'est le seul point d'accès aux données/actions — aucun autre process ne doit lire ou écrire directement `whatsapp.db`.

| Méthode | Route | Rôle |
|---|---|---|
| GET | `/messages/recent?limit&filter` | Derniers messages (filtrables par chat/texte) |
| GET | `/messages/unread` | Messages non lus |
| POST | `/messages/read` | Marquer des messages comme lus (`ids` ou `upTo`) |
| POST | `/send` | Envoyer un message (`query` = nom de contact/groupe, `message`) |
| POST | `/join-group` | Rejoindre un groupe via un lien d'invitation (`inviteLink`) |
| POST | `/chat/archive` | Archiver/désarchiver une conversation (`query` = nom ou jid, `archive` = bool, défaut true) |
| GET | `/auth/status` | État de connexion, compte, nombre de messages en base |
| GET | `/auth/qr` | Dernier QR code généré (PNG en data URL) |
| POST | `/auth/reset` | Supprimer la session en cours et relancer un nouveau pairing |
| GET | `/db/chats?filter` | Liste des chats connus (utilisé par le dashboard) |
| GET | `/db/messages?limit&offset&filter` | Messages paginés (utilisé par le dashboard) |
| GET | `/` | Dashboard web en lecture seule |

`/send`, `/join-group`, `/chat/archive` et `/messages/read` renvoient `401 { error: 'whatsapp_logged_out' }` (à distinguer de `401 { error: 'unauthorized' }` pour un token API invalide) quand la session WhatsApp a été révoquée côté téléphone — il faut alors passer par `/auth/reset` pour re-appairer.

Dans les réponses `messages` (`/messages/recent`, `/messages/unread`, `/db/messages`), les mentions brutes `@<numéro>` sont résolues en `@<nom du contact>` à la volée via la table `chats` (le texte stocké en base reste inchangé). Un numéro inconnu est laissé tel quel.

## Tests

```bash
npm run lint   # eslint
npm test       # tests unitaires (node --test)
```

La CI GitHub Actions (`.github/workflows/ci.yml`) exécute lint + tests sur chaque push et pull request.
