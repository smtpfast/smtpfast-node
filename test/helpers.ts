import { SMTPfast, type ClientOptions } from "../src/index.js";

export interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

type Reply = Response | Error | ((call: Call) => Response | Promise<Response>);

/** A client whose fetch answers from a queue of replies and records every request. */
export function mockClient(replies: Reply[] = [], options: ClientOptions = {}) {
  const calls: Call[] = [];
  const queue = [...replies];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input as Request, init);
    const text = await request.text();
    const call: Call = {
      method: request.method,
      url: new URL(request.url),
      headers: request.headers,
      body: text ? JSON.parse(text) : undefined,
    };
    calls.push(call);
    const next = queue.shift() ?? json({ ok: true });
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(call) : next;
  };
  const client = new SMTPfast({ apiKey: "sf_test_key", fetch: fetch as typeof globalThis.fetch, ...options });
  return { client, calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}
