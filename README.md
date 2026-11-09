# Csavargó API

Fastify és TypeScript alapú REST backend a [Csavargó](https://github.com/MayerAttila/csavargo) alkalmazáshoz.

**M1 scaffold:** egészségellenőrző végpont (`GET /health`), kiinduló Prisma séma és teszt. Az üzleti endpointok, Better Auth és OpenAPI generálás még nincsenek implementálva.

## Local setup
A szomszédos `csavargo` repositoryban:
```bash
docker compose up -d
```

Ebben a repositoryban:
```bash
pnpm install
cp .env.example .env
pnpm dev
```

Health endpoint: http://localhost:3001/health

## Planned modules
Auth, users, trips, itinerary, places, expenses, bookings, members and invitations.

## Contract strategy
Fastify + Zod response/request sémákból verziózott OpenAPI készül, amelyet a web kliens típusgenerálásra használ. Ez a következő mérföldkő.
