import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  NotFoundError,
  RateLimitError,
  SMTPfast,
  SMTPfastError,
  parseWebhook,
  verifyWebhookSignature,
} from "../src/index.js";
import { json, mockClient } from "./helpers.js";

describe("requests", () => {
  it("sends an email with the key, a user agent and a JSON body", async () => {
    const { client, calls } = mockClient([json({ id: "em_1", object: "email" })]);
    const sent = await client.emails.send({ from: "a@yourapp.dev", to: ["b@inbox.dev"], subject: "Hi", text: "Hello" });
    expect(sent).toEqual({ id: "em_1", object: "email" });
    const [call] = calls;
    expect(call.method).toBe("POST");
    expect(call.url.href).toBe("https://smtpfa.st/api/v1/emails");
    expect(call.headers.get("authorization")).toBe("Bearer sf_test_key");
    expect(call.headers.get("user-agent")).toMatch(/^smtpfast-node\/\d/);
    expect(call.headers.get("content-type")).toContain("application/json");
    expect(call.body).toEqual({ from: "a@yourapp.dev", to: ["b@inbox.dev"], subject: "Hi", text: "Hello" });
  });

  it("fills path parameters in order and encodes them", async () => {
    const { client, calls } = mockClient([json({})]);
    await client.inboxes.threads.emails.reply("in 1", "th_2", "em/3", { text: "Thanks" });
    expect(calls[0].url.pathname).toBe("/api/v1/inboxes/in%201/threads/th_2/emails/em%2F3/reply");
  });

  it("sends query parameters", async () => {
    const { client, calls } = mockClient([json({ data: [], has_more: false })]);
    await client.emails.list({ limit: 5, after: "em_9" });
    expect(calls[0].method).toBe("GET");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ limit: "5", after: "em_9" });
  });

  it("uses a custom base URL and reads the key from the environment", async () => {
    process.env.SMTPFAST_API_KEY = "sf_env_key";
    const calls: Request[] = [];
    const client = new SMTPfast({
      baseUrl: "http://localhost:3000/api/",
      fetch: (async (input: Request) => {
        calls.push(input);
        return json({ data: [] });
      }) as typeof fetch,
    });
    await client.domains.list();
    delete process.env.SMTPFAST_API_KEY;
    expect(calls[0].url).toBe("http://localhost:3000/api/v1/domains");
    expect(calls[0].headers.get("authorization")).toBe("Bearer sf_env_key");
  });

  it("refuses to start without a key", () => {
    delete process.env.SMTPFAST_API_KEY;
    expect(() => new SMTPfast()).toThrow(SMTPfastError);
  });
});

describe("errors", () => {
  it("throws a typed error with the API's message, status and body", async () => {
    const { client } = mockClient([json({ error: "Invalid API key" }, 401)]);
    const err = await client.domains.list().catch((e) => e);
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(err).toBeInstanceOf(SMTPfastError);
    expect(err.status).toBe(401);
    expect(err.message).toBe("401: Invalid API key");
    expect(err.body).toEqual({ error: "Invalid API key" });
  });

  it("keeps extra fields of the error body", async () => {
    const body = { error: "Missing template variables", missing_variables: ["NAME"] };
    const { client } = mockClient([json(body, 422)]);
    const err = await client.emails.send({ from: "a@yourapp.dev", to: "b@inbox.dev", template: { id: "t" } }).catch((e) => e);
    expect(err.status).toBe(422);
    expect(err.body).toEqual(body);
  });

  it("maps 404 to NotFoundError", async () => {
    const { client } = mockClient([json({ error: "Email not found" }, 404)]);
    await expect(client.emails.get("em_x")).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("retries", () => {
  const noWait = { "Retry-After": "0" };

  it("retries a GET after a 503", async () => {
    const { client, calls } = mockClient([json({ error: "busy" }, 503, noWait), json({ data: [] })]);
    await expect(client.domains.list()).resolves.toEqual({ data: [] });
    expect(calls).toHaveLength(2);
  });

  it("retries a send after a 500 with the same Idempotency-Key", async () => {
    const { client, calls } = mockClient([json({ error: "oops" }, 500, noWait), json({ id: "em_1" })]);
    await client.emails.send({ from: "a@yourapp.dev", to: "b@inbox.dev", subject: "s", text: "t" });
    expect(calls).toHaveLength(2);
    const key = calls[0].headers.get("idempotency-key");
    expect(key).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[1].headers.get("idempotency-key")).toBe(key);
  });

  it("uses the caller's Idempotency-Key", async () => {
    const { client, calls } = mockClient([json({ id: "em_1" })]);
    await client.emails.send({ from: "a@yourapp.dev", to: "b@inbox.dev", subject: "s", text: "t" }, { idempotencyKey: "order-42" });
    expect(calls[0].headers.get("idempotency-key")).toBe("order-42");
  });

  it("does not retry a POST without an Idempotency-Key after a 500", async () => {
    const { client, calls } = mockClient([json({ error: "oops" }, 500, noWait)]);
    await expect(client.contacts.create({ email: "b@inbox.dev" })).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(1);
  });

  it("retries any method after a per-second 429 with Retry-After", async () => {
    const { client, calls } = mockClient([json({ error: "Rate limit exceeded" }, 429, noWait), json({ id: "ct_1" })]);
    await expect(client.contacts.create({ email: "b@inbox.dev" })).resolves.toEqual({ id: "ct_1" });
    expect(calls).toHaveLength(2);
  });

  it("does not retry a 429 without Retry-After, such as the hourly limit", async () => {
    const { client, calls } = mockClient([json({ error: "Hourly sending limit reached" }, 429)]);
    await expect(client.domains.list()).rejects.toBeInstanceOf(RateLimitError);
    expect(calls).toHaveLength(1);
  });

  it("stops after maxRetries", async () => {
    const busy = () => json({ error: "busy" }, 503, noWait);
    const { client, calls } = mockClient([busy, busy, busy, busy], { maxRetries: 2 });
    await expect(client.domains.list()).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(3);
  });

  it("takes maxRetries and timeout per call", async () => {
    const busy = () => json({ error: "busy" }, 503, noWait);
    const { client, calls } = mockClient([busy, busy, busy]);
    await expect(client.domains.list({ maxRetries: 0 })).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);

    const slow = mockClient([], {
      fetch: ((_: Request, init: RequestInit) =>
        new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch,
    });
    await expect(slow.client.domains.list({ maxRetries: 0, timeout: 20 })).rejects.toBeInstanceOf(APITimeoutError);
  });

    it("retries a dropped connection, then throws APIConnectionError", async () => {
    const drop = new TypeError("fetch failed");
    const { client, calls } = mockClient([drop, drop], { maxRetries: 1 });
    await expect(client.domains.list()).rejects.toBeInstanceOf(APIConnectionError);
    expect(calls).toHaveLength(2);
  });

  it("times out an attempt", async () => {
    const { client } = mockClient([], {
      maxRetries: 0,
      timeout: 20,
      fetch: ((_: Request, init: RequestInit) =>
        new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)))) as typeof fetch,
    });
    await expect(client.domains.list()).rejects.toBeInstanceOf(APITimeoutError);
  });

  it("stops at once when the caller aborts", async () => {
    const controller = new AbortController();
    const { client, calls } = mockClient([
      () => {
        controller.abort();
        return json({ error: "busy" }, 503, { "Retry-After": "1" });
      },
    ]);
    await expect(client.domains.list({ signal: controller.signal })).rejects.toBeDefined();
    expect(calls).toHaveLength(1);
  });
});

