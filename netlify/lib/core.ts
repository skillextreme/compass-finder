/**
 * The game's rules, free of Netlify specifics so they run unchanged in unit tests and on the
 * local dev server. Every record that decides a result is written once and never overwritten:
 * whoever writes first wins, and everyone else gets the stored answer back.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import {
  FINISH,
  LIMITS,
  type AttemptStatus,
  type BoardRow,
  type Boards,
  type LatLng,
  type MasterRow,
  type MasterState,
  type PingReply,
  type PublicState,
  type Result,
  type Searcher,
  type Target,
} from "../../src/config.ts";
import { distanceM } from "../../src/geo.ts";

export interface KV {
  get(key: string): Promise<unknown | null>;
  set(key: string, value: unknown): Promise<void>;
  /** Writes only when the key doesn't exist yet. Returns false if something was already there. */
  setIfNew(key: string, value: unknown): Promise<boolean>;
  /**
   * Read-modify-write on one key that is safe against other writers: `change` may run more than once.
   * Returning undefined from `change` leaves the key as it is.
   */
  update(key: string, change: (current: unknown | null) => unknown | undefined): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export interface Reply {
  status: number;
  body: Record<string, unknown>;
}

export interface ApiRequest {
  method: string;
  /** Path after /api, for example "/ping". */
  path: string;
  body: unknown;
  ip: string;
}

export interface Env {
  now?: number;
}

interface Game {
  round: number;
  target: Target | null;
}
interface Attempt {
  id: string;
  tokenHash: string;
  name: string;
  startedAt: number;
  startDistanceM: number | null;
}
interface Finish {
  method: "auto" | "approved";
  finishedAt: number;
  recordedAt: number;
}
interface LiveEntry extends LatLng {
  name: string;
  at: number;
}
/** One small record of who is out searching right now, plus the last few people to finish. */
interface Live {
  at: Record<string, LiveEntry>;
  done: { k: string; name: string; at: number }[];
}
const liveOf = (v: unknown): Live => {
  const l = v as Partial<Live> | null;
  return { at: { ...(l?.at ?? {}) }, done: [...(l?.done ?? [])] };
};

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[0-9a-f]{32,128}$/i;
const THROTTLE_MAX = 80;
const THROTTLE_WINDOW_MS = 10 * 60 * 1000;

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const publicKey = (id: string) => sha256(`searcher:${id.toLowerCase()}`).slice(0, 10);

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "hex");
  const y = Buffer.from(b, "hex");
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

function cleanName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length >= 1 && [...s].length <= LIMITS.nameMax ? s : null;
}

function coords(lat: unknown, lng: unknown): LatLng | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/** How long ago something happened on the phone, as the phone measured it. Never negative, never absurd. */
function ageOf(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.min(v, LIMITS.maxLateMs);
}

const ok = (body: Record<string, unknown>): Reply => ({ status: 200, body: { ok: true, ...body } });
const fail = (status: number, error: string): Reply => ({ status, body: { error } });

async function loadGame(kv: KV): Promise<Game> {
  const g = (await kv.get("game")) as Game | null;
  return g && typeof g.round === "number" ? g : { round: 1, target: null };
}

const k = {
  attempt: (round: number, id: string) => `r${round}/attempts/${id}`,
  finish: (round: number, id: string) => `r${round}/finishes/${id}`,
  request: (round: number, id: string) => `r${round}/requests/${id}`,
  live: (round: number) => `r${round}/live`,
};

function publicState(game: Game, now: number): PublicState {
  return { round: game.round, target: game.target, serverNow: now };
}

function toResult(a: Attempt, f: Finish): Result {
  return { method: f.method, finishedAt: f.finishedAt, durationMs: Math.max(0, f.finishedAt - a.startedAt) };
}

/** Roughly 10 metres: nobody needs a friend's exact position to see which way they are. */
const coarse = (n: number) => Math.round(n * 10_000) / 10_000;

async function throttled(kv: KV, ip: string, now: number): Promise<boolean> {
  const key = `throttle/${sha256(ip).slice(0, 24)}`;
  let blocked = false;
  await kv.update(key, (cur) => {
    const c = cur as { start: number; count: number } | null;
    const fresh = !c || typeof c.start !== "number" || now - c.start > THROTTLE_WINDOW_MS;
    const next = fresh ? { start: now, count: 1 } : { start: c.start, count: c.count + 1 };
    blocked = next.count > THROTTLE_MAX;
    return blocked ? undefined : next;
  });
  return blocked;
}

