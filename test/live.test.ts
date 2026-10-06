// Read-only calls against the real API, each answer checked against the
// response schema the spec documents. Runs only with SMTPFAST_API_KEY set
// (npm run test:live); a key with email:read and domain:read is enough.
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { SMTPfast } from "../src/index.js";

const key = process.env.SMTPFAST_API_KEY;
const spec = JSON.parse(readFileSync(new URL("../spec/openapi.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
createRequire(import.meta.url)("ajv-formats")(ajv);
ajv.addSchema({ $id: "spec", components: spec.components });

function check(operationId: string, body: unknown) {
  for (const item of Object.values(spec.paths as Record<string, Record<string, any>>)) {
    for (const op of Object.values(item)) {
      if (op?.operationId !== operationId) continue;
      const [, res] = Object.entries(op.responses).find(([code]) => code.startsWith("2")) as [string, any];
      const schema = JSON.parse(JSON.stringify(res.content["application/json"].schema).replaceAll('"#/components', '"spec#/components'));
      const validate = ajv.compile(schema);
      expect(validate(body), `${operationId}: ${ajv.errorsText(validate.errors)}`).toBe(true);
      return;
    }
  }
  throw new Error(`no operation ${operationId}`);
}

describe.skipIf(!key)("live API", () => {
  // Built only when the suite runs: describe bodies run during collection even when skipped.
  const client = key ? new SMTPfast({ apiKey: key, baseUrl: process.env.SMTPFAST_BASE_URL }) : (undefined as never);

  it("account.me", async () => check("getCapabilities", await client.account.me()));

  it("emails.list and emails.get", async () => {
    const list = await client.emails.list({ limit: 3 });
    check("listEmails", list);
    const first = list.data?.[0];
    if (first) check("getEmail", await client.emails.get(first.id));
  });

  it("domains.list and domains.get", async () => {
    const list = await client.domains.list();
    check("listDomains", list);
    const first = list[0];
    if (first) check("getDomain", await client.domains.get(first.id));
  });

  // Each of these needs a scope the key may not have; a 403 is not a schema problem.
  const optional: Array<[string, () => Promise<unknown>]> = [
    ["listLogs", () => client.logs.list({ limit: 3 })],
    ["getEmailMetrics", () => client.emails.getMetrics()],
    ["listClickedLinks", () => client.emails.listClickedLinks()],
    ["listReceivedEmails", () => client.emails.receiving.list({ limit: 3 })],
    ["getUsage", () => client.account.usage()],
    ["getAnalytics", () => client.analytics.get()],
  ];
  it.each(optional)("%s", async (operationId, call) => {
    let body: unknown;
    try {
      body = await call();
    } catch (err) {
      if ((err as { status?: number }).status === 403) return console.log(`${operationId}: 403 for this key, not checked`);
      throw err;
    }
    check(operationId, body);
  });
});
