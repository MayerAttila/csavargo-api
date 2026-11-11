import { mkdir, writeFile } from "node:fs/promises";
import { buildApp } from "../src/app.js";

const app = await buildApp();
await app.ready();
await mkdir("contracts", { recursive: true });
await writeFile("contracts/openapi.v1.json", `${JSON.stringify(app.swagger(), null, 2)}\n`);
await app.close();
