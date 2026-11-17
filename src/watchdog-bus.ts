/**
 * The watchdog's action bus (design-arch §1.7): a synchronous, in-process channel that replaces
 * the two reverse callbacks the watchdog used to call through `ctx` (`requestReattach` /
 * `repairTunnel`).
 *
 * Why a bus and not a callback or a returned effect: the detectors are `setInterval`/`setTimeout`
 * callbacks with no return-value receiver, so an effect has no owner to return to, and watching
 * the runtime from above would turn a state field into a channel (one tick late). The bus keeps
 * "who noticed" (the liveness code in `watchdog.ts`) apart from "who acts" (`connect/watchdog.ts`,
 * its only subscriber) without making either import the other.
 *
 * It is deliberately *not* `src/events.ts`: the P4 SSE server owns that name, and this bus never
 * touches the wire. It is also not a general event emitter — one event family, one subscriber,
 * publish is synchronous and a listener that throws is reported and skipped, exactly like the
 * `remote-unreachable` emitter protection it replaces.
 */
import type { WatchdogEvent } from './runtime/events.js'

/**
 * One action request, addressed to one host.
 *
 * `hostId` (and the `remote-unreachable` payload it mirrors: `source`, `reason`/`failures`) is
 * what lets a single subscriber resolve the runtime; the FSM-level `WatchdogEvent` in
 * `runtime/events.ts` is the same request before the host is known.
 */
export type WatchdogBusEvent = WatchdogEvent & { hostId: string }

/** The bus: publish in registration order, subscribe once. */
export interface WatchdogBus {
  publish(event: WatchdogBusEvent): void
  /** @returns the unsubscribe function (idempotent). */
  subscribe(listener: (event: WatchdogBusEvent) => void): () => void
}

/** Where a listener failure goes; the service passes its own logger. */
export interface WatchdogBusOptions {
  warn?: (...args: unknown[]) => void
}

/**
 * Create the one bus a service instance owns.
 * @param options - only the warn sink for a listener that throws.
 * @returns the bus.
 */
export function createWatchdogBus(options: WatchdogBusOptions = {}): WatchdogBus {
  const listeners = new Set<(event: WatchdogBusEvent) => void>()
  return {
    publish(event) {
      // Snapshot: a listener that (un)subscribes while handling an event must not change the
      // iteration of the event being published.
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch (error) {
          // A listener failure must never break the probe that published the event.
          options.warn?.('[dsh-remote-go] watchdog listener failed:', error)
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
