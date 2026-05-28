export type SwaramErrorCode =
  | "CONCURRENT_TURN"
  | "DUPLICATE_TOOL"
  | "EMPTY_INPUT"
  | "PROVIDER_FAILURE"
  | "STT_UNSUPPORTED"
  | "TTS_UNSUPPORTED"
  | "TURN_ABORTED"
  | "UNKNOWN_TOOL";

export class SwaramError extends Error {
  constructor(
    readonly code: SwaramErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SwaramError";
  }
}

export function toSwaramError(error: unknown, fallbackCode: SwaramErrorCode) {
  if (error instanceof SwaramError) {
    return error;
  }

  if (error instanceof Error) {
    return new SwaramError(fallbackCode, error.message, error);
  }

  return new SwaramError(fallbackCode, String(error), error);
}
