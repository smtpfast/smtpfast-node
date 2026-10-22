import { createClient, type Client } from "./generated/client/index.js";
import { APIConnectionError, APIError, APITimeoutError, SMTPfastError } from "./errors.js";
import { VERSION } from "./version.js";

export interface ClientOptions {
  /** Defaults to the SMTPFAST_API_KEY environment variable. */
  apiKey?: string;
  /** Defaults to https://smtpfa.st/api. */
  baseUrl?: string;
  /** Retries after a rate limit, a 5xx answer or a dropped connection. Defaults to 2. */
  maxRetries?: number;
  /** Per attempt, in milliseconds. Defaults to 60000. */
  timeout?: number;
  /** Headers sent with every request. */
  headers?: Record<string, string>;
  /** A fetch implementation, for tests or unusual runtimes. */
  fetch?: typeof fetch;
}

export interface RequestOptions {
  /**
   * For sends, replies and forwards. A retry with the same key and body
   * returns the first answer instead of sending again. When it is not given
   * and retries are on, the SDK makes one per call.
   */
  idempotencyKey?: string;
  signal?: AbortSignal;
  headers?: Record<string, string>;
  maxRetries?: number;
  timeout?: number;
}

/** The success body of an operation, from its generated `...Responses` map. */
export type Result<R> = R[keyof R];

/** The item type of a list response: `{ data: Item[] }` gives `Item`. */
export type ItemOf<R> = R extends { data?: Array<infer I> | null } ? I : never;

// The functions in generated/sdk.gen.ts all take one options object.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SdkFn = (options: any) => Promise<any>;

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const SAFE_METHODS = new Set(["GET", "HEAD", "PUT", "DELETE", "OPTIONS"]);
const MAX_RETRY_AFTER_MS = 60_000;
/** Query parameters listAll sets or cannot combine with walking forward by `after`. */
export const PAGINATION_MANAGED = ["before", "page", "latest"] as const;

interface Attempt {
  maxRetries: number;
  timeout: number;
  /** The operation dedupes on Idempotency-Key and this call sends one. */
  idempotent: boolean;
}

export class Core {
  readonly client: Client;
  readonly #maxRetries: number;
  readonly #timeout: number;
  readonly #fetch: typeof fetch;

  constructor(options: ClientOptions = {}) {
    const apiKey = options.apiKey ?? readEnv("SMTPFAST_API_KEY");
    if (!apiKey) {
      throw new SMTPfastError("No API key: pass { apiKey } or set the SMTPFAST_API_KEY environment variable.");
    }
    this.#maxRetries = options.maxRetries ?? 2;
    this.#timeout = options.timeout ?? 60_000;
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.client = createClient({
      baseUrl: (options.baseUrl ?? "https://smtpfa.st/api").replace(/\/+$/, ""),
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "User-Agent": `smtpfast-node/${VERSION}`,
        ...options.headers,
      },
      fetch: ((input: RequestInfo | URL) =>
        this.#send(input as Request, { maxRetries: this.#maxRetries, timeout: this.#timeout, idempotent: false })) as typeof fetch,
    });
  }

  /** Make one API call and return the parsed body, or throw an APIError. */
  async call<R>(fn: SdkFn, args: object, options: RequestOptions = {}, idempotent = false): Promise<R> {
    checkPath((args as { path?: Record<string, unknown> }).path);
    const maxRetries = options.maxRetries ?? this.#maxRetries;
    const headers: Record<string, string> = { ...options.headers };
    if (idempotent) {
      const key = options.idempotencyKey ?? (maxRetries > 0 ? crypto.randomUUID() : undefined);
      if (key) headers["Idempotency-Key"] = key;
    }
    // hey-api takes a fetch per call, which carries this call's retry settings.
    const settings: Attempt = {
      maxRetries,
      timeout: options.timeout ?? this.#timeout,
      idempotent: idempotent && Boolean(headers["Idempotency-Key"]),
    };
    const fetch = (input: RequestInfo | URL) => this.#send(input as Request, settings);
    const result = await fn({ client: this.client, ...args, headers, signal: options.signal, fetch, throwOnError: false });
    if (result.error instanceof SMTPfastError) throw result.error;
    if (!result.response) throw new APIConnectionError(undefined, { cause: result.error });
    if (!result.response.ok) throw APIError.from(result.response.status, result.error, result.response.headers);
    if (result.error !== undefined) {
      if (options.signal?.aborted) throw options.signal.reason;
      throw new APIConnectionError("Could not read the response from the SMTPfast API", { cause: result.error });
    }
    return result.data as R;
  }

