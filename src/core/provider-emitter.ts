import type { Unsubscribe } from "../types.js";

/**
 * Small event-emitter base shared by the streaming providers (STT/TTS), which
 * all emit a fixed set of named events carrying a single payload union. Replaces
 * the hand-rolled `Set` maps each provider used to duplicate.
 */
export class ProviderEmitter<TEvent extends string, TPayload> {
  private readonly handlers: Record<TEvent, Set<(payload: TPayload) => void>>;

  constructor(events: readonly TEvent[]) {
    this.handlers = Object.fromEntries(events.map((event) => [event, new Set()])) as Record<
      TEvent,
      Set<(payload: TPayload) => void>
    >;
  }

  on(event: TEvent, handler: (payload: TPayload) => void): Unsubscribe {
    this.handlers[event].add(handler);
    return () => {
      this.handlers[event].delete(handler);
    };
  }

  protected emit(event: TEvent, payload: TPayload): void {
    for (const handler of this.handlers[event]) {
      handler(payload);
    }
  }
}
