# SMTPfast Node.js SDK

The official TypeScript and JavaScript SDK for the [SMTPfast](https://smtpfa.st) API. It covers every endpoint in the API, has full types, and has no runtime dependencies. It runs on Node.js 22+, Bun, Deno and edge runtimes.

```bash
npm install @smtpfast/sdk
```

## Send an email

```ts
import { SMTPfast } from "@smtpfast/sdk";

const smtpfast = new SMTPfast(); // reads SMTPFAST_API_KEY

const email = await smtpfast.emails.send({
  from: "Acme <hello@yourdomain.com>",
  to: ["customer@example.org"],
  subject: "Your receipt",
  html: "<p>Thanks for your order.</p>",
});
console.log(email.id);
```

Every API operation is a method, named after its path: `smtpfast.domains.verify(id)`, `smtpfast.contacts.segments.add(contactId, segmentId)`, `smtpfast.inboxes.threads.emails.reply(inboxId, threadId, emailId, body)`. Path parameters come first, then the request body or the query, then options.

## Options

```ts
const smtpfast = new SMTPfast({
  apiKey: "sf_...",          // default: process.env.SMTPFAST_API_KEY
  baseUrl: "https://smtpfa.st/api",
  maxRetries: 2,              // after 429 (with Retry-After), 408, 5xx and dropped connections
  timeout: 60_000,            // per attempt, in ms
});

// Per call:
await smtpfast.emails.send(body, { idempotencyKey: "order-1234", timeout: 10_000, signal });
```

## Retries and idempotency

Reads, `PUT` and `DELETE` are retried after a 5xx answer or a dropped connection. A send, reply or forward is retried with the same `Idempotency-Key`, so the API returns the first answer instead of sending twice. When you do not give a key, the SDK makes one per call. Other `POST` and `PATCH` calls are retried only after a per-second rate limit, which the API rejects before doing any work.

## Errors

Every error is an `SMTPfastError`. An answer outside 2xx throws an `APIError` with `status`, `body` and `headers`, as one of `BadRequestError`, `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `ConflictError`, `UnprocessableEntityError`, `RateLimitError` or `InternalServerError`. No answer at all throws `APIConnectionError` or `APITimeoutError`.

```ts
import { NotFoundError } from "@smtpfast/sdk";

try {
  await smtpfast.emails.get("em_missing");
} catch (err) {
  if (err instanceof NotFoundError) console.log(err.status, err.body);
  else throw err;
}
```

## Pagination

Lists that page with a cursor also have an `...All` method that fetches the next pages as you iterate:

```ts
for await (const email of smtpfast.emails.listAll({ limit: 100 })) {
  console.log(email.id, email.status);
}
```

## Webhooks

```ts
import { parseWebhook } from "@smtpfast/sdk";

// The raw body, before any JSON parsing.
const event = await parseWebhook({ payload: rawBody, headers: request.headers, secret: process.env.SMTPFAST_WEBHOOK_SECRET! });
if (event.type === "email.bounced") { /* ... */ }
```

`verifyWebhookSignature({ payload, signature, secret })` returns a boolean if you only need the check.

## How this SDK is made

The SDK is generated from the [OpenAPI document](https://smtpfa.st/api/v1/openapi.json), so it follows the API without hand edits:

- `src/generated/` holds the typed request functions, made by [@hey-api/openapi-ts](https://heyapi.dev).
- `src/resources.gen.ts` holds the `smtpfast.emails.send()` layer, made by `scripts/generate.mjs` from the `x-sdk-group` and `x-sdk-method` names the spec gives every operation. The SDKs for other languages use the same names.
- `src/core.ts`, `src/errors.ts` and `src/webhooks.ts` are written by hand: retries, errors, pagination and signature checks.

```bash
npm run spec:pull   # download the published spec into spec/openapi.json
npm run generate    # regenerate src/generated and src/resources.gen.ts
npm test            # unit tests, including one call per operation
SMTPFAST_API_KEY=sf_... npm run test:live   # read-only calls, checked against the spec
```

A daily workflow pulls the spec and opens a pull request when it changed.

## License

MIT
