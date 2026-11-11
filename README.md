# Csavargó API

Fastify és TypeScript alapú REST backend a [Csavargó](https://github.com/MayerAttila/csavargo) alkalmazáshoz.

**M1:** egészségellenőrzés, Better Auth e-mailes hitelesítés, Prisma-migrációk és Zod-alapú OpenAPI-szerződés. Az utazásszervező üzleti funkciók még fejlesztés alatt állnak.

## Local setup
A szülő `csavargo` repositoryban:
```bash
docker compose up -d
```

Ebben a repositoryban:
```bash
pnpm install
cp .env.example .env
pnpm db:generate
pnpm db:deploy
pnpm dev
```

Health endpoint: http://localhost:3001/health

A `BETTER_AUTH_SECRET` legyen véletlen és legalább 32 karakter. A `BETTER_AUTH_URL` és `WEB_ORIGIN`
a frontend nyilvános originje (`http://localhost:3000`). A fejlesztői levelek a Mailpit postaládába kerülnek:
http://localhost:8025. Élesben HTTPS és Resend-konfiguráció szükséges.

Auth: `/api/auth/*`; hitelesített profil: `GET /api/me`; OpenAPI: `GET /api/openapi.json`.
A regisztráció azonnal beléptet, a megerősítés opcionális. Jelszó-visszaállítás után újra be kell lépni.
A `db:deploy` a korábbi `UserProfile` adatokat megőrzi és szükség esetén baseline-olja a scaffoldsémát.

## Ellenőrzés

`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`.
Az adatbázisos tesztekhez `AUTH_TEST_DATABASE_URL` kell, külön `_test` végű adatbázissal;
ennek hiányában csak az adatbázisfüggetlen tesztek futnak. Előbb alkalmazd a migrációkat erre az adatbázisra.
A migrációteszt adatbázis-létrehozási jogot igényel. A CI minden tesztet PostgreSQL 17-en futtat.

## Planned modules
Users, trips, itinerary, places, expenses, bookings, members and invitations.

## Contract strategy
`pnpm contract:export` exportálja a Fastify/Zod-sémákat a `contracts/openapi.v1.json` fájlba.
A web kliens ebből generálja a `/api/me` típusait. A Better Auth saját végpontjait a verzióazonos auth kliens kezeli.
