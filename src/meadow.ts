/**
 * The whole screen is a meadow seen from above, dotted with small dandelions.
 * Far from Jacob they are tight buds. As the guest gets closer, more and more of them open,
 * one here and one there, until the page is in full bloom at the finish.
 */
import { dandelionTop, seed } from "./art.ts";
import { el } from "./ui.ts";

interface Flower {
  node: HTMLElement;
  /** How far along the walk (0 to 1) this flower starts to open. */
  opensAt: number;
  stage: number;
}

/** Deterministic random numbers, so the meadow looks the same every time the screen is drawn. */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MAX_FLOWERS = 64;

/** Parts of the screen to keep free of flowers. */
export interface Clear {
  rects: DOMRect[];
  circles: { x: number; y: number; r: number }[];
}
/** The gap between a flower starting to open and being fully open, as a share of the walk. */
const OPENING_SPAN = 0.07;

export class Meadow {
  readonly root: HTMLElement;
  private flowers: Flower[] = [];
  private fraction = 0;
  private puffed = false;
  private avoid: () => Clear = () => ({ rects: [], circles: [] });
  private resizeTimer = 0;
  private size = "";
  /** Re-plants when the screen changes size (browser bars sliding away, the phone turning). */
  private observer = new ResizeObserver(() => {
    const size = `${window.innerWidth}x${window.innerHeight}`;
    if (size === this.size) return;
    window.clearTimeout(this.resizeTimer);
    this.resizeTimer = window.setTimeout(() => this.plant(), 120);
  });

  constructor() {
    this.root = el("div", { class: "meadow", role: "img" });
  }

  /**
   * Scatters the flowers over the screen, keeping clear of the areas given (the compass, the words,
   * the buttons) so nothing important has a flower behind it. Call once the screen is laid out.
   */
  layout(avoid: () => Clear = () => ({ rects: [], circles: [] })): void {
    this.avoid = avoid;
    this.plant();
    this.observer.observe(this.root);
  }

  destroy(): void {
    this.observer.disconnect();
    window.clearTimeout(this.resizeTimer);
  }

  private plant(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.size = `${w}x${h}`;
    const rand = rng(20261115);
    const blocked = this.avoid();
    const placed: { x: number; y: number; r: number }[] = [];
    const want = Math.min(MAX_FLOWERS, Math.round((w * h) / 4200));
    // Thresholds spread evenly from "opens first" to "opens last", then shuffled over the page.
    const order = Array.from({ length: want }, (_, i) => i).sort(() => rand() - 0.5);
    this.root.replaceChildren();
    this.flowers = [];
    for (let tries = 0; tries < 4000 && placed.length < want; tries++) {
      const size = 26 + rand() * 22;
      const r = size / 2;
      const x = rand() * w;
      const y = rand() * h;
      // Flowers may peek in from the edges, but stay clear of the blocked areas and of each other.
      const pad = r * 0.75;
      if (blocked.rects.some((b) => x + pad > b.left && x - pad < b.right && y + pad > b.top && y - pad < b.bottom)) continue;
      if (blocked.circles.some((c) => Math.hypot(c.x - x, c.y - y) < c.r + pad)) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.y - y) < (p.r + r) * 1.05)) continue;
      placed.push({ x, y, r });
      const node = el("span", { class: "meadow__flower", "data-stage": "0", html: dandelionTop() });
      node.style.cssText = `left:${((x / w) * 100).toFixed(2)}%;top:${((y / h) * 100).toFixed(2)}%;width:${size.toFixed(0)}px;--turn:${Math.round(rand() * 360)}deg;--d:${(rand() * 0.25).toFixed(2)}s`;
      const i = this.flowers.length;
      this.flowers.push({ node, opensAt: 0.03 + (order[i] / Math.max(1, want - 1)) * (0.97 - OPENING_SPAN), stage: 0 });
      this.root.append(node);
    }
    this.apply();
  }

  /**
   * `steps` is the coarse 0–10 reading used for the buzz and for checks; `fraction` (0 to 1) drives the flowers.
   * Returns true when the meadow has moved up a step.
   */
  set(steps: number, fraction = steps / 10): boolean {
    const before = Number(this.root.dataset.steps ?? "-1");
    this.fraction = Math.max(0, Math.min(1, fraction));
    this.root.dataset.steps = String(steps);
    this.apply();
    return before >= 0 && steps > before;
  }

  /** The finish: every flower turns to a seed puff. */
  puff(): void {
    this.puffed = true;
    this.root.dataset.steps = "puff";
    this.apply();
  }

  private apply(): void {
    let open = 0;
    for (const f of this.flowers) {
      const stage = this.puffed ? 3 : this.fraction >= f.opensAt + OPENING_SPAN || this.fraction >= 1 ? 2 : this.fraction >= f.opensAt ? 1 : 0;
      if (stage === 2) open++;
      if (stage !== f.stage || f.node.dataset.stage !== String(stage)) {
        f.stage = stage;
        f.node.dataset.stage = String(stage);
      }
    }
    this.root.dataset.open = String(open);
    this.root.dataset.flowers = String(this.flowers.length);
    this.root.setAttribute("aria-label", this.puffed ? "A meadow of dandelions gone to seed" : `A meadow from above: ${open} of ${this.flowers.length} dandelions open`);
  }
}

/** Dandelion seeds drifting across the screen for the celebration. */
export function seedShower(count = 26): HTMLElement {
  const layer = el("div", { class: "seeds", "aria-hidden": "true" });
  for (let i = 0; i < count; i++) {
    const s = el("span", { class: "seeds__seed", html: seed() });
    s.style.setProperty("--x", `${Math.round(Math.random() * 100)}vw`);
    s.style.setProperty("--drift", `${Math.round(20 + Math.random() * 50)}vw`);
    s.style.setProperty("--delay", `${(Math.random() * 5).toFixed(2)}s`);
    s.style.setProperty("--time", `${(5 + Math.random() * 5).toFixed(2)}s`);
    s.style.setProperty("--size", `${Math.round(18 + Math.random() * 16)}px`);
    layer.append(s);
  }
  return layer;
}
