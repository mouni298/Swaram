import type { Unsubscribe } from "../types.js";

export class TypedEventEmitter<TEventMap> {
  private handlers = new Map<keyof TEventMap, Set<(payload: never) => void>>();

  on<TEvent extends keyof TEventMap>(event: TEvent, handler: (payload: TEventMap[TEvent]) => void): Unsubscribe {
    const handlers = this.handlers.get(event) ?? new Set<(payload: never) => void>();
    handlers.add(handler as (payload: never) => void);
    this.handlers.set(event, handlers);

    return () => {
      handlers.delete(handler as (payload: never) => void);
    };
  }

  emit<TEvent extends keyof TEventMap>(event: TEvent, payload: TEventMap[TEvent]) {
    const handlers = this.handlers.get(event);
    if (!handlers) {
      return;
    }

    for (const handler of handlers) {
      (handler as (payload: TEventMap[TEvent]) => void)(payload);
    }
  }

  clear() {
    this.handlers.clear();
  }
}
