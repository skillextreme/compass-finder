/**
 * The compass itself: a face that keeps N pointing north, the paper plane pointing at Jacob,
 * his portrait on the rim in that direction, and tiny arrows for friends who are also searching.
 * Only transforms change from frame to frame, so it stays smooth on modest phones.
 */
import { compassFace, compassPlane, jacobPortrait, pinColor } from "./art.ts";
import { norm360, turn } from "./geo.ts";
import { el } from "./ui.ts";

export interface Pin {
  k: string;
  name: string;
  /** Compass bearing from this phone to the friend. */
  bearing: number;
  distanceM: number;
  ageMs: number;
}

export class CompassView {
  readonly root: HTMLElement;
  private face: HTMLElement;
  private plane: HTMLElement;
  private jacob: HTMLElement;
  private pinLayer: HTMLElement;
  private pinEls = new Map<string, { root: HTMLElement; beak: HTMLElement; pin: Pin }>();
  private bearing: number | null = null;
  private heading: number | null = null;
  private shown: number | null = null;
  private raf = 0;
  private lastFrame = 0;
  private size = 0;
  private observer: ResizeObserver;

  constructor() {
    this.face = el("div", { class: "compass__face", html: compassFace() });
    this.plane = el("div", { class: "compass__plane", html: compassPlane() });
    this.jacob = el("div", { class: "compass__jacob", html: jacobPortrait() });
    this.pinLayer = el("div", { class: "compass__pins" });
    this.root = el("div", { class: "compass is-seeking", role: "img", "aria-label": "Compass" }, this.face, this.plane, this.jacob, this.pinLayer);
    this.observer = new ResizeObserver(() => {
      this.size = this.root.clientWidth;
      this.draw();
    });
  }

  start(): void {
    this.observer.observe(this.root);
    this.size = this.root.clientWidth;
    const frame = (t: number) => {
      this.raf = requestAnimationFrame(frame);
      const dt = Math.min(100, t - (this.lastFrame || t));
      this.lastFrame = t;
      if (this.heading === null) return;
      if (this.shown === null) {
        this.shown = this.heading;
        this.draw();
        return;
      }
      const gap = turn(this.shown, this.heading);
      if (Math.abs(gap) < 0.05) return;
      // Ease towards the real heading: quick enough to feel live, slow enough to hide sensor jitter.
      this.shown = norm360(this.shown + gap * (1 - Math.exp(-dt / 110)));
      this.draw();
    };
    this.raf = requestAnimationFrame(frame);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.observer.disconnect();
  }

  setBearing(bearing: number | null): void {
    this.bearing = bearing;
    this.draw();
  }

  setHeading(heading: number | null): void {
    const was = this.heading;
    this.heading = heading;
    if (heading === null) this.shown = null;
    if ((was === null) !== (heading === null)) {
      this.root.classList.toggle("is-seeking", heading === null);
      this.draw();
    }
  }

  setPins(pins: Pin[]): void {
    const seen = new Set<string>();
    for (const p of pins) {
      seen.add(p.k);
      let entry = this.pinEls.get(p.k);
      if (!entry) {
        const beak = el("span", { class: "pin__beak" });
        const root = el("div", { class: "pin", "data-key": p.k }, beak, el("span", { class: "pin__dot" }, [...p.name][0]?.toUpperCase() ?? "?"));
        root.style.setProperty("--pin", pinColor(p.k));
        this.pinLayer.append(root);
        entry = { root, beak, pin: p };
        this.pinEls.set(p.k, entry);
      }
      entry.pin = p;
      entry.root.title = p.name;
    }
    for (const [key, entry] of this.pinEls) {
      if (!seen.has(key)) {
        entry.root.remove();
        this.pinEls.delete(key);
      }
    }
    this.draw();
  }

  /** Where things currently sit, for tests: angles are clockwise from the top of the screen. */
  snapshot(): { plane: number | null; pins: Record<string, number> } {
    const h = this.shown;
    const pins: Record<string, number> = {};
    if (h !== null) for (const [key, e] of this.pinEls) pins[key] = norm360(e.pin.bearing - h);
    return { plane: h !== null && this.bearing !== null ? norm360(this.bearing - h) : null, pins };
  }

  private draw(): void {
    const h = this.shown;
    const seeking = h === null || this.bearing === null;
    this.root.classList.toggle("is-blind", seeking);
    if (h === null) {
      this.face.style.transform = "";
      this.plane.style.transform = "";
      return;
    }
    this.face.style.transform = `rotate(${(-h).toFixed(2)}deg)`;
    if (this.bearing === null) return;
    const rel = norm360(this.bearing - h);
    this.plane.style.transform = `rotate(${rel.toFixed(2)}deg)`;
    this.root.classList.toggle("is-ahead", rel < 14 || rel > 346);
    const place = (node: HTMLElement, angle: number, radius: number, extra = "") => {
      const a = (angle * Math.PI) / 180;
      node.style.transform = `translate(-50%, -50%) translate(${(Math.sin(a) * radius).toFixed(1)}px, ${(-Math.cos(a) * radius).toFixed(1)}px)${extra}`;
    };
    const s = this.size || this.root.clientWidth;
    place(this.jacob, rel, s * 0.365);
    for (const { root, beak, pin } of this.pinEls.values()) {
      const a = norm360(pin.bearing - h);
      // Nearer friends are a little bigger; ones we haven't heard from for a while fade.
      const scale = pin.distanceM < 60 ? 1 : pin.distanceM < 250 ? 0.88 : 0.76;
      place(root, a, s * 0.47, ` scale(${scale})`);
      root.style.opacity = pin.ageMs > 30_000 ? "0.45" : "1";
      beak.style.transform = `rotate(${a.toFixed(1)}deg)`;
    }
  }
}
