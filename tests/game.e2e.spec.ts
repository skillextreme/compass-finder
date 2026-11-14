import { bloomSteps, formatDistance } from "../src/geo.ts";
import { SPOT, at, bearingDeg, bearingToSpot, distanceM, expect, norm360, test, turn, type Place } from "./helpers.ts";

const row = (name: string) => `.row:has(.row__name:text-is("${name}"))`;

test("a guest waits until Jacob marks his spot with Find me, then can start", async ({ game }) => {
  const guest = await game.guest({ bearing: 250, metres: 430 });
  await guest.expectScreen("waiting");
  await expect(guest.page.getByRole("heading", { level: 1 })).toHaveText("Jacob is still finding a spot");

  const jacob = await game.master();
  await expect(jacob.page.locator("#find-me")).toBeVisible();
  await expect(jacob.page.locator("#players")).toContainText("Mark your spot first");
  await jacob.page.click("#find-me");
  await expect(jacob.page.locator("#find-accuracy")).toHaveText("±5 m");
  await jacob.page.click("#mark");
  await expect(jacob.page.locator("#spot-set")).toContainText("Your spot is marked");
  await expect(jacob.page.locator("#spot-set")).toContainText("±5 m");

  // The waiting guest's page turns into the start screen by itself.
  await guest.expectScreen("start");
  const state = await game.api<{ target: { lat: number; lng: number } }>("GET", "/state");
  expect(distanceM(state.target, SPOT)).toBeLessThan(1);
});

test("opening the link adds nobody to the board; the row appears when the countdown ends", async ({ game }) => {
  await game.publish();
  const jacob = await game.master();
  const guest = await game.guest({ bearing: 250, metres: 430 });
  await guest.expectScreen("start");
  await jacob.page.waitForTimeout(3500);
  await expect(jacob.page.locator("#players")).toContainText("Nobody has started yet");
  expect((await game.api<{ rows: unknown[] }>("GET", "/master", undefined, true)).rows).toHaveLength(0);

  // No name, no start.
  await guest.page.click("#start");
  await expect(guest.page.locator("#name-error")).toContainText("Add your name");
  await guest.expectScreen("start");

  await guest.page.fill("#name", "Asha");
  await guest.page.click("#start");
  await guest.expectScreen("countdown");
  await expect(guest.page.locator(".count__label")).toHaveText("Ready, Asha?");
  // Still nobody on the board during the countdown.
  expect((await game.api<{ rows: unknown[] }>("GET", "/master", undefined, true)).rows).toHaveLength(0);
  await guest.expectScreen("looking");

  const looking = jacob.page.locator(row("Asha"));
  await expect(looking).toHaveAttribute("data-status", "looking");
  await expect(looking).toContainText("Looking for");
  await expect(looking).toContainText("started");
  await expect(looking).toContainText("430 m from your spot");
  await expect(jacob.page.locator("#n-looking b")).toHaveText("1");
  // No Stop button anywhere on the compass.
  await expect(guest.page.getByRole("button", { name: /stop/i })).toHaveCount(0);
});

/** A walk in from the metro side: along a path, round a fenced lawn (further away for a moment), then in. */
const METRO_WALK: Place[] = [
  { bearing: 262, metres: 700 },
  { bearing: 258, metres: 560 },
  { bearing: 250, metres: 420 },
  { bearing: 236, metres: 300 },
  { bearing: 215, metres: 330 }, // the detour: the path bends away
  { bearing: 205, metres: 240 },
  { bearing: 200, metres: 150 },
  { bearing: 200, metres: 80 },
  { bearing: 200, metres: 40 },
  { bearing: 200, metres: 18 },
  { bearing: 200, metres: 12 },
];
/** A second approach from the opposite park edge. */
const EAST_WALK: Place[] = [
  { bearing: 80, metres: 640 },
  { bearing: 70, metres: 380 },
  { bearing: 64, metres: 170 },
  { bearing: 60, metres: 55 },
  { bearing: 60, metres: 21 },
  { bearing: 60, metres: 11 },
];

