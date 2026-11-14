import type { Page, TestInfo } from "@playwright/test";
import { expect, test } from "./helpers.ts";

/** Saves a screenshot per phone size so the screens can be looked at, not just measured. */
async function shot(page: Page, info: TestInfo, name: string): Promise<void> {
  await page.screenshot({ path: `shots/${info.project.name}/${name}.png` });
}

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

async function box(page: Page, selector: string): Promise<Box> {
  return page.locator(selector).first().evaluate((n) => {
    const r = n.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width, height: r.height };
  });
}

/** Nothing sticks out sideways, and every button, link and field is big enough for a thumb. */
async function expectPhoneFriendly(page: Page, label: string): Promise<void> {
  const report = await page.evaluate(() => {
    const small: string[] = [];
    for (const n of document.querySelectorAll<HTMLElement>("button, a, input")) {
      const r = n.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.width < 44 || r.height < 44) small.push(`${n.tagName}#${n.id}.${n.className} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return { small, overflowX: document.documentElement.scrollWidth - window.innerWidth };
  });
  expect(report.small, `${label}: tap targets under 44px`).toEqual([]);
  expect(report.overflowX, `${label}: sideways overflow`).toBeLessThanOrEqual(0);
}

async function expectCompassScreenFits(page: Page, label: string): Promise<void> {
  const vh = await page.evaluate(() => window.innerHeight);
  const vw = await page.evaluate(() => window.innerWidth);
  // One fixed screen: nothing to scroll.
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight - window.innerHeight), `${label}: vertical scroll`).toBeLessThanOrEqual(0);
  const top = await box(page, ".look__top");
  const compass = await box(page, ".compass");
  const distance = await box(page, "#distance");
  const hint = await box(page, "#hint");
  const meadow = await box(page, ".meadow");
  const chips = await box(page, ".look__chips");
  // Top bar, compass, distance, hint, flowers, chips: stacked in that order with no overlap.
  expect(compass.top, `${label}: compass under the top bar`).toBeGreaterThanOrEqual(top.bottom - 1);
  expect(distance.top, `${label}: distance under the compass`).toBeGreaterThanOrEqual(compass.bottom - 1);
  expect(hint.top).toBeGreaterThanOrEqual(distance.bottom - 1);
  expect(meadow.top, `${label}: flowers under the hint`).toBeGreaterThanOrEqual(hint.bottom - 1);
  expect(chips.top).toBeGreaterThanOrEqual(meadow.bottom - 3);
  expect(chips.bottom, `${label}: chips on screen`).toBeLessThanOrEqual(vh + 0.5);
  // The compass is the main thing on the screen and stays round.
  expect(compass.width, `${label}: compass size`).toBeGreaterThanOrEqual(Math.min(vw * 0.55, 200));
  expect(Math.abs(compass.width - compass.height)).toBeLessThan(1);
  expect(compass.left).toBeGreaterThanOrEqual(0);
  expect(compass.right).toBeLessThanOrEqual(vw);
  // The friend arrows sit just outside the ring but still on screen.
  for (const pin of await page.locator(".pin").all()) {
    const b = (await pin.boundingBox())!;
    expect(b.x, `${label}: arrow on screen`).toBeGreaterThanOrEqual(-1);
    expect(b.x + b.width).toBeLessThanOrEqual(vw + 1);
    expect(b.y).toBeGreaterThanOrEqual(top.top);
  }
}

test("every guest screen fits a phone: start, compass, sheets and results", async ({ game, viewport }, info) => {
  const jacob = await game.master();
  await expect(jacob.page.locator("#find-me")).toBeVisible();
  await expectPhoneFriendly(jacob.page, "master, no spot");
  await shot(jacob.page, info, "m1-no-spot");

  const guest = await game.guest({ bearing: 250, metres: 430 });
  await guest.expectScreen("waiting");
  await expectPhoneFriendly(guest.page, "waiting");
  await shot(guest.page, info, "g1-waiting");

  await jacob.page.click("#find-me");
  await expect(jacob.page.locator("#mark")).toBeEnabled();
  await expectPhoneFriendly(jacob.page, "find me sheet");
  await shot(jacob.page, info, "m2-find-me");
  await jacob.page.click("#mark");

  // Start: the name field and the Start button are on screen without scrolling.
  await guest.expectScreen("start");
  await guest.page.waitForTimeout(3600); // let the "Jacob is hidden" toast clear
  await expectPhoneFriendly(guest.page, "start");
  const start = await box(guest.page, "#start");
  expect(start.bottom, "Start button above the fold").toBeLessThanOrEqual(viewport!.height);
  await shot(guest.page, info, "g2-start");
  await guest.page.fill("#name", "Asha");
  await guest.page.click("#start");
  await guest.expectScreen("countdown");
  await shot(guest.page, info, "g3-countdown");
  await guest.expectScreen("looking");

  // Compass with no heading yet.
  await expectCompassScreenFits(guest.page, "looking, no heading");
  await shot(guest.page, info, "g4-compass-waking");

  // Three friends searching too.
  for (const [name, bearing, metres] of [
    ["Rohan", 20, 180],
    ["Meera", 140, 60],
    ["Zoya", 300, 320],
  ] as const) {
    const friend = await game.guest({ bearing, metres });
    await friend.start(name);
  }
  await expect(guest.page.locator("#friends")).toHaveText("3 searching", { timeout: 15_000 });
  await guest.moveTo({ bearing: 250, metres: 428 });
  await guest.face(40);
  await expect(guest.page.locator(".pin")).toHaveCount(3);
  await expectCompassScreenFits(guest.page, "looking, far");
  await expectPhoneFriendly(guest.page, "looking");
  await shot(guest.page, info, "g5-compass-far");

  // Home screen stays simple: only these things are showing, and no leaderboard exists yet.
  await expect(guest.page.locator(".board")).toHaveCount(0);
  await expect(guest.page.getByText(/leaderboard|fastest|first to arrive/i)).toHaveCount(0);
  const visible = await guest.page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>(".look > *, .look__top > *, .look__ground > *, .look__chips > *, .readout > *")]
      .filter((n) => n.offsetParent !== null && n.getBoundingClientRect().height > 0)
      .map((n) => n.id || n.className.split(" ")[0]),
  );
  expect(visible.sort()).toEqual(["ask", "cue", "distance", "friends", "hint", "info", "look__chips", "look__compass", "look__ground", "look__top", "meadow", "readout", "timer"].sort());

  await guest.page.click("#friends");
  await expect(guest.page.locator(".people li")).toHaveCount(3);
  await guest.page.waitForTimeout(300);
  await expectPhoneFriendly(guest.page, "friends sheet");
  await shot(guest.page, info, "g6-friends-sheet");
  await guest.page.click(".sheet__close");
  await guest.page.click("#info");
  await guest.page.waitForTimeout(300);
  await expectPhoneFriendly(guest.page, "info sheet");
  await shot(guest.page, info, "g7-info-sheet");
  await guest.page.click(".sheet__close");

  await guest.moveTo({ bearing: 250, metres: 90 });
  await guest.face(68);
  await expectCompassScreenFits(guest.page, "looking, 90 m");
  await shot(guest.page, info, "g8-compass-90m");

  // The same screen with the browser's bars taking space (a shorter window).
  await guest.page.setViewportSize({ width: viewport!.width, height: Math.min(viewport!.height, 560) - 40 });
  await guest.page.waitForTimeout(200);
  await guest.face(68, 300);
  await expectCompassScreenFits(guest.page, "looking, short window");
  await shot(guest.page, info, "g9-compass-short-window");
  await guest.page.setViewportSize(viewport!);

  await guest.moveTo({ bearing: 250, metres: 16 });
  await guest.face(70);
  await expectCompassScreenFits(guest.page, "looking, 16 m");
  await shot(guest.page, info, "g10-compass-16m");
  await guest.page.click("#ask");
  await guest.page.waitForTimeout(300);
  await expectPhoneFriendly(guest.page, "ask sheet");
  await shot(guest.page, info, "g11-ask-sheet");
  await guest.page.click("#ask-send");
  await expect(guest.page.locator("#ask-state")).toHaveAttribute("data-state", "pending");
  await shot(guest.page, info, "g12-ask-pending");
  await guest.page.click(".sheet__close");

  await expect(jacob.page.locator('.row[data-status="pending"]')).toHaveCount(1);
  // The request Jacob needs to act on is on screen without scrolling.
  expect((await box(jacob.page, '.row[data-status="pending"] [data-approve]')).bottom, "Approve button above the fold").toBeLessThanOrEqual(viewport!.height);
  await jacob.page.waitForTimeout(3300); // toast clears
  await expectPhoneFriendly(jacob.page, "master, pending");
  await shot(jacob.page, info, "m3-pending");
  await jacob.page.locator('.row[data-status="pending"] [data-approve]').click();

  await guest.expectScreen("found");
  await expect(guest.page.locator(".board__row.is-me")).toBeVisible();
  await guest.page.waitForTimeout(1800);
  await expectPhoneFriendly(guest.page, "found");
  await shot(guest.page, info, "g13-found");
  await guest.page.getByRole("tab", { name: "Fastest" }).click();
  await shot(guest.page, info, "g14-found-fastest");

  await jacob.page.waitForTimeout(3300);
  await shot(jacob.page, info, "m4-board");
  await jacob.page.click("#tab-map");
  await expect(jacob.page.locator(".radar__dot")).toHaveCount(3);
  await expectPhoneFriendly(jacob.page, "master map");
  await shot(jacob.page, info, "m4b-map");
  await jacob.page.click("#tab-boards");
  await expectPhoneFriendly(jacob.page, "master leaderboards");
  await shot(jacob.page, info, "m5-leaderboards");
  await jacob.page.click("#menu");
  await jacob.page.waitForTimeout(300);
  await expectPhoneFriendly(jacob.page, "master menu");
  await shot(jacob.page, info, "m6-menu");
});