describe("pagination", () => {
  it("follows has_more with the last id", async () => {
    const { client, calls } = mockClient([
      json({ object: "list", data: [{ id: "a" }, { id: "b" }], has_more: true }),
      json({ object: "list", data: [{ id: "c" }], has_more: false }),
    ]);
    const ids: string[] = [];
    for await (const item of client.logs.listAll({ limit: 2 })) ids.push((item as { id: string }).id);
    expect(ids).toEqual(["a", "b", "c"]);
    expect(calls[0].url.searchParams.get("after")).toBeNull();
    expect(calls[1].url.searchParams.get("after")).toBe("b");
    expect(calls[1].url.searchParams.get("limit")).toBe("2");
  });

  it("passes path parameters on every page", async () => {
    const { client, calls } = mockClient([
      json({ data: [{ id: "t1" }], has_more: true }),
      json({ data: [], has_more: false }),
    ]);
    for await (const _ of client.inboxes.threads.listAll("in_1")) void _;
    expect(calls.map((c) => c.url.pathname)).toEqual(["/api/v1/inboxes/in_1/threads", "/api/v1/inboxes/in_1/threads"]);
  });
});

describe("webhooks", () => {
  const secret = "whsec_test";
  const payload = JSON.stringify({ type: "email.delivered", data: { id: "em_1" }, timestamp: "2026-10-07T00:00:00Z" });
  const signature = createHmac("sha256", secret).update(payload).digest("hex");

  it("accepts the SMTPfast signature and rejects anything else", async () => {
    expect(await verifyWebhookSignature({ payload, signature, secret })).toBe(true);
    expect(await verifyWebhookSignature({ payload: payload + " ", signature, secret })).toBe(false);
    expect(await verifyWebhookSignature({ payload, signature, secret: "other" })).toBe(false);
    expect(await verifyWebhookSignature({ payload, signature: undefined, secret })).toBe(false);
  });

  it("parses a verified event and refuses a forged one", async () => {
    const event = await parseWebhook({ payload, headers: { "X-SMTPfast-Signature": signature }, secret });
    expect(event.type).toBe("email.delivered");
    await expect(parseWebhook({ payload, headers: new Headers({ "x-smtpfast-signature": "00" }), secret })).rejects.toThrow();
  });
});

describe("review fixes", () => {
  const noWait = { "Retry-After": "0" };

  it("does not retry a POST because a custom header carries an Idempotency-Key", async () => {
    const { client, calls } = mockClient([json({ error: "oops" }, 500, noWait)], { headers: { "Idempotency-Key": "x" } });
    await expect(client.broadcasts.sendTest("bc_1", { to: "me@inbox.dev" })).rejects.toMatchObject({ status: 500 });
    expect(calls).toHaveLength(1);
  });

  it("does not retry when Retry-After is longer than a minute", async () => {
    const { client, calls } = mockClient([json({ error: "down" }, 503, { "Retry-After": "120" })]);
    await expect(client.domains.list()).rejects.toMatchObject({ status: 503 });
    expect(calls).toHaveLength(1);
  });

  it("throws when a 200 body cannot be parsed", async () => {
    const { client } = mockClient([new Response("{not json", { status: 200, headers: { "Content-Type": "application/json" } })]);
    await expect(client.domains.list()).rejects.toBeInstanceOf(APIConnectionError);
  });

  it("listAll drops before and page, which cannot combine with after", async () => {
    const { client, calls } = mockClient([json({ data: [{ id: "a" }], has_more: true }), json({ data: [], has_more: false })]);
    // @ts-expect-error before is not part of listAll's query
    for await (const _ of client.templates.listAll({ before: "t_9", limit: 1 })) void _;
    expect(calls.map((c) => [c.url.searchParams.get("before"), c.url.searchParams.get("after")])).toEqual([
      [null, null],
      [null, "a"],
    ]);
  });
});
