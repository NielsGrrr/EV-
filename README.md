EV+ — setup initial

Backend (Node + TypeScript + Prisma)

1) Aller dans le dossier backend et installer dépendances:

```powershell
cd backend
npm install
```

2) Installer les dépendances de dev et initialiser Prisma (si non installées):

```powershell
npm install -D prisma typescript ts-node-dev @types/express @types/node
npx prisma init
```

3) Configurer la variable `DATABASE_URL` dans `backend/.env`.

> Si `DATABASE_URL` est invalide ou contient des identifiants incorrects, l'API renverra une erreur serveur 500.
> Vérifie également que la base de données est accessible et que l'utilisateur a les bons droits.

4) Générer le client Prisma et lancer la migration:

```powershell
cd backend
npx prisma generate
npx prisma migrate dev --name init
```

5) Lancer le serveur en dev:

```powershell
npm run dev
```

Variables de scraping Socket.IO :

- `WINAMAX_SOCKET_URL` : URL du serveur Socket.IO
- `WINAMAX_SOCKET_PATH` : chemin Socket.IO (souvent `/socket.io`)
- `WINAMAX_SOCKET_QUERY` : query string à envoyer au handshake
- `WINAMAX_SOCKET_ORIGIN` : header `Origin` requis par Winamax
- `WINAMAX_SOCKET_REFERER` : header `Referer` requis par Winamax
- `WINAMAX_JSON_URL` : endpoint HTTP JSON de repli, si nécessaire

Exemple :

```env
WINAMAX_SOCKET_URL="https://sports-eu-west-3.winamax.fr/uof-sports-server"
WINAMAX_SOCKET_PATH="/socket.io"
WINAMAX_SOCKET_QUERY="language=FR&version=3.55.2&embed=false"
WINAMAX_SOCKET_ORIGIN="https://www.winamax.fr"
WINAMAX_SOCKET_REFERER="https://www.winamax.fr/"
# WINAMAX_JSON_URL="https://example.com/winamax/json-endpoint"
```


Frontend (Vite + React)

1) Installer dépendances:

```powershell
cd frontend
npm install
```

2) Lancer le dev server:

```powershell
npm run dev
```

Notes:
- Remplace l'URL de scraping dans `backend/src/scraper.ts` par l'endpoint Winamax réel et adapte le parsing.
- Le cron est configuré toutes les 5 minutes dans `backend/src/server.ts`.