for (const [label, walk] of [
  ["from the metro entrance", METRO_WALK],
  ["from the east edge", EAST_WALK],
] as const) {
  test(`walking in ${label}: plane, distance and flowers follow, and it finishes only inside 10 m`, async ({ game }) => {
    await game.publish();
    const guest = await game.guest(walk[0]);
    await guest.start("Asha");
    await expect(guest.page.locator("#cue")).toHaveText("Dandelions open as you get closer to Jacob");
    let lastSteps = -1;
    for (const [i, place] of walk.entries()) {
      await guest.moveTo(place);
      // Walk facing an arbitrary direction each step, so the plane has to do real work.
      const heading = (i * 77 + 15) % 360;
      await guest.face(heading);
      const d = distanceM(at(place), SPOT);
      await expect(guest.page.locator("#distance")).toHaveText(formatDistance(d));
      const want = norm360(bearingToSpot(place) - heading);
      const { plane } = await guest.compass();
      expect(plane, `plane at step ${i}`).not.toBeNull();
      expect(Math.abs(turn(plane!, want)), `plane angle at step ${i} (${place.metres} m)`).toBeLessThan(5);
      const steps = bloomSteps(d);
      await expect(guest.page.locator(".meadow")).toHaveAttribute("data-steps", String(steps));
      if (place.metres < (walk[i - 1]?.metres ?? Infinity)) expect(steps).toBeGreaterThanOrEqual(lastSteps);
      else expect(steps).toBeLessThanOrEqual(lastSteps); // the detour: flowers may close a little
      lastSteps = steps;
      await guest.expectScreen("looking");
    }
    // Hanging about just outside the circle never finishes.
    for (let i = 0; i < 3; i++) {
      await guest.moveTo({ ...walk.at(-1)! });
      await guest.page.waitForTimeout(1200);
    }
    await guest.expectScreen("looking");
    // One reading inside isn't enough by itself…
    const last = walk.at(-1)!;
    await guest.moveTo({ bearing: last.bearing, metres: 7 });
    await guest.page.waitForTimeout(600);
    await guest.expectScreen("looking");
    await expect(guest.page.locator("#distance")).toHaveText("7 m");
    // …a second one a moment later is.
    await guest.page.waitForTimeout(1800);
    await guest.moveTo({ bearing: last.bearing, metres: 6 });
    await guest.expectScreen("found");
    await expect(guest.page.getByRole("heading", { level: 1 })).toHaveText("You found Jacob!");
    await expect(guest.page.locator("#badge-first")).toHaveText("1st to arrive");
    await expect(guest.page.locator("#badge-fast")).toHaveText("1st fastest");
    await expect(guest.page.locator(".board__row.is-me .board__name")).toHaveText("Asha");
    const m = await game.api<{ rows: { status: string; method: string; startDistanceM: number }[] }>("GET", "/master", undefined, true);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0]).toMatchObject({ status: "found", method: "auto", startDistanceM: walk[0].metres });
  });
}

test("compass sensor: waits clearly when there is none, turns with the phone when there is", async ({ game }) => {
  await game.publish();
  const place = { bearing: 180, metres: 300 }; // due south of Jacob, so Jacob is due north
  const guest = await game.guest(place);
  await guest.start("Asha");
  // No sensor events yet: a clear waiting message, and the distance still works.
  await expect(guest.page.locator("#hint")).toContainText("Waking the compass");
  await expect(guest.page.locator(".compass")).toHaveClass(/is-seeking/);
  await expect(guest.page.locator("#distance")).toHaveText("300 m");
  await expect(guest.page.locator(".compass__jacob")).toHaveCSS("opacity", "0");

  for (const heading of [0, 90, 180, 270]) {
    await guest.face(heading);
    const { plane } = await guest.compass();
    // Jacob is north: facing east, the plane points left (270), and so on.
    expect(Math.abs(turn(plane!, norm360(0 - heading))), `facing ${heading}`).toBeLessThan(4);
  }
  await expect(guest.page.locator("#hint")).not.toContainText("Waking");
  await expect(guest.page.locator(".compass")).not.toHaveClass(/is-seeking/);
  await expect(guest.page.locator(".compass__jacob")).toHaveCSS("opacity", "1");
  // Facing Jacob lights the ring.
  await guest.face(1);
  await expect(guest.page.locator(".compass")).toHaveClass(/is-ahead/);
  await guest.face(120);
  await expect(guest.page.locator(".compass")).not.toHaveClass(/is-ahead/);
});

