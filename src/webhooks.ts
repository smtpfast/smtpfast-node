/**
 * Check that a webhook request came from SMTPfast. The X-SMTPfast-Signature
 * header is the hex HMAC-SHA256 of the raw request body, keyed with the
 * webhook's signing secret. Pass the body exactly as received, before any
 * JSON parsing. Uses Web Crypto, so it runs on Node, Bun, Deno and edge runtimes.
 */
export async function verifyWebhookSignature(input: {
  payload: string | Uint8Array;
  signature: string | null | undefined;
  secret: string;
}): Promise<boolean> {
  const { payload, signature, secret } = input;
  if (!signature || !secret) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const body = typeof payload === "string" ? enc.encode(payload) : payload;
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, body as BufferSource));
  const expected = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return timingSafeEqual(expected, signature.trim().toLowerCase());
}

/** A delivered webhook event, after its signature has been checked. */
export interface WebhookEvent<D = Record<string, unknown>> {
  type: string;
  data: D;
  timestamp?: string;
  [key: string]: unknown;
}

/** Verify the signature, then parse the body. Throws when the signature does not match. */
export async function parseWebhook<D = Record<string, unknown>>(input: {
  payload: string;
  headers: Headers | Record<string, string | string[] | undefined>;
  secret: string;
}): Promise<WebhookEvent<D>> {
  const signature = header(input.headers, "x-smtpfast-signature");
  if (!(await verifyWebhookSignature({ payload: input.payload, signature, secret: input.secret }))) {
    throw new Error("Webhook signature does not match");
  }
  return JSON.parse(input.payload) as WebhookEvent<D>;
}

function header(headers: Headers | Record<string, string | string[] | undefined>, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
  }
  return undefined;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
