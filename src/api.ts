/** Thin client for the /api routes. The compass itself keeps working on the phone when these fail. */
import type { AttemptStatus, Boards, MasterState, PingReply, PublicState, Result } from "./config.ts";

export type ApiCode = "network" | "unknown_attempt" | "round_changed" | "not_published" | "rate_limited" | "too_far" | "weak_reading" | "invalid" | "server";

export class ApiError extends Error {
  constructor(
    public code: ApiCode,
    message: string,
  ) {
    super(message);
  }
}

const KNOWN: ApiCode[] = ["unknown_attempt", "round_changed", "not_published", "rate_limited", "too_far", "weak_reading"];

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      signal: ctrl.signal,
      cache: "no-store",
      headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("network", "Network problem");
  } finally {
    window.clearTimeout(timer);
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* handled below */
  }
  if (!res.ok || data === null || typeof data !== "object") {
    const code = (data as { error?: string } | null)?.error as ApiCode | undefined;
    if (code && KNOWN.includes(code)) throw new ApiError(code, code);
    if (res.status === 400 || res.status === 422) throw new ApiError("invalid", code ?? "invalid");
    // A page served without the API (plain static hosting) answers with HTML: treat it as no connection.
    throw new ApiError(res.status === 404 || res.status >= 500 ? "server" : "network", `Server error ${res.status}`);
  }
  return data as T;
}

export interface Identity {
  id: string;
  token: string;
}
export interface StatusReply {
  status: AttemptStatus;
  result: Result | null;
}

export const getState = () => call<PublicState>("GET", "/state");
export const getBoard = () => call<{ round: number; serverNow: number; boards: Boards }>("GET", "/board");
export const postStart = (who: Identity, body: { name: string; round: number; ageMs: number; lat?: number; lng?: number }) =>
  call<PublicState & StatusReply & { startedAt: number }>("POST", "/start", { ...who, ...body });
export const postPing = (who: Identity, at: { lat: number; lng: number } | null) => call<PingReply>("POST", "/ping", { ...who, ...(at ?? {}) });
export const postFinish = (who: Identity, body: { lat: number; lng: number; accuracy: number; ageMs: number }) => call<StatusReply>("POST", "/finish", { ...who, ...body });
export const postRequest = (who: Identity) => call<StatusReply>("POST", "/request", who);

export const getMaster = () => call<MasterState>("GET", "/master");
export const postTarget = (at: { lat: number; lng: number; accuracy: number }) => call<PublicState>("POST", "/master/target", at);
export const postApprove = (id: string) => call<{ result: Result; already: boolean }>("POST", "/master/approve", { id });
export const postReset = (keepTarget: boolean) => call<PublicState>("POST", "/master/reset", { keepTarget });