test("iPhone: motion access is asked for only on the Start tap; if refused, the plane follows the walk", async ({ game }) => {
  await game.publish();
  const stub = (answer: "granted" | "denied") => async (context: import("@playwright/test").BrowserContext) => {
    await context.addInitScript((a) => {
      const w = window as unknown as { __asked: number; DeviceOrientationEvent: { requestPermission?: () => Promise<string> } };
      w.__asked = 0;
      w.DeviceOrientationEvent.requestPermission = () => {
        w.__asked += 1;
        return Promise.resolve(a);
      };
    }, answer);
  };
  const asked = (g: { page: import("@playwright/test").Page }) => g.page.evaluate(() => (window as unknown as { __asked: number }).__asked);

  const yes = await game.guest({ bearing: 180, metres: 300 }, stub("granted"));
  await yes.expectScreen("start");
  await yes.page.fill("#name", "Asha");
  expect(await asked(yes)).toBe(0);
  await yes.page.click("#start");
  await yes.expectScreen("looking");
  expect(await asked(yes)).toBe(1);

  const no = await game.guest({ bearing: 180, metres: 300 }, stub("denied"));
  await no.start("Ben");
  expect(await asked(no)).toBe(1);
  await expect(no.page.locator("#hint")).toHaveText("Walk a few steps and the plane will turn with you.");
  // Walk due east for a bit: the plane works out the heading from the movement.
  await no.moveTo({ bearing: 176, metres: 300 });
  await no.moveTo({ bearing: 172, metres: 301 });
  await no.page.waitForTimeout(400);
  const here = { bearing: 172, metres: 301 };
  const course = bearingDeg(at({ bearing: 176, metres: 300 }), at(here));
  const { plane } = await no.compass();
  expect(plane).not.toBeNull();
  expect(Math.abs(turn(plane!, norm360(bearingToSpot(here) - course)))).toBeLessThan(6);
  await expect(no.page.locator("#hint")).toContainText("the plane turns as you walk");
});

test("location refused: a message the guest can act on, and no row on the board", async ({ game }) => {
  await game.publish();
  const guest = await game.guest(null);
  await guest.page.fill("#name", "Asha");
  await guest.page.click("#start");
  await guest.expectScreen("problem");
  await expect(guest.page.getByRole("heading", { level: 1 })).toHaveText("The compass needs your location");
  await expect(guest.page.locator(".steps li")).toHaveCount(3);
  await expect(guest.page.getByRole("button", { name: "Try again" })).toBeVisible();
  expect((await game.api<{ rows: unknown[] }>("GET", "/master", undefined, true)).rows).toHaveLength(0);
  // Allowing it and trying again carries on from where they were.
  await guest.context.grantPermissions(["geolocation", "accelerometer", "gyroscope", "magnetometer"]);
  await guest.context.setGeolocation({ latitude: at({ bearing: 10, metres: 200 }).lat, longitude: at({ bearing: 10, metres: 200 }).lng, accuracy: 8 });
  await guest.page.getByRole("button", { name: "Try again" }).click();
  await guest.expectScreen("looking");
  await expect(guest.page.locator("#distance")).toHaveText("200 m");
});