interface Authed {
  game: Game;
  attempt: Attempt;
  id: string;
}

/** Checks the id and private token every guest call carries. */
async function authed(body: unknown, kv: KV): Promise<Authed | Reply> {
  if (!body || typeof body !== "object") return fail(400, "invalid_body");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || !ID_RE.test(b.id)) return fail(400, "invalid_id");
  if (typeof b.token !== "string" || !TOKEN_RE.test(b.token)) return fail(400, "invalid_token_format");
  const game = await loadGame(kv);
  const id = b.id.toLowerCase();
  const attempt = (await kv.get(k.attempt(game.round, id))) as Attempt | null;
  if (!attempt) return fail(404, "unknown_attempt");
  if (!sameHash(attempt.tokenHash, sha256(b.token.toLowerCase()))) return fail(403, "invalid_token");
  return { game, attempt, id };
}
const isReply = (v: Authed | Reply): v is Reply => "status" in v;

async function statusOf(kv: KV, round: number, attempt: Attempt): Promise<{ status: AttemptStatus; result: Result | null }> {
  const finish = (await kv.get(k.finish(round, attempt.id))) as Finish | null;
  if (finish) return { status: "found", result: toResult(attempt, finish) };
  const request = await kv.get(k.request(round, attempt.id));
  return { status: request ? "pending" : "looking", result: null };
}

function searchersFrom(live: Live, exceptId: string | null, now: number): Searcher[] {
  const out: Searcher[] = [];
  for (const [id, e] of Object.entries(live.at)) {
    const age = now - e.at;
    if (id === exceptId || age > LIMITS.searcherStaleMs) continue;
    out.push({ k: publicKey(id), name: e.name, lat: coarse(e.lat), lng: coarse(e.lng), age: Math.max(0, age) });
  }
  return out.sort((a, b) => a.k.localeCompare(b.k));
}

/** Records a finish. The first writer wins; later writers get the stored result. */
async function recordFinish(kv: KV, round: number, attempt: Attempt, finish: Finish): Promise<{ result: Result; won: boolean }> {
  const key = k.finish(round, attempt.id);
  const won = await kv.setIfNew(key, finish);
  const stored = won ? finish : ((await kv.get(key)) as Finish);
  // Off the live map, and (once) onto the short list of recent finishers that searchers are told about.
  await kv.update(k.live(round), (cur) => {
    const live = liveOf(cur);
    const pk = publicKey(attempt.id);
    const announce = won && !live.done.some((d) => d.k === pk);
    if (!(attempt.id in live.at) && !announce) return undefined;
    delete live.at[attempt.id];
    if (announce) live.done = [...live.done, { k: pk, name: attempt.name, at: stored.finishedAt }].slice(-8);
    return live;
  });
  return { result: toResult(attempt, stored), won };
}

/* ---------- Guest calls ---------- */

async function getState(kv: KV, now: number): Promise<Reply> {
  return ok({ ...publicState(await loadGame(kv), now) });
}

/** Starts an attempt when the countdown ends. Sending the same id and token again changes nothing. */
async function start(body: unknown, ip: string, kv: KV, now: number): Promise<Reply> {
  if (!body || typeof body !== "object") return fail(400, "invalid_body");
  const b = body as Record<string, unknown>;
  if (typeof b.id !== "string" || !ID_RE.test(b.id)) return fail(400, "invalid_id");
  if (typeof b.token !== "string" || !TOKEN_RE.test(b.token)) return fail(400, "invalid_token_format");
  const name = cleanName(b.name);
  if (!name) return fail(400, "invalid_name");
  const game = await loadGame(kv);
  if (!game.target) return fail(409, "not_published");
  if (typeof b.round === "number" && b.round !== game.round) return fail(409, "round_changed");

  const id = b.id.toLowerCase();
  const key = k.attempt(game.round, id);
  const tokenHash = sha256(b.token.toLowerCase());
  let attempt = (await kv.get(key)) as Attempt | null;
  if (!attempt) {
    if (await throttled(kv, ip, now)) return fail(429, "rate_limited");
    const at = coords(b.lat, b.lng);
    const fresh: Attempt = {
      id,
      tokenHash,
      name,
      startedAt: now - ageOf(b.ageMs),
      startDistanceM: at ? Math.round(distanceM(at, game.target)) : null,
    };
    attempt = (await kv.setIfNew(key, fresh)) ? fresh : ((await kv.get(key)) as Attempt);
    if (attempt === fresh && at) {
      await kv.update(k.live(game.round), (cur) => {
        const live = liveOf(cur);
        live.at[id] = { name, lat: at.lat, lng: at.lng, at: now };
        return live;
      });
    }
  }
  if (!sameHash(attempt.tokenHash, tokenHash)) return fail(403, "invalid_token");
  const s = await statusOf(kv, game.round, attempt);
  return ok({ ...publicState(game, now), startedAt: attempt.startedAt, ...s });
}

