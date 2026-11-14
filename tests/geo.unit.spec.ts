import { expect, test } from "@playwright/test";
import { BLOOM, FINISH } from "../src/config.ts";
import { FinishGate, averageReadings, bearingDeg, bloom, bloomSteps, destination, distanceM, formatDistance, formatDuration, ordinal, relativeAngle, turn, type Reading } from "../src/geo.ts";
import { headingFromAngles } from "../src/heading.ts";

/** A point in Cubbon Park. */
const SPOT = { lat: 12.9763, lng: 77.5929 };

test("distance and bearing match known points", () => {
  for (const [bearing, metres] of [
    [0, 10],
    [90, 10],
    [225, 1000],
    [317, 430],
  ]) {
    const p = destination(SPOT, bearing, metres);
    expect(distanceM(SPOT, p)).toBeCloseTo(metres, 1);
    expect(Math.abs(turn(bearingDeg(SPOT, p), bearing))).toBeLessThan(0.5);
  }
  expect(distanceM(SPOT, SPOT)).toBe(0);
});

test("relative angle wraps and follows the screen's rotation", () => {
  expect(relativeAngle(350, 10)).toBe(-20);
  expect(relativeAngle(10, 350)).toBe(20);
  expect(relativeAngle(90, 90)).toBe(0);
  expect(relativeAngle(180, 0)).toBe(-180);
  expect(relativeAngle(90, 0, 90)).toBe(0);
});

test("phone angles turn into a compass heading, flat or held up", () => {
  // Flat on a palm: alpha runs anticlockwise from north.
  expect(headingFromAngles(0, 0, 0)).toBeCloseTo(0, 5);
  expect(headingFromAngles(90, 0, 0)).toBeCloseTo(270, 5);
  expect(headingFromAngles(270, 0, 0)).toBeCloseTo(90, 5);
  // Tilted towards the face, as people actually hold a phone: same heading.
  expect(headingFromAngles(330, 45, 0)).toBeCloseTo(30, 5);
  // Upright like a camera: the direction the back faces.
  expect(headingFromAngles(330, 88, 0)).toBeCloseTo(30, 5);
  // A little sideways roll doesn't throw it far.
  expect(Math.abs(turn(headingFromAngles(330, 40, 8)!, 30))).toBeLessThan(8);
});

test("flowers are closed at the park edge, open at the finish and never close as you approach", () => {
  expect(bloomSteps(BLOOM.farM)).toBe(0);
  expect(bloomSteps(5000)).toBe(0);
  expect(bloomSteps(FINISH.radiusM)).toBe(10);
  expect(bloomSteps(0)).toBe(10);
  expect(bloom(Number.NaN)).toBe(0);
  const seen = new Set<number>();
  let last = -1;
  for (let d = 900; d >= 0; d -= 1) {
    const s = bloomSteps(d);
    expect(s).toBeGreaterThanOrEqual(last);
    last = s;
    seen.add(s);
  }
  // Every step from all buds to all open is reachable on the walk in.
  expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // The last 100 metres still change the picture several times.
  expect(bloomSteps(60) - bloomSteps(200)).toBeGreaterThanOrEqual(4);
});

test("text formatting", () => {
  expect(formatDistance(1234)).toBe("1.2 km");
  expect(formatDistance(437)).toBe("440 m");
  expect(formatDistance(16.4)).toBe("16 m");
  expect(formatDuration(0)).toBe("0:00");
  expect(formatDuration(272_900)).toBe("4:32");
  expect(formatDuration(3_725_000)).toBe("1:02:05");
  expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)).toEqual(["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "101st", "111th"]);
});

const at = (metres: number, t: number, accuracy = 6, bearing = 200): Reading => ({ ...destination(SPOT, bearing, metres), accuracy, at: t });

test("finish needs two good readings inside the circle", () => {
  const g = new FinishGate();
  expect(g.offer(at(8, 1000), SPOT, 1000)).toBe("first");
  // Too soon after the first to count as a separate reading.
  expect(g.offer(at(8, 1500), SPOT, 1500)).toBe("waiting");
  expect(g.offer(at(9, 3100), SPOT, 3100)).toBe("finished");
});

test("one reading inside is never enough", () => {
  const g = new FinishGate();
  expect(g.offer(at(8, 1000), SPOT, 1000)).toBe("first");
  expect(g.offer(at(8, 1000), SPOT, 9000)).not.toBe("finished");
});