test("a vague reading shows a weak-signal message and can't finish the hunt", async ({ game }) => {
  await game.publish();
  const guest = await game.guest({ bearing: 90, metres: 200, accuracy: 100 });
  await guest.start("Asha");
  await guest.face(270);
  await expect(guest.page.locator("#hint")).toHaveText("Weak signal (±100 m). Open sky helps.");
  // Inside the circle according to the phone, but only to within 60 metres: not a finish.
  for (let i = 0; i < 4; i++) {
    await guest.moveTo({ bearing: 90, metres: 5, accuracy: 60 });
    await guest.page.waitForTimeout(1300);
  }
  await guest.expectScreen("looking");
  await guest.arrive(90);
});

test("Ask Jacob to confirm: request reaches the board, Jacob approves, both screens show the finish", async ({ game }) => {
  await game.publish();
  const jacob = await game.master();
  const guest = await game.guest({ bearing: 140, metres: 60 });
  await guest.start("Asha");
  const other = await game.guest({ bearing: 20, metres: 250 });
  await other.start("Ben");
  await guest.moveTo({ bearing: 140, metres: 15 });
  await guest.face(320);
  await expect(guest.page.locator("#hint")).toHaveText("Look up! Jacob is right here");
  await expect(guest.page.locator("#ask")).toHaveText("I'm with Jacob!");

  await guest.page.click("#ask");
  await expect(guest.page.getByRole("dialog")).toContainText("Tell him in person");
  const sentAt = Date.now();
  await guest.page.click("#ask-send");
  await expect(guest.page.locator("#ask-state")).toHaveAttribute("data-state", "pending");
  await expect(guest.page.getByRole("dialog")).toContainText("Jacob has your request");
  await guest.page.click(".sheet__close");
  await expect(guest.page.locator("#ask")).toHaveText("Waiting for Jacob…");

  // On Jacob's board the request is first in the list, above people who are still looking.
  const pending = jacob.page.locator(row("Asha"));
  await expect(pending).toHaveAttribute("data-status", "pending");
  await expect(jacob.page.locator(".rows > li").first()).toContainText("Asha");
  await expect(jacob.page.locator("#n-pending b")).toHaveText("1");
  await expect(jacob.page.locator(row("Ben"))).toHaveAttribute("data-status", "looking");

  // Jacob is busy for a few seconds before approving: the guest's time is the moment they asked.
  await jacob.page.waitForTimeout(4000);
  await pending.getByRole("button", { name: "Approve finish" }).click();
  await expect(jacob.page.locator(row("Asha"))).toHaveAttribute("data-status", "found");
  await expect(jacob.page.locator(row("Asha"))).toContainText("approved by you");
  await expect(jacob.page.locator("#n-pending b")).toHaveText("0");

  await guest.expectScreen("found");
  await expect(guest.page.locator("#found-saving")).toHaveText("Confirmed by Jacob in person");
  const m = await game.api<{ rows: { name: string; requestedAt: number; finishedAt: number; method: string }[] }>("GET", "/master", undefined, true);
  const asha = m.rows.find((r) => r.name === "Asha")!;
  expect(asha.method).toBe("approved");
  expect(asha.finishedAt).toBe(asha.requestedAt);
  expect(Math.abs(asha.finishedAt - sentAt)).toBeLessThan(2500);
  // The other guest is unaffected and sees one fewer searcher.
  await other.expectScreen("looking");
});

