import { SwaramError, codeForStatus } from "./errors.js";

export type HttpRequestOptions = {
  /** Abort signal from the caller (e.g. the agent's turn controller). */
  signal?: AbortSignal | undefined;
  /**
   * Max time to wait for response *headers* before aborting. Once headers
   * arrive the timer is cleared, so a long-lived streaming body is not cut off.
   * Defaults to 30s. Pass 0 to disable.
   */
  timeoutMs?: number;
  /** Retries for the initial connection on network errors / retryable statuses. Default 2. */
  maxRetries?: number;
  /** Base backoff in ms; doubles each attempt. Default 250. */
  backoffMs?: number;
  fetchImpl?: typeof fetch | undefined;
};

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 2;
const DEFAULT_BACKOFF_MS = 250;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SwaramError("TURN_ABORTED", "The request was aborted."));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SwaramError("TURN_ABORTED", "The request was aborted."));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * fetch() with a connect timeout, the caller's abort signal, and retries on
 * transient failures. Returns the Response without inspecting status — callers
 * use {@link throwForStatus} so they can read provider-specific error bodies.
 *
 * The timeout is applied only up to response headers (when fetch resolves);
 * the streaming body keeps reading on the caller's signal afterwards.
 */
export async function connectFetch(
  url: string,
  init: RequestInit,
  options: HttpRequestOptions = {},
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_RETRIES;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (options.signal?.aborted) {
      throw new SwaramError("TURN_ABORTED", "The request was aborted.");
    }

    const controller = new AbortController();
    const linkAbort = () => controller.abort();
    options.signal?.addEventListener("abort", linkAbort, { once: true });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timer = setTimeout(() => controller.abort(new Error("Request timed out waiting for response.")), timeoutMs);
    }

    try {
      const response = await fetchImpl(url, { ...init, signal: controller.signal });
      // Headers received: stop the connect timer, but keep the caller's abort
      // linked so the body stream can still be cancelled (barge-in).
      if (timer) {
        clearTimeout(timer);
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < maxRetries) {
        await response.body?.cancel().catch(() => {});
        lastError = new SwaramError(codeForStatus(response.status), `Request failed with status ${response.status}.`, {
          status: response.status,
        });
        await sleep(backoffMs * 2 ** attempt, options.signal);
        continue;
      }

      return response;
    } catch (error) {
      if (timer) {
        clearTimeout(timer);
      }

      // Caller-initiated abort: surface immediately, never retry.
      if (options.signal?.aborted) {
        throw new SwaramError("TURN_ABORTED", "The request was aborted.", { cause: error });
      }

      // Our own connect-timeout abort.
      if (isAbortError(error)) {
        lastError = new SwaramError("TIMEOUT", `Request to ${url} timed out after ${timeoutMs}ms.`, { cause: error });
      } else {
        lastError = new SwaramError("PROVIDER_FAILURE", error instanceof Error ? error.message : String(error), {
          cause: error,
        });
      }

      if (attempt < maxRetries) {
        await sleep(backoffMs * 2 ** attempt, options.signal);
        continue;
      }
    }
  }

  throw lastError instanceof SwaramError
    ? lastError
    : new SwaramError("PROVIDER_FAILURE", "Request failed.", { cause: lastError });
}

/**
 * Throw a typed {@link SwaramError} for a non-OK response, including the status
 * code and any error body the provider returned. No-op for OK responses.
 */
export async function throwForStatus(response: Response, label: string): Promise<void> {
  if (response.ok) {
    return;
  }

  const detail = await response.text().catch(() => "");
  const suffix = detail ? ` ${detail}` : "";
  throw new SwaramError(
    codeForStatus(response.status),
    `${label} failed with status ${response.status}.${suffix}`.trim(),
    { status: response.status },
  );
}
