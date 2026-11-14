/** The strip of grass along the bottom with five dandelions that open as the guest gets closer. */
import { C, dandelion, seed } from "./art.ts";
import { BLOOM } from "./config.ts";
import { el } from "./ui.ts";

const STEMS: [x: number, height: number, lean: number][] = [
  [44, 58, 4],
  [112, 76, -5],
  [180, 64, 3],
  [248, 82, -4],
  [316, 60, 5],
];

export class Meadow {
  readonly root: HTMLElement;
  private flowers: SVGGElement[];
  private steps = -1;

  constructor() {
    const flowers = STEMS.map(
      ([x, height, lean], i) => `<g class="dandelion" data-stage="0" style="--i:${i}" transform="translate(${x},118)">${dandelion(height, lean)}</g>`,
    ).join("");
    const svg =
      `<svg viewBox="0 0 360 130" preserveAspectRatio="xMidYMax meet" aria-hidden="true" focusable="false">` +
      `<path d="M-200,130 V112 C-80,92 60,98 180,104 C300,110 440,94 560,110 V130 Z" fill="${C.grass}" stroke="${C.line}" stroke-width="2.5"/>` +
      `<path d="M-200,130 V124 C-40,112 120,120 220,122 C340,124 460,114 560,124 V130 Z" fill="${C.grass2}"/>` +
      flowers +
      `</svg>`;
    this.root = el("div", { class: "meadow", role: "img", html: svg });
    this.flowers = [...this.root.querySelectorAll<SVGGElement>(".dandelion")];
    this.set(0);
  }

  /** `steps` runs from 0 (all buds) to 10 (all five open). Returns true when it grew. */
  set(steps: number): boolean {
    if (steps === this.steps) return false;
    const grew = steps > this.steps && this.steps >= 0;
    this.steps = steps;
    this.flowers.forEach((f, i) => f.setAttribute("data-stage", String(Math.max(0, Math.min(2, steps - i * 2)))));
    const open = Math.floor(steps / 2);
    this.root.setAttribute("aria-label", `${open} of ${BLOOM.flowers} dandelions open`);
    this.root.dataset.steps = String(steps);
    return grew;
  }

  /** The finish: every flower turns to a seed puff. */
  puff(): void {
    this.steps = 99;
    this.flowers.forEach((f) => f.setAttribute("data-stage", "3"));
    this.root.setAttribute("aria-label", "All the dandelions have gone to seed");
    this.root.dataset.steps = "puff";
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