test("Jacob can approve straight from a Looking row after a confirmation step", async ({ game }) => {
  await game.publish();
  const jacob = await game.master();
  const guest = await game.guest({ bearing: 140, metres: 30 });
  await guest.start("Asha");
  const looking = jacob.page.locator(row("Asha"));
  await looking.getByRole("button", { name: "Seen them" }).click();
  await expect(jacob.page.getByRole("dialog")).toContainText("This ends Asha's hunt now");
  await jacob.page.getByRole("button", { name: "Not yet" }).click();
  await jacob.page.waitForTimeout(500);
  await guest.expectScreen("looking");
  await looking.getByRole("button", { name: "Seen them" }).click();
  await jacob.page.click("#approve-yes");
  await expect(jacob.page.locator(row("Asha"))).toHaveAttribute("data-status", "found");
  await guest.expectScreen("found");
  await expect(guest.page.locator("#found-saving")).toHaveText("Confirmed by Jacob in person");
});

test("a request that can't be sent says so and can be retried", async ({ game }) => {
  await game.publish();
  const jacob = await game.master();
  const guest = await game.guest({ bearing: 140, metres: 14 });
  await guest.start("Asha");
  await guest.context.setOffline(true);
  await guest.page.click("#ask");
  await guest.page.click("#ask-send");
  await expect(guest.page.locator("#ask-state")).toHaveAttribute("data-state", "failed");
  await expect(guest.page.getByRole("dialog")).toContainText("That didn't reach Jacob");
  await expect(guest.page.locator("#ask-send")).toHaveText("Try again");
  await expect(jacob.page.locator(row("Asha"))).toHaveAttribute("data-status", "looking");

  await guest.context.setOffline(false);
  await guest.page.click("#ask-send");
  await expect(guest.page.locator("#ask-state")).toHaveAttribute("data-state", "pending");
  await expect(jacob.page.locator(row("Asha"))).toHaveAttribute("data-status", "pending");
  // Tapping around again doesn't create a second request.
  await guest.page.click(".sheet__close");
  await guest.page.click("#ask");
  await expect(guest.page.locator("#ask-state")).toHaveAttribute("data-state", "pending");
  expect((await game.api<{ rows: unknown[] }>("GET", "/master", undefined, true)).rows).toHaveLength(1);
});

test("the compass finishing while a request is pending closes the request: one result, even if Jacob taps too", async ({ game }) => {
  await game.publish();
  const jacob = await game.master();
  const guest = await game.guest({ bearing: 140, metres: 14 });
  await guest.start("Asha");
  await guest.page.click("#ask");
  await guest.page.click("#ask-send");
  await expect(guest.page.locator("#ask-state")).toHaveAttribute("data-state", "pending");
  const approve = jacob.page.locator(`${row("Asha")} [data-approve]`);
  await expect(approve).toBeVisible();

  // The guest steps into the circle; at the same moment Jacob taps Approve (twice).
  await guest.moveTo({ bearing: 140, metres: 6 });
  await guest.page.waitForTimeout(2200);
  await Promise.all([guest.moveTo({ bearing: 140, metres: 5 }), approve.dblclick({ timeout: 5000 }).catch(() => {})]);
  await guest.expectScreen("found");
  await expect(jacob.page.locator(row("Asha"))).toHaveAttribute("data-status", "found");
  await expect(jacob.page.locator("#n-pending b")).toHaveText("0");
  await expect(jacob.page.locator(".rows > li")).toHaveCount(1);
  const m = await game.api<{ rows: { status: string }[]; boards: { first: unknown[]; fastest: unknown[] } }>("GET", "/master", undefined, true);
  expect(m.rows).toHaveLength(1);
  expect(m.boards.first).toHaveLength(1);
  expect(m.boards.fastest).toHaveLength(1);
  // Approving someone who has already finished is harmless and says so.
  const again = await game.api<{ already: boolean }>("POST", "/master/approve", { id: (m.rows[0] as unknown as { id: string }).id }, true);
  expect(again.already).toBe(true);
  await expect(guest.page.locator(".board__row")).toHaveCount(1);
});