/** A looking guest reports where they are and hears back about everyone else. */
async function ping(body: unknown, kv: KV, now: number): Promise<Reply> {
  const a = await authed(body, kv);
  if (isReply(a)) return a;
  const b = body as Record<string, unknown>;
  const s = await statusOf(kv, a.game.round, a.attempt);
  const at = coords(b.lat, b.lng);
  let live = liveOf(await kv.get(k.live(a.game.round)));
  if (s.status !== "found" && at) {
    const mine = live.at[a.id];
    if (!mine || now - mine.at >= LIMITS.pingMinMs) {
      const entry: LiveEntry = { name: a.attempt.name, lat: at.lat, lng: at.lng, at: now };
      await kv.update(k.live(a.game.round), (cur) => {
        live = liveOf(cur);
        live.at[a.id] = entry;
        return live;
      });
    }
  }
  const reply: PingReply = { ...publicState(a.game, now), ...s, searchers: searchersFrom(live, a.id, now), done: live.done };
  return ok({ ...reply });
}

/** The phone says it is inside the circle. The server checks the distance itself before recording. */
async function finish(body: unknown, kv: KV, now: number): Promise<Reply> {
  const a = await authed(body, kv);
  if (isReply(a)) return a;
  const b = body as Record<string, unknown>;
  const existing = (await kv.get(k.finish(a.game.round, a.id))) as Finish | null;
  if (existing) return ok({ status: "found", result: toResult(a.attempt, existing) });
  const at = coords(b.lat, b.lng);
  if (!at) return fail(400, "invalid_position");
  if (!a.game.target) return fail(409, "not_published");
  if (typeof b.accuracy !== "number" || !(b.accuracy <= FINISH.maxAccuracyM)) return fail(422, "weak_reading");
  if (distanceM(at, a.game.target) > FINISH.radiusM + FINISH.serverSlackM) return fail(422, "too_far");
  // The reading's own time counts, so a finish sent late (no signal) keeps its real time.
  const finishedAt = Math.max(a.attempt.startedAt, Math.min(now, now - ageOf(b.ageMs)));
  const { result } = await recordFinish(kv, a.game.round, a.attempt, { method: "auto", finishedAt, recordedAt: now });
  return ok({ status: "found", result });
}

/** "Ask Jacob to confirm". Only the first request's time is kept, however often it is retried. */
async function request(body: unknown, kv: KV, now: number): Promise<Reply> {
  const a = await authed(body, kv);
  if (isReply(a)) return a;
  const existing = (await kv.get(k.finish(a.game.round, a.id))) as Finish | null;
  if (existing) return ok({ status: "found", result: toResult(a.attempt, existing) });
  await kv.setIfNew(k.request(a.game.round, a.id), { at: Math.max(a.attempt.startedAt, now) });
  return ok({ ...(await statusOf(kv, a.game.round, a.attempt)) });
}

async function attemptStatus(body: unknown, kv: KV, now: number): Promise<Reply> {
  const a = await authed(body, kv);
  if (isReply(a)) return a;
  return ok({ ...publicState(a.game, now), ...(await statusOf(kv, a.game.round, a.attempt)) });
}

/* ---------- Everything at once: the boards and the master's list ---------- */

interface Snapshot {
  game: Game;
  attempts: Attempt[];
  finishes: Map<string, Finish>;
  requests: Map<string, number>;
  live: Live;
}

