import { Core, type ClientOptions } from "./core.js";
import { createResources, type Resources } from "./resources.gen.js";

export interface SMTPfast extends Resources {}

/**
 * The SMTPfast API client.
 *
 * ```ts
 * const smtpfast = new SMTPfast(); // reads SMTPFAST_API_KEY
 * await smtpfast.emails.send({ from: "you@yourdomain.com", to: "them@example.org", subject: "Hi", text: "Hello" });
 * ```
 */
export class SMTPfast {
  constructor(options?: ClientOptions | string) {
    const core = new Core(typeof options === "string" ? { apiKey: options } : options);
    Object.assign(this, createResources(core));
  }
}

export default SMTPfast;
export type { ClientOptions, RequestOptions, ItemOf } from "./core.js";
export * from "./errors.js";
export { verifyWebhookSignature, parseWebhook, type WebhookEvent } from "./webhooks.js";
export type * from "./generated/types.gen.js";
export { VERSION } from "./version.js";