test("no signal at the finish: found on the phone straight away, saved with its real time when back online", async ({ game }) => {
  await game.publish();
  const jacob = await game.master();
  const guest = await game.guest({ bearing: 200, metres: 40 });
  await guest.start("Asha");
  await guest.context.setOffline(true);
  // The compass keeps working with no connection.
  await guest.moveTo({ bearing: 200, metres: 25 });
  await guest.face(20);
  await expect(guest.page.locator("#distance")).toHaveText("25 m");
  await guest.arrive(200);
  await expect(guest.page.locator("#found-saving")).toHaveText("Saving your time… keep this page open");
  const shown = await guest.page.locator("#found-time").textContent();
  await expect(jacob.page.locator(row("Asha"))).toHaveAttribute("data-status", "looking");

  await guest.page.waitForTimeout(7000);
  await guest.context.setOffline(false);
  await expect(guest.page.locator("#found-saving")).toBeHidden({ timeout: 15_000 });
  await expect(jacob.page.locator(row("Asha"))).toHaveAttribute("data-status", "found");
  const m = await game.api<{ rows: { durationMs: number; finishedAt: number }[]; serverNow: number }>("GET", "/master", undefined, true);
  const [min, sec] = shown!.split(":").map(Number);
  // The saved time is the moment they arrived, not seven seconds later when the signal came back.
  expect(Math.abs(m.rows[0].durationMs / 1000 - (min * 60 + sec))).toBeLessThan(2);
  expect(m.serverNow - m.rows[0].finishedAt).toBeGreaterThan(6000);
  await expect(guest.page.locator("#found-time")).toHaveText(shown!);
});

test("no signal at the start: the hunt begins anyway and the row shows up later with the real start time", async ({ game }) => {
  await game.publish();
  const guest = await game.guest({ bearing: 200, metres: 300 });
  await guest.expectScreen("start");
  await guest.page.fill("#name", "Asha");
  await guest.context.setOffline(true);
  await guest.page.click("#start");
  await guest.expectScreen("looking");
  await guest.face(20);
  await expect(guest.page.locator("#distance")).toHaveText("300 m");
  await guest.page.waitForTimeout(5000);
  expect((await game.api<{ rows: unknown[] }>("GET", "/master", undefined, true)).rows).toHaveLength(0);
  await guest.context.setOffline(false);
  await expect.poll(async () => (await game.api<{ rows: unknown[] }>("GET", "/master", undefined, true)).rows.length, { timeout: 15_000 }).toBe(1);
  const m = await game.api<{ rows: { startedAt: number }[]; serverNow: number }>("GET", "/master", undefined, true);
  expect(m.serverNow - m.rows[0].startedAt).toBeGreaterThan(5000);
});

test("reloading mid-hunt resumes the same attempt with the timer still running; no second run", async ({ game }) => {
  await game.publish();
  const guest = await game.guest({ bearing: 200, metres: 300 });
  await guest.start("Asha");
  await guest.page.waitForTimeout(3000);
  await guest.page.reload();
  await guest.expectScreen("resume");
  await expect(guest.page.getByRole("heading", { level: 1 })).toHaveText("Welcome back, Asha");
  await guest.page.getByRole("button", { name: "Back to the compass" }).click();
  await guest.expectScreen("looking");
  await expect(guest.page.locator("#distance")).toHaveText("300 m");
  const [min, sec] = (await guest.page.locator("#timer").textContent())!.split(":").map(Number);
  expect(min * 60 + sec).toBeGreaterThanOrEqual(3);
  expect((await game.api<{ rows: unknown[] }>("GET", "/master", undefined, true)).rows).toHaveLength(1);

  await guest.arrive(200);
  // After finishing, opening the link again shows the result, not a new start.
  await guest.page.reload();
  await guest.expectScreen("found");
  await guest.page.goto("/");
  await guest.expectScreen("found");
  expect((await game.api<{ rows: unknown[] }>("GET", "/master", undefined, true)).rows).toHaveLength(1);
});

