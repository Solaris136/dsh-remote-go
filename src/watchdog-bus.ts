/** The watchdog's action bus: a synchronous in-process channel replacing the two reverse `ctx` callbacks. The detectors
 * are interval callbacks with no return-value receiver, so the bus keeps "who noticed" (`watchdog.ts`) apart from "who
 * acts" (`connect/watchdog.ts`). One event family; a listener that throws is reported and skipped. */
import type { WatchdogEvent } from './runtime/events.js'
export type WatchdogBusEvent = WatchdogEvent & { hostId: string }
export interface WatchdogBus {
  publish(event: WatchdogBusEvent): void
  subscribe(listener: (event: WatchdogBusEvent) => void): () => void
}
export interface WatchdogBusOptions {
  warn?: (...args: unknown[]) => void
}

export function createWatchdogBus(options: WatchdogBusOptions = {}): WatchdogBus {
  const listeners = new Set<(event: WatchdogBusEvent) => void>()
  return {
    publish(event) {
      for (const listener of [...listeners]) {
        try {
          listener(event)
        } catch (error) {
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
