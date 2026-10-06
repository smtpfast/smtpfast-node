/** Every error the SDK throws is an SMTPfastError. */
export class SMTPfastError extends Error {
  override name = "SMTPfastError";
}

/** The API answered with a status outside 2xx. */
export class APIError extends SMTPfastError {
  override name = "APIError";
  /** The HTTP status code. */
  readonly status: number;
  /** The parsed JSON body, or the raw text when the body is not JSON. */
  readonly body: unknown;
  readonly headers: Headers;

  constructor(status: number, body: unknown, headers: Headers) {
    super(messageFrom(status, body));
    this.status = status;
    this.body = body;
    this.headers = headers;
  }

  static from(status: number, body: unknown, headers: Headers): APIError {
    const Kind =
      status === 400 ? BadRequestError
      : status === 401 ? AuthenticationError
      : status === 403 ? PermissionDeniedError
      : status === 404 ? NotFoundError
      : status === 409 ? ConflictError
      : status === 422 ? UnprocessableEntityError
      : status === 429 ? RateLimitError
      : status >= 500 ? InternalServerError
      : APIError;
    return new Kind(status, body, headers);
  }
}

export class BadRequestError extends APIError { override name = "BadRequestError"; }
export class AuthenticationError extends APIError { override name = "AuthenticationError"; }
export class PermissionDeniedError extends APIError { override name = "PermissionDeniedError"; }
export class NotFoundError extends APIError { override name = "NotFoundError"; }
export class ConflictError extends APIError { override name = "ConflictError"; }
export class UnprocessableEntityError extends APIError { override name = "UnprocessableEntityError"; }
export class RateLimitError extends APIError { override name = "RateLimitError"; }
export class InternalServerError extends APIError { override name = "InternalServerError"; }

/** The request did not get an answer: DNS, TLS, a reset connection. */
export class APIConnectionError extends SMTPfastError {
  override name = "APIConnectionError";
  constructor(message = "Could not connect to the SMTPfast API", options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** No answer arrived within the timeout. */
export class APITimeoutError extends APIConnectionError {
  override name = "APITimeoutError";
  constructor(timeoutMs: number) {
    super(`The SMTPfast API did not answer within ${timeoutMs} ms`);
  }
}

function messageFrom(status: number, body: unknown): string {
  if (body && typeof body === "object" && typeof (body as { error?: unknown }).error === "string") {
    return `${status}: ${(body as { error: string }).error}`;
  }
  if (typeof body === "string" && body.trim()) return `${status}: ${body.trim().slice(0, 300)}`;
  return `${status}: the SMTPfast API answered with an error`;
}