test("friends who are searching show as tiny arrows in the right directions, and leave when they finish", async ({ game }) => {
  await game.publish();
  const jacob = await game.master();
  const places = { Asha: { bearing: 250, metres: 400 }, Rohan: { bearing: 20, metres: 180 }, Meera: { bearing: 140, metres: 60 } };
  const asha = await game.guest(places.Asha);
  const rohan = await game.guest(places.Rohan);
  const meera = await game.guest(places.Meera);
  await Promise.all([asha.start("Asha"), rohan.start("Rohan"), meera.start("Meera")]);

  for (const [me, name] of [
    [asha, "Asha"],
    [rohan, "Rohan"],
    [meera, "Meera"],
  ] as const) {
    const others = Object.keys(places).filter((n) => n !== name) as (keyof typeof places)[];
    await expect(me.page.locator("#friends")).toHaveText("2 searching", { timeout: 15_000 });
    const heading = 33;
    await me.face(heading);
    await expect(me.page.locator(".pin")).toHaveCount(2);
    const c = await me.compass();
    // Never an arrow for yourself.
    expect(Object.keys(c.names).sort()).toEqual([...others].sort());
    for (const other of others) {
      const want = norm360(bearingDeg(at(places[name]), at(places[other])) - heading);
      // Positions are shared rounded to about 10 metres, so allow for that on the shorter hops.
      expect(Math.abs(turn(c.pins[c.names[other]], want)), `${name} sees ${other}`).toBeLessThan(10);
    }
  }
  // The list behind the chip names them, nearest first.
  await asha.page.click("#friends");
  await expect(asha.page.locator(".people li")).toHaveCount(2);
  await expect(asha.page.locator(".people li").first()).toContainText("Meera");
  await asha.page.click(".sheet__close");

  // Jacob's map has all three.
  await jacob.page.click("#tab-map");
  await expect(jacob.page.locator(".radar__dot")).toHaveCount(3);
  await expect(jacob.page.locator("#radar .people li").first()).toContainText("Meera");
  await expect(jacob.page.locator("#n-looking b")).toHaveText("3");

  // Meera finds Jacob: her arrow disappears from the others' compasses and from the radar.
  await meera.arrive(140);
  await expect(asha.page.locator("#toast")).toHaveText("🎉 Meera just found Jacob!", { timeout: 15_000 });
  await expect(asha.page.locator("#friends")).toHaveText("1 searching", { timeout: 15_000 });
  await expect(asha.page.locator(".pin")).toHaveCount(1);
  await asha.page.click("#friends");
  await expect(asha.page.locator("#already-found")).toHaveText("Already found Jacob: Meera");
  await asha.page.click(".sheet__close");
  await expect(rohan.page.locator(".pin")).toHaveCount(1);
  await expect(jacob.page.locator(".radar__dot")).toHaveCount(2);
  // Meera's results screen counts who is still out there.
  await expect(meera.page.locator("#found-still")).toHaveText("2 still searching…");
});

test("both leaderboards on the results screen: order, own row, start distance", async ({ game }) => {
  await game.publish();
  const slow = await game.guest({ bearing: 200, metres: 500 });
  await slow.start("Asha");
  await slow.page.waitForTimeout(4000);
  const quick = await game.guest({ bearing: 100, metres: 20 });
  await quick.start("Ben");
  await slow.arrive(200); // arrives first, but took longer
  await quick.arrive(100);

  await expect(quick.page.locator("#badge-first")).toHaveText("2nd to arrive");
  await expect(quick.page.locator("#badge-fast")).toHaveText("1st fastest");
  await expect(quick.page.locator(".board__row .board__name")).toHaveText(["Asha", "Ben"]);
  await quick.page.getByRole("tab", { name: "Fastest" }).click();
  await expect(quick.page.locator(".board__row .board__name")).toHaveText(["Ben", "Asha"]);
  await expect(quick.page.locator(".board__row.is-me")).toContainText("from 20 m away");
  await expect(quick.page.locator(".board__row").nth(1)).toContainText("from 500 m away");
  await expect(slow.page.locator("#badge-first")).toHaveText("1st to arrive", { timeout: 15_000 });
  await expect(slow.page.locator("#badge-fast")).toHaveText("2nd fastest", { timeout: 15_000 });
  await expect(quick.page.locator("#found-still")).toHaveText("Everyone who started has found him!");
});

