export type SwaramErrorCode =
  | "AUTH"
  | "CONCURRENT_TURN"
  | "DUPLICATE_TOOL"
  | "EMPTY_INPUT"
  | "HTTP_ERROR"
  | "LLM_UNSUPPORTED"
  | "PROVIDER_FAILURE"
  | "RATE_LIMITED"
  | "STT_UNSUPPORTED"
  | "TIMEOUT"
  | "TTS_UNSUPPORTED"
  | "TURN_ABORTED"
  | "UNKNOWN_TOOL";

export type SwaramErrorOptions = {
  cause?: unknown;
  /** HTTP status code, when the error originated from an HTTP response. */
  status?: number;
};

export class SwaramError extends Error {
  readonly code: SwaramErrorCode;
  readonly cause?: unknown;
  /** HTTP status code, when the error originated from an HTTP response. */
  readonly status?: number;

  constructor(code: SwaramErrorCode, message: string, options: SwaramErrorOptions | Error = {}) {
    super(message);
    this.name = "SwaramError";
    this.code = code;

    // Accept either an options bag or, for back-compat, a raw Error cause.
    if (options instanceof Error) {
      this.cause = options;
      return;
    }

    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
    if (options.status !== undefined) {
      this.status = options.status;
    }
  }
}

/** Map an HTTP status code to the most specific SwaramError code. */
export function codeForStatus(status: number): SwaramErrorCode {
  if (status === 401 || status === 403) {
    return "AUTH";
  }
  if (status === 429) {
    return "RATE_LIMITED";
  }
  return "HTTP_ERROR";
}

export function toSwaramError(error: unknown, fallbackCode: SwaramErrorCode) {
  if (error instanceof SwaramError) {
    return error;
  }

  // A fetch/stream cancelled by an AbortController surfaces as an AbortError.
  // Classify it as TURN_ABORTED rather than the generic fallback so callers can
  // tell "the user barged in / we cancelled" apart from "the provider failed".
  if (error instanceof Error && error.name === "AbortError") {
    return new SwaramError("TURN_ABORTED", error.message || "The request was aborted.", { cause: error });
  }

  if (error instanceof Error) {
    return new SwaramError(fallbackCode, error.message, { cause: error });
  }

  return new SwaramError(fallbackCode, String(error), { cause: error });
}