test("weak, stale and outside readings don't finish and start the count again", () => {
  const g = new FinishGate();
  expect(g.offer(at(8, 1000, 50), SPOT, 1000)).toBe("weak");
  expect(g.offer(at(8, 1000), SPOT, 16_000)).toBe("stale");
  expect(g.offer(at(58, 20_000), SPOT, 20_000)).toBe("outside");
  // Inside, then outside, then inside: the outside reading wipes the first one.
  expect(g.offer(at(9, 30_000), SPOT, 30_000)).toBe("first");
  expect(g.offer(at(58, 32_500), SPOT, 32_500)).toBe("outside");
  expect(g.offer(at(9, 35_000), SPOT, 35_000)).toBe("first");
  expect(g.offer(at(9, 37_500), SPOT, 37_500)).toBe("finished");
  // A first reading that is too old to pair with is replaced, not confirmed.
  const h = new FinishGate();
  expect(h.offer(at(5, 0), SPOT, 0)).toBe("first");
  expect(h.offer(at(5, 60_000), SPOT, 60_000)).toBe("first");
});

/** Deterministic random numbers so the simulation gives the same answer every run. */
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
function gaussian(rand: () => number): number {
  return Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
}

/**
 * Stands a guest at a true distance for a while with wandering GPS error (errors drift, as real ones do,
 * rather than jumping independently each second) and reports when, if ever, the gate lets them finish.
 */
function standFor(trueDistance: number, sigma: number, seconds: number, rand: () => number): number | null {
  const g = new FinishGate();
  let ex = gaussian(rand) * sigma;
  let ey = gaussian(rand) * sigma;
  const keep = 0.8;
  const fresh = Math.sqrt(1 - keep * keep) * sigma;
  for (let s = 0; s <= seconds; s++) {
    ex = ex * keep + gaussian(rand) * fresh;
    ey = ey * keep + gaussian(rand) * fresh;
    const base = destination(SPOT, 90, trueDistance);
    const noisy = destination(destination(base, 0, ey), 90, ex);
    if (g.offer({ ...noisy, accuracy: Math.max(4, sigma * 1.5), at: s * 1000 }, SPOT, s * 1000) === "finished") return s;
  }
  return null;
}

test("simulated walks: no early finish well outside the circle, quick finish next to Jacob", () => {
  const rand = rng(20261115);
  const runs = 1000;
  const rate = (distance: number, sigma: number) => {
    let n = 0;
    for (let i = 0; i < runs; i++) if (standFor(distance, sigma, 60, rand) !== null) n++;
    return n / runs;
  };
  const far = rate(75, 5);
  const edge = rate(62, 4);
  const near = rate(54, 4);
  const times: number[] = [];
  let never = 0;
  for (let i = 0; i < runs; i++) {
    const t = standFor(3, 6, 120, rand);
    if (t === null) never++;
    else times.push(t);
  }
  times.sort((a, b) => a - b);
  const median = times[Math.floor(times.length / 2)];
  const p90 = times[Math.floor(times.length * 0.9)];
  console.log(
    `finish gate: early finish in 60 s at 75 m ${(far * 100).toFixed(1)}%, at 62 m ${(edge * 100).toFixed(1)}%, at 54 m ${(near * 100).toFixed(1)}% | standing 3 m from Jacob: median ${median} s, 90% within ${p90} s, never in 2 min ${((never / runs) * 100).toFixed(1)}%`,
  );
  expect(far).toBeLessThan(0.005);
  expect(edge).toBeLessThan(0.05);
  expect(median).toBeLessThanOrEqual(8);
  expect(p90).toBeLessThanOrEqual(45);
});

test("Find me averages readings and trusts the accurate ones", () => {
  expect(averageReadings([])).toBeNull();
  const good = destination(SPOT, 0, 2);
  const wild = destination(SPOT, 90, 80);
  const avg = averageReadings([
    { ...good, accuracy: 5, at: 1 },
    { ...SPOT, accuracy: 6, at: 2 },
    { ...wild, accuracy: 60, at: 3 },
  ])!;
  expect(distanceM(avg, SPOT)).toBeLessThan(3);
  expect(avg.accuracy).toBe(5);
});