  /** Follow `has_more` with `after` = the id of the last item, yielding every item. */
  async *paginate<I>(fn: SdkFn, args: { path?: object; query?: object }, options?: RequestOptions): AsyncIterable<I> {
    let query = { ...(args.query ?? {}) } as Record<string, unknown>;
    for (const key of PAGINATION_MANAGED) delete query[key];
    for (;;) {
      const page = await this.call<{ data?: I[] | null; has_more?: boolean }>(fn, { ...args, query }, options);
      const items = page.data ?? [];
      for (const item of items) yield item;
      const last = items[items.length - 1] as { id?: string } | undefined;
      if (!page.has_more || !last?.id) return;
      query = { ...query, after: last.id };
    }
  }

  async #send(request: Request, settings: Attempt): Promise<Response> {
    const retryable = SAFE_METHODS.has(request.method) || settings.idempotent;
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(settings.timeout);
      let response: Response;
      try {
        response = await this.#fetch(request.clone(), { signal: AbortSignal.any([request.signal, timeout]) });
      } catch (err) {
        if (request.signal.aborted) throw err;
        const error = timeout.aborted ? new APITimeoutError(settings.timeout) : new APIConnectionError(undefined, { cause: err });
        if (!retryable || attempt >= settings.maxRetries) throw error;
        await sleep(backoff(attempt), request.signal);
        continue;
      }
      const wait = retryDelay(response, attempt, retryable);
      if (wait === null || attempt >= settings.maxRetries) return response;
      await response.body?.cancel();
      await sleep(wait, request.signal);
    }
  }
}

/** How long to wait before retrying this response, or null for no retry. */
// An id of "", "." or ".." would become a dot-segment that the URL parser
// resolves, so the request would reach a different endpoint.
function checkPath(path: Record<string, unknown> | undefined): void {
  for (const [name, value] of Object.entries(path ?? {})) {
    const text = typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? String(value) : null;
    if (text === null || text === "" || text === "." || text === "..") {
      throw new SMTPfastError(`Invalid path parameter ${name}: ${JSON.stringify(value) ?? String(value)}`);
    }
  }
}

function retryDelay(response: Response, attempt: number, retryable: boolean): number | null {
  if (!RETRY_STATUS.has(response.status)) return null;
  const header = response.headers.get("Retry-After");
  let after: number | null = null;
  if (header) {
    const seconds = Number(header);
    after = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (!(after >= 0)) after = null;
  }
  if (response.status === 429) {
    // A per-second limit sends Retry-After and rejects before any work is done,
    // so any method may retry. Without the header (an hourly or daily limit),
    // retrying soon cannot succeed.
    if (after === null || after > MAX_RETRY_AFTER_MS) return null;
    return after;
  }
  if (!retryable) return null;
  if (after !== null) return after <= MAX_RETRY_AFTER_MS ? after : null;
  return backoff(attempt);
}

function backoff(attempt: number): number {
  const base = Math.min(500 * 2 ** attempt, 8000);
  return base * (0.75 + Math.random() * 0.5);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function readEnv(name: string): string | undefined {
  return typeof process !== "undefined" ? process.env?.[name]?.trim() || undefined : undefined;
}
