// Download the published OpenAPI document into spec/openapi.json.
import { writeFile } from "node:fs/promises";

const url = process.env.SMTPFAST_SPEC_URL ?? "https://smtpfa.st/api/v1/openapi.json";
const res = await fetch(url);
if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
const spec = await res.json();
await writeFile(new URL("../spec/openapi.json", import.meta.url), JSON.stringify(spec, null, 2) + "\n");
console.log(`spec/openapi.json: ${Object.keys(spec.paths).length} paths from ${url}`);
