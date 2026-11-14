/**
 * Which way the top of the phone points, in degrees clockwise from north.
 * Uses the phone's compass sensor when there is one. If the sensor is missing or blocked,
 * falls back to the direction the guest is walking, worked out from their last few positions.
 */
import { bearingDeg, distanceM, norm360, type Reading } from "./geo.ts";

export type HeadingSource = "sensor" | "walk" | null;

type OrientationEvent = DeviceOrientationEvent & { webkitCompassHeading?: number };
type PermissionCtor = { requestPermission?: () => Promise<"granted" | "denied"> };

const SENSOR_FRESH_MS = 3_000;
const WALK_FRESH_MS = 25_000;
const WALK_STEP_M = 7;

/**
 * Compass heading from the three orientation angles (alpha measured anticlockwise from north).
 * Held flat, the heading is where the top edge points. Held upright like a camera, the top edge
 * points at the sky, so the direction the back of the phone faces takes over. Adding the two
 * ground-level vectors blends smoothly between those grips.
 */
export function headingFromAngles(alpha: number, beta: number | null, gamma: number | null): number | null {
  const r = Math.PI / 180;
  const a = alpha * r;
  const b = (beta ?? 0) * r;
  const g = (gamma ?? 0) * r;
  let east = -Math.sin(a) * Math.cos(b);
  let north = Math.cos(a) * Math.cos(b);
  if (b > 0) {
    east += -Math.cos(a) * Math.sin(g) - Math.sin(a) * Math.sin(b) * Math.cos(g);
    north += -Math.sin(a) * Math.sin(g) + Math.cos(a) * Math.sin(b) * Math.cos(g);
  }
  if (Math.abs(east) < 1e-6 && Math.abs(north) < 1e-6) return null;
  return norm360((Math.atan2(east, north) * 180) / Math.PI);
}

function screenAngle(): number {
  const a = window.screen?.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation;
  return typeof a === "number" ? a : 0;
}

export class Heading {
  private sensor: { deg: number; at: number } | null = null;
  private walk: { deg: number; at: number } | null = null;
  private anchor: Reading | null = null;
  private listening = false;
  /** "denied" when the guest said no to motion access on an iPhone. */
  permission: "unknown" | "granted" | "denied" = "unknown";

  /** True on iPhones, where the sensor needs a tap-triggered permission prompt. */
  needsPermission(): boolean {
    return typeof (window.DeviceOrientationEvent as unknown as PermissionCtor | undefined)?.requestPermission === "function";
  }

  /** Call directly from a tap. Starts listening, asking for permission first where the browser requires it. */
  async enable(): Promise<void> {
    const ctor = window.DeviceOrientationEvent as unknown as PermissionCtor | undefined;
    if (typeof ctor?.requestPermission === "function") {
      try {
        this.permission = await ctor.requestPermission();
      } catch {
        this.permission = "denied";
      }
    } else {
      this.permission = "granted";
    }
    // Listen either way: if access was refused the events simply never arrive, and walking takes over.
    this.listen();
  }

  private listen(): void {
    if (this.listening) return;
    this.listening = true;
    const on = (e: Event) => this.onOrientation(e as OrientationEvent);
    window.addEventListener("deviceorientationabsolute", on);
    window.addEventListener("deviceorientation", on);
  }

  private onOrientation(e: OrientationEvent): void {
    let h: number | null = null;
    if (typeof e.webkitCompassHeading === "number" && e.webkitCompassHeading >= 0) {
      h = e.webkitCompassHeading;
    } else if ((e.absolute === true || e.type === "deviceorientationabsolute") && typeof e.alpha === "number") {
      h = headingFromAngles(e.alpha, e.beta, e.gamma);
    }
    if (h === null || !Number.isFinite(h)) return;
    this.sensor = { deg: norm360(h + screenAngle()), at: Date.now() };
  }

  /** Feed every position reading in, so the walking direction is ready if the sensor isn't. */
  feedPosition(r: Reading): void {
    if (!this.anchor) {
      this.anchor = r;
      return;
    }
    const moved = distanceM(this.anchor, r);
    if (moved >= Math.max(WALK_STEP_M, r.accuracy * 0.6)) {
      this.walk = { deg: bearingDeg(this.anchor, r), at: r.at };
      this.anchor = r;
    }
  }

  current(now = Date.now()): { deg: number | null; source: HeadingSource } {
    if (this.sensor && now - this.sensor.at < SENSOR_FRESH_MS) return { deg: this.sensor.deg, source: "sensor" };
    if (this.walk && now - this.walk.at < WALK_FRESH_MS) return { deg: this.walk.deg, source: "walk" };
    return { deg: null, source: null };
  }
}
