/**
 * Same-device memory. Every localStorage call is wrapped: private windows and blocked
 * storage must never break the game.
 */
import type { Result } from "./config.ts";

const ATTEMPT_KEY = "cf.attempt.v1";
const NAME_KEY = "cf.name.v1";

export interface LocalAttempt {
  round: number;
  /** Attempt id, made on this phone and reused for every retry. */
  id: string;
  /** Private token. The server stores only its hash. */
  token: string;
  name: string;
  /** When the countdown ended, by this phone's clock. */
  startedLocal: number;
  /** Where the phone was at the start, for the start distance. */
  startAt: { lat: number; lng: number } | null;
  /** True once the server has the start. */
  synced: boolean;
  /** True once "Ask Jacob to confirm" has reached the server. */
  requested: boolean;
  /** A finish the phone has decided on but the server hasn't confirmed yet. */
  pendingFinish: { lat: number; lng: number; accuracy: number; at: number } | null;
  result: Result | null;
}

function read(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: carry on in memory */
  }
}

let memory: LocalAttempt | null = null;

export function loadAttempt(): LocalAttempt | null {
  if (memory) return memory;
  try {
    const v = JSON.parse(read(ATTEMPT_KEY) ?? "null") as Partial<LocalAttempt> | null;
    if (!v || typeof v.id !== "string" || typeof v.token !== "string" || typeof v.round !== "number" || typeof v.startedLocal !== "number") return null;
    memory = {
      round: v.round,
      id: v.id,
      token: v.token,
      name: typeof v.name === "string" ? v.name : "",
      startedLocal: v.startedLocal,
      startAt: v.startAt && typeof v.startAt.lat === "number" && typeof v.startAt.lng === "number" ? v.startAt : null,
      synced: v.synced === true,
      requested: v.requested === true,
      pendingFinish: v.pendingFinish && typeof v.pendingFinish.at === "number" ? v.pendingFinish : null,
      result: v.result && typeof v.result.finishedAt === "number" ? v.result : null,
    };
    return memory;
  } catch {
    return null;
  }
}

export function storeAttempt(a: LocalAttempt): void {
  memory = a;
  write(ATTEMPT_KEY, JSON.stringify(a));
}

export function clearAttempt(): void {
  memory = null;
  write(ATTEMPT_KEY, null);
}

export const loadName = () => read(NAME_KEY) ?? "";
export const storeName = (name: string) => write(NAME_KEY, name);

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function newIdentity(): { id: string; token: string } {
  const id =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${randomHex(4)}-${randomHex(2)}-4${randomHex(2).slice(1)}-a${randomHex(2).slice(1)}-${randomHex(6)}`;
  return { id, token: randomHex(32) };
}