test("master board: wrong key is refused; the spot stays put when Jacob walks; moving it needs Find me again", async ({ game }) => {
  const wrong = await game.master(undefined, "not-the-key");
  await expect(wrong.page.locator("#key-error")).toContainText("That key didn't match");
  await wrong.page.fill("#key", "dev-key");
  await wrong.page.getByRole("button", { name: "Open the board" }).click();
  await expect(wrong.page.locator("#find-me")).toBeVisible();
  // The key is kept out of the address bar.
  expect(wrong.page.url()).not.toContain("key=");

  const jacob = wrong;
  await jacob.page.click("#find-me");
  await jacob.page.click("#mark");
  await expect(jacob.page.locator("#spot-set")).toBeVisible();
  const first = (await game.api<{ target: { lat: number; lng: number; publishedAt: number } }>("GET", "/state")).target;
  expect(distanceM(first, SPOT)).toBeLessThan(1);

  // Jacob wanders off to greet people. The spot doesn't follow his phone.
  const guest = await game.guest({ bearing: 180, metres: 200 });
  await guest.start("Asha");
  await jacob.moveTo({ bearing: 45, metres: 120 });
  await jacob.page.waitForTimeout(4000);
  expect((await game.api<{ target: unknown }>("GET", "/state")).target).toEqual(first);
  await expect(guest.page.locator("#distance")).toHaveText("200 m");

  // Opening the Move sheet and closing it changes nothing.
  await jacob.page.click("#menu");
  await jacob.page.click("#menu-move");
  await expect(jacob.page.getByRole("dialog")).toContainText("Everyone's compass will swing round");
  await jacob.page.click(".sheet__close");
  expect((await game.api<{ target: unknown }>("GET", "/state")).target).toEqual(first);

  // Marking the new spot moves every compass, and the guest keeps their attempt.
  await jacob.page.click("#menu");
  await jacob.page.click("#menu-move");
  await jacob.page.click("#mark");
  await expect.poll(async () => distanceM((await game.api<{ target: { lat: number; lng: number } }>("GET", "/state")).target, at({ bearing: 45, metres: 120 }))).toBeLessThan(1);
  const expected = distanceM(at({ bearing: 180, metres: 200 }), at({ bearing: 45, metres: 120 }));
  await expect(guest.page.locator("#distance")).toHaveText(formatDistance(expected), { timeout: 15_000 });
  await guest.expectScreen("looking");
});

test("a fresh round after a practice run sends everyone back to the start with empty boards", async ({ game }) => {
  await game.publish();
  const jacob = await game.master();
  const done = await game.guest({ bearing: 200, metres: 30 });
  await done.start("Asha");
  await done.arrive(200);
  const looking = await game.guest({ bearing: 20, metres: 200 });
  await looking.start("Ben");
  await expect(jacob.page.locator(".rows > li")).toHaveCount(2);

  await jacob.page.click("#menu");
  await jacob.page.click("#menu-reset");
  await expect(jacob.page.getByRole("dialog")).toContainText("both leaderboards are wiped");
  await jacob.page.click("#reset-keep");
  await expect(jacob.page.locator("#players")).toContainText("Nobody has started yet");
  await expect(jacob.page.locator("#spot-set")).toBeVisible();

  await looking.expectScreen("start");
  await done.expectScreen("start", 20_000);
  // The name is remembered, so starting again is one tap.
  await expect(looking.page.locator("#name")).toHaveValue("Ben");
  await looking.page.click("#start");
  await looking.expectScreen("looking");
  await expect(jacob.page.locator(".rows > li")).toHaveCount(1);
});