async function snapshot(kv: KV): Promise<Snapshot> {
  const game = await loadGame(kv);
  const p = `r${game.round}/`;
  const [aKeys, fKeys, rKeys, live] = await Promise.all([
    kv.list(`${p}attempts/`),
    kv.list(`${p}finishes/`),
    kv.list(`${p}requests/`),
    kv.get(k.live(game.round)),
  ]);
  const idOf = (key: string) => key.slice(key.lastIndexOf("/") + 1);
  const [attempts, finishes, requests] = await Promise.all([
    Promise.all(aKeys.map((key) => kv.get(key))),
    Promise.all(fKeys.map(async (key) => [idOf(key), await kv.get(key)] as const)),
    Promise.all(rKeys.map(async (key) => [idOf(key), await kv.get(key)] as const)),
  ]);
  return {
    game,
    attempts: attempts.filter(Boolean) as Attempt[],
    finishes: new Map(finishes.filter(([, v]) => v) as [string, Finish][]),
    requests: new Map(requests.filter(([, v]) => v).map(([id, v]) => [id, (v as { at: number }).at])),
    live: liveOf(live),
  };
}

function rank<T>(rows: T[], value: (r: T) => number): (T & { rank: number })[] {
  let last = NaN;
  let lastRank = 0;
  return rows.map((r, i) => {
    const v = value(r);
    if (v !== last) lastRank = i + 1;
    last = v;
    return { ...r, rank: lastRank };
  });
}

function boardsFrom(s: Snapshot): Boards {
  const done = s.attempts
    .filter((a) => s.finishes.has(a.id))
    .map((a) => {
      const f = s.finishes.get(a.id)!;
      return {
        k: publicKey(a.id),
        name: a.name,
        finishedAt: f.finishedAt,
        durationMs: Math.max(0, f.finishedAt - a.startedAt),
        startDistanceM: a.startDistanceM,
        method: f.method,
        startedAt: a.startedAt,
      };
    });
  const strip = ({ startedAt: _s, ...row }: (typeof done)[number] & { rank: number }): BoardRow => row;
  // Ties share a rank; whoever started first is listed first.
  const first = rank([...done].sort((a, b) => a.finishedAt - b.finishedAt || a.startedAt - b.startedAt), (r) => r.finishedAt).map(strip);
  const fastest = rank([...done].sort((a, b) => a.durationMs - b.durationMs || a.startedAt - b.startedAt), (r) => r.durationMs).map(strip);
  return { first, fastest, searching: s.attempts.length - done.length };
}

/** A tiny in-memory cache so a crowd on the results screen doesn't re-read every record each time. */
let boardCache: { at: number; round: number; boards: Boards } | null = null;
export const BOARD_CACHE_MS = { value: 2_500 };

async function board(kv: KV, now: number): Promise<Reply> {
  const fresh = boardCache && Math.abs(Date.now() - boardCache.at) < BOARD_CACHE_MS.value;
  if (!fresh) {
    const s = await snapshot(kv);
    boardCache = { at: Date.now(), round: s.game.round, boards: boardsFrom(s) };
  }
  return ok({ round: boardCache!.round, serverNow: now, boards: boardCache!.boards });
}

/*
 * ---------- Master calls ----------
 * These are open on purpose: there is no key. Jacob's board is simply a page nobody else is told about
 * (nothing on the guest page links to it). Anyone who learned the address could use it.
 */

async function master(kv: KV, now: number): Promise<Reply> {
  const s = await snapshot(kv);
  const rows: MasterRow[] = s.attempts.map((a) => {
    const f = s.finishes.get(a.id) ?? null;
    const requestedAt = s.requests.get(a.id) ?? null;
    const live = s.live.at[a.id];
    return {
      id: a.id,
      name: a.name,
      status: f ? "found" : requestedAt ? "pending" : "looking",
      startedAt: a.startedAt,
      startDistanceM: a.startDistanceM,
      requestedAt,
      finishedAt: f?.finishedAt ?? null,
      durationMs: f ? Math.max(0, f.finishedAt - a.startedAt) : null,
      method: f?.method ?? null,
      pos: live && !f ? { lat: live.lat, lng: live.lng, age: Math.max(0, now - live.at) } : null,
    };
  });
  // People waiting for Jacob come first, then those still looking, then finishers in arrival order.
  const order = { pending: 0, looking: 1, found: 2 } as const;
  rows.sort(
    (a, b) =>
      order[a.status] - order[b.status] ||
      (a.status === "pending"
        ? a.requestedAt! - b.requestedAt!
        : a.status === "found"
          ? a.finishedAt! - b.finishedAt!
          : a.startedAt - b.startedAt) ||
      a.id.localeCompare(b.id),
  );
  const state: MasterState = { ...publicState(s.game, now), rows, boards: boardsFrom(s) };
  return ok({ ...state });
}

