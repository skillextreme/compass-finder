/** Pure geometry and the finish rule. No browser APIs, so everything here is unit tested. */
import { BLOOM, FINISH, type LatLng } from "./config.ts";

const R = 6_371_000;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

/** Great-circle distance in metres. */
export function distanceM(a: LatLng, b: LatLng): number {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Direction from a to b in degrees clockwise from north, 0–360. */
export function bearingDeg(a: LatLng, b: LatLng): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return norm360(deg(Math.atan2(y, x)));
}

/** The point a distance and bearing away from a start. Used by tests and the master's radar. */
export function destination(from: LatLng, bearing: number, metres: number): LatLng {
  const d = metres / R;
  const b = rad(bearing);
  const lat1 = rad(from.lat);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lng2 = rad(from.lng) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return { lat: deg(lat2), lng: deg(lng2) };
}

export function norm360(a: number): number {
  return ((a % 360) + 360) % 360;
}

/** Smallest signed turn from angle a to angle b, in -180..180. */
export function turn(a: number, b: number): number {
  return norm360(b - a + 180) - 180;
}

/**
 * Where something at a compass bearing appears on screen: 0 = straight ahead of the phone,
 * positive = to the right. `screenAngle` is the screen's rotation (0 in portrait).
 */
export function relativeAngle(bearing: number, heading: number, screenAngle = 0): number {
  return turn(0, bearing - heading - screenAngle);
}

/**
 * How open the flowers are, from 0 (all closed, park edge or further) to 1 (all open, at the finish circle).
 * The scale is logarithmic so the last 100 metres still show clear changes.
 */
export function bloom(distance: number): number {
  if (!Number.isFinite(distance)) return 0;
  if (distance <= BLOOM.nearM) return 1;
  if (distance >= BLOOM.farM) return 0;
  return Math.log(BLOOM.farM / distance) / Math.log(BLOOM.farM / BLOOM.nearM);
}

/** Whole bloom steps, 0 to flowers × 2. Each flower goes bud → opening → open. */
export function bloomSteps(distance: number): number {
  const max = BLOOM.flowers * 2;
  return Math.max(0, Math.min(max, Math.floor(bloom(distance) * max + 1e-9)));
}

/** Short words that go with the distance. */
export function warmth(distance: number): string {
  if (distance <= FINISH.radiusM) return "You're here!";
  if (distance <= 25) return "Look up! Jacob is right here";
  if (distance <= 60) return "So close";
  if (distance <= 120) return "Hot";
  if (distance <= 220) return "Getting warmer";
  if (distance <= 400) return "Lukewarm";
  if (distance <= 700) return "Chilly";
  return "Far, far away";
}

export function formatDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(1)} km`;
  if (m >= 100) return `${Math.round(m / 10) * 10} m`;
  return `${Math.max(0, Math.round(m))} m`;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const two = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${two(m)}:${two(sec)}` : `${m}:${two(sec)}`;
}

export function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export interface Reading extends LatLng {
  /** Reported accuracy radius in metres. */
  accuracy: number;
  /** When the reading was taken, in the phone's clock (ms). */
  at: number;
}

export type GateVerdict = "outside" | "weak" | "stale" | "first" | "waiting" | "finished";

/**
 * Decides when an attempt finishes on its own: a fresh, accurate reading inside the circle,
 * confirmed by a second one a moment later. One reading outside (or weak, or stale) starts over,
 * which keeps a single stray reading under trees from ending the game early.
 */
export class FinishGate {
  private first: Reading | null = null;

  constructor(private rules: typeof FINISH = FINISH) {}

  reset(): void {
    this.first = null;
  }

  offer(reading: Reading, target: LatLng, now: number): GateVerdict {
    const r = this.rules;
    if (now - reading.at > r.maxAgeMs) return this.fail("stale");
    if (!(reading.accuracy <= r.maxAccuracyM)) return this.fail("weak");
    if (distanceM(reading, target) > r.radiusM) return this.fail("outside");
    if (!this.first || reading.at - this.first.at > r.confirmWithinMs) {
      this.first = reading;
      return "first";
    }
    if (reading.at - this.first.at < r.confirmAfterMs) return "waiting";
    return "finished";
  }

  private fail(v: GateVerdict): GateVerdict {
    this.first = null;
    return v;
  }
}

/** Averages a run of readings into one spot, trusting the more accurate ones more. Used for "Find me". */
export function averageReadings(readings: Reading[]): { lat: number; lng: number; accuracy: number } | null {
  const good = readings.filter((r) => Number.isFinite(r.accuracy) && r.accuracy > 0);
  if (!good.length) return null;
  const best = Math.min(...good.map((r) => r.accuracy));
  const kept = good.filter((r) => r.accuracy <= Math.max(best * 1.6, best + 5));
  let w = 0;
  let lat = 0;
  let lng = 0;
  for (const r of kept) {
    const weight = 1 / (r.accuracy * r.accuracy);
    w += weight;
    lat += r.lat * weight;
    lng += r.lng * weight;
  }
  return { lat: lat / w, lng: lng / w, accuracy: Math.round(best * 10) / 10 };
}
