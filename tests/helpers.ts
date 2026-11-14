import { expect, test as base, type APIRequestContext, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { bearingDeg, destination, distanceM, norm360, turn } from "../src/geo.ts";

/** A spot in Cubbon Park that plays Jacob's hiding place in every test. */
export const SPOT = { lat: 12.9763, lng: 77.5929 };

export interface Place {
  /** Compass bearing from the spot to this place. */
  bearing: number;
  metres: number;
  accuracy?: number;
}

export const at = (p: Place) => destination(SPOT, p.bearing, p.metres);
/** The bearing a guest standing at `p` must walk to reach the spot. */
export const bearingToSpot = (p: Place) => bearingDeg(at(p), SPOT);
export { bearingDeg, distanceM, norm360, turn };

interface PhoneOptions {
  viewport: { width: number; height: number } | null;
  userAgent: string | undefined;
  deviceScaleFactor: number | undefined;
  isMobile: boolean | undefined;
  hasTouch: boolean | undefined;
}

export class Guest {
  private nudge = 0;
  constructor(
    readonly page: Page,
    readonly context: BrowserContext,
  ) {}

  /** Moves the phone. Every call is a fresh reading (a few centimetres of jitter), like a real GPS fix. */
  async moveTo(p: Place): Promise<void> {
    this.nudge += 1;
    const pos = destination(at(p), 37 * this.nudge, 0.05);
    await this.context.setGeolocation({ latitude: pos.lat, longitude: pos.lng, accuracy: p.accuracy ?? 6 });
  }

  /** Turns the phone to a compass heading by sending the same sensor events an Android phone does. */
  async face(heading: number, ms = 700): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      await this.page.evaluate((h) => {
        const e = new Event("deviceorientationabsolute");
        Object.assign(e, { alpha: (360 - h) % 360, beta: 35, gamma: 0, absolute: true });
        window.dispatchEvent(e);
      }, heading);
      await this.page.waitForTimeout(50);
    }
  }

  async open(): Promise<void> {
    await this.page.goto("/");
  }

  /** Types a name and taps Start, then waits for the compass. */
  async start(name: string): Promise<void> {
    await this.page.fill("#name", name);
    await this.page.click("#start");
    await expect(this.page.locator("#app")).toHaveAttribute("data-screen", "looking", { timeout: 15_000 });
  }

  screen() {
    return this.page.locator("#app");
  }

  async expectScreen(name: string, timeout = 15_000): Promise<void> {
    await expect(this.screen()).toHaveAttribute("data-screen", name, { timeout });
  }

  /** Where the plane and the friend arrows currently point, clockwise from the top of the screen. */
  async compass(): Promise<{ plane: number | null; pins: Record<string, number>; names: Record<string, string> }> {
    return this.page.evaluate(() => {
      const view = (window as unknown as { __compass: { snapshot(): { plane: number | null; pins: Record<string, number> } } }).__compass;
      const names: Record<string, string> = {};
      for (const p of document.querySelectorAll<HTMLElement>(".pin")) names[p.title] = p.dataset.key!;
      return { ...view.snapshot(), names };
    });
  }

  /** Moves into the finish circle and stays there until the compass finishes by itself. */
  async arrive(bearing = 200): Promise<void> {
    await this.moveTo({ bearing, metres: 30 });
    await this.page.waitForTimeout(2300);
    await this.moveTo({ bearing, metres: 28 });
    await this.expectScreen("found");
  }
}

export class Game {
  constructor(
    private browser: Browser,
    private request: APIRequestContext,
    private phone: PhoneOptions,
    readonly ns: string,
  ) {}

  /** Calls the API directly, for quick set-up. */
  async api<T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown, _master = false): Promise<T> {
    const res = await this.request.fetch(`/api${path}`, {
      method,
      headers: { "x-ns": this.ns },
      data: body,
    });
    return (await res.json()) as T;
  }

  async publish(spot = SPOT, accuracy = 5): Promise<void> {
    await this.api("POST", "/master/target", { ...spot, accuracy }, true);
  }

  private async context(place: Place | null): Promise<BrowserContext> {
    const pos = place ? at(place) : null;
    return this.browser.newContext({
      ...this.phone,
      baseURL: "http://localhost:4174",
      extraHTTPHeaders: { "x-ns": this.ns },
      // Motion sensors are allowed by default on real phones (iPhones ask on a tap; see the iPhone test).
      ...(pos ? { permissions: ["geolocation", "accelerometer", "gyroscope", "magnetometer"], geolocation: { latitude: pos.lat, longitude: pos.lng, accuracy: place!.accuracy ?? 6 } } : {}),
    });
  }

  /** A guest's phone at a place. Pass null for a phone that refuses to share its location. */
  async guest(place: Place | null, setup?: (context: BrowserContext) => Promise<void>): Promise<Guest> {
    const context = await this.context(place);
    await setup?.(context);
    const page = await context.newPage();
    const guest = new Guest(page, context);
    await guest.open();
    return guest;
  }

  /** Jacob's phone, standing at the spot, with the master board open. */
  async master(place: Place = { bearing: 0, metres: 0, accuracy: 5 }): Promise<Guest> {
    const context = await this.context(place);
    const page = await context.newPage();
    await page.goto("/master.html");
    return new Guest(page, context);
  }
}

export const test = base.extend<{ game: Game }>({
  game: async ({ browser, request, viewport, userAgent, deviceScaleFactor, isMobile, hasTouch }, use, testInfo) => {
    const ns = `${testInfo.project.name}-${testInfo.testId}-${testInfo.retry}-${Date.now()}`;
    await use(new Game(browser, request, { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch }, ns));
    for (const c of browser.contexts()) await c.close();
  },
});
export { expect };