/** "Find me": fixes the spot every compass points to. It stays put until Jacob marks a new one. */
async function setTarget(body: unknown, kv: KV, now: number): Promise<Reply> {
  const b = (body ?? {}) as Record<string, unknown>;
  const at = coords(b.lat, b.lng);
  if (!at) return fail(400, "invalid_position");
  const accuracy = typeof b.accuracy === "number" && Number.isFinite(b.accuracy) && b.accuracy >= 0 ? Math.round(b.accuracy * 10) / 10 : 0;
  let game: Game = { round: 1, target: null };
  await kv.update("game", (cur) => {
    const g = cur as Game | null;
    game = { round: g && typeof g.round === "number" ? g.round : 1, target: { ...at, accuracy, publishedAt: now } };
    return game;
  });
  return ok({ ...publicState(game, now) });
}

/** Jacob has seen the guest. Uses the time they asked, or now if they never asked. */
async function approve(body: unknown, kv: KV, now: number): Promise<Reply> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (typeof b.id !== "string" || !ID_RE.test(b.id)) return fail(400, "invalid_id");
  const id = b.id.toLowerCase();
  const game = await loadGame(kv);
  const attempt = (await kv.get(k.attempt(game.round, id))) as Attempt | null;
  if (!attempt) return fail(404, "unknown_attempt");
  const asked = (await kv.get(k.request(game.round, id))) as { at: number } | null;
  const finishedAt = Math.max(attempt.startedAt, asked?.at ?? now);
  const { result, won } = await recordFinish(kv, game.round, attempt, { method: "approved", finishedAt, recordedAt: now });
  boardCache = null;
  return ok({ result, already: !won });
}

/** Starts a clean round: nobody is looking and the boards are empty. Old records are simply left behind. */
async function reset(body: unknown, kv: KV, now: number): Promise<Reply> {
  const keepTarget = (body as { keepTarget?: unknown } | null)?.keepTarget === true;
  let game: Game = { round: 1, target: null };
  await kv.update("game", (cur) => {
    const g = cur as Game | null;
    game = { round: (g && typeof g.round === "number" ? g.round : 1) + 1, target: keepTarget ? (g?.target ?? null) : null };
    return game;
  });
  boardCache = null;
  return ok({ ...publicState(game, now) });
}

/* ---------- Router ---------- */

export async function route(req: ApiRequest, kv: KV, env: Env): Promise<Reply> {
  const now = env.now ?? Date.now();
  const at = `${req.method} ${req.path.replace(/\/+$/, "") || "/"}`;
  switch (at) {
    case "GET /state":
      return getState(kv, now);
    case "GET /board":
      return board(kv, now);
    case "POST /start":
      return start(req.body, req.ip, kv, now);
    case "POST /ping":
      return ping(req.body, kv, now);
    case "POST /finish": {
      const r = await finish(req.body, kv, now);
      if (r.status === 200) boardCache = null;
      return r;
    }
    case "POST /request":
      return request(req.body, kv, now);
    case "POST /attempt":
      return attemptStatus(req.body, kv, now);
  }
  if (req.path.startsWith("/master")) {
    switch (at) {
      case "GET /master":
        return master(kv, now);
      case "POST /master/target":
        return setTarget(req.body, kv, now);
      case "POST /master/approve":
        return approve(req.body, kv, now);
      case "POST /master/reset":
        return reset(req.body, kv, now);
    }
  }
  return fail(req.method === "GET" || req.method === "POST" ? 404 : 405, "not_found");
}

/** An in-memory store with the same guarantees, for unit tests and the local dev server. */
export function memoryKV(): KV & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: async (key) => (data.has(key) ? structuredClone(data.get(key)) : null),
    set: async (key, value) => void data.set(key, structuredClone(value)),
    setIfNew: async (key, value) => {
      // The check and the write happen in one synchronous step after the await, like the real store's guarantee.
      await Promise.resolve();
      if (data.has(key)) return false;
      data.set(key, structuredClone(value));
      return true;
    },
    update: async (key, change) => {
      await Promise.resolve();
      const next = change(data.has(key) ? structuredClone(data.get(key)) : null);
      if (next !== undefined) data.set(key, structuredClone(next));
    },
    list: async (prefix) => [...data.keys()].filter((key) => key.startsWith(prefix)),
  };
}
