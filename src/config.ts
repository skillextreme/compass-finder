/**
 * Single place for the game's rules and tuning. The phone and the server both read from here.
 * Change a number, push, and Netlify redeploys.
 */
export const GAME = {
  id: "jacob-birthday-2026",
  host: "Jacob",
  park: "Cubbon Park",
  timeZone: "Asia/Kolkata",
} as const;

/** How an attempt finishes on its own. Tune these after walking the park. */
export const FINISH = {
  /** Finish circle around the marked spot, in metres. */
  radiusM: 10,
  /** Readings less sure than this (metres) can't finish an attempt. */
  maxAccuracyM: 20,
  /** A reading older than this is ignored. */
  maxAgeMs: 10_000,
  /** A second reading inside the circle, at least this long after the first, confirms the finish. */
  confirmAfterMs: 2_000,
  /** The two readings must be no further apart in time than this. */
  confirmWithinMs: 20_000,
  /** The server allows this much extra when it re-checks a finish, for rounding. */
  serverSlackM: 1,
} as const;

/** Seconds counted down before the timer starts. */
export const COUNTDOWN_S = 3;

/** Flowers are fully closed at this distance (about the park edge) and fully open at the finish circle. */
export const BLOOM = { farM: 600, nearM: FINISH.radiusM, flowers: 5 } as const;

export const LIMITS = {
  nameMax: 16,
  /** A searcher who hasn't been heard from for this long drops off other people's compasses. */
  searcherStaleMs: 60_000,
  /** Positions are stored at most this often per guest. */
  pingMinMs: 2_000,
  /** Most arrows drawn on a compass at once. The count chip still shows everyone. */
  maxArrows: 6,
  /** An offline start or finish can be reported at most this late and still keep its real time. */
  maxLateMs: 3 * 60 * 60 * 1000,
} as const;

export const POLL = {
  waitingMs: 4_000,
  lookingMs: 5_000,
  pendingMs: 3_000,
  boardMs: 6_000,
  masterMs: 3_000,
} as const;

export interface LatLng {
  lat: number;
  lng: number;
}

/* ---------- Shapes shared by the phone and the server ---------- */

export interface Target extends LatLng {
  accuracy: number;
  publishedAt: number;
}

export interface Searcher extends LatLng {
  /** Short public key, never the attempt id. */
  k: string;
  name: string;
  /** Milliseconds since this searcher was last heard from. */
  age: number;
}

export interface BoardRow {
  k: string;
  name: string;
  rank: number;
  finishedAt: number;
  durationMs: number;
  startDistanceM: number | null;
  method: "auto" | "approved";
}

export interface Boards {
  first: BoardRow[];
  fastest: BoardRow[];
  searching: number;
}

export interface Result {
  method: "auto" | "approved";
  finishedAt: number;
  durationMs: number;
}

export type AttemptStatus = "looking" | "pending" | "found";

export interface PublicState {
  round: number;
  target: Target | null;
  serverNow: number;
}

export interface PingReply extends PublicState {
  status: AttemptStatus;
  result: Result | null;
  searchers: Searcher[];
  /** The last few people to find Jacob, oldest first. */
  done: { k: string; name: string; at: number }[];
}

export interface MasterRow {
  id: string;
  name: string;
  status: AttemptStatus;
  startedAt: number;
  startDistanceM: number | null;
  requestedAt: number | null;
  finishedAt: number | null;
  durationMs: number | null;
  method: "auto" | "approved" | null;
  /** Last known position while looking, with its age in ms. */
  pos: (LatLng & { age: number }) | null;
}

export interface MasterState extends PublicState {
  rows: MasterRow[];
  boards: Boards;
}
