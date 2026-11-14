import { expect, test } from "@playwright/test";
import { BOARD_CACHE_MS, memoryKV, publicKey, route, sha256, type KV, type Reply } from "../netlify/lib/core.ts";
import { LIMITS, type Boards, type MasterState, type PingReply } from "../src/config.ts";
import { destination } from "../src/geo.ts";

BOARD_CACHE_MS.value = 0;

const SPOT = { lat: 12.9763, lng: 77.5929 };
const T0 = 1_800_000_000_000;
const id = (n: number) => `${String(n).repeat(8)}-1111-4111-8111-111111111111`;
const token = (n: number) => String(n).repeat(64);
const who = (n: number) => ({ id: id(n), token: token(n) });
const near = (metres: number, bearing = 120) => destination(SPOT, bearing, metres);

type Store = KV & { data: Map<string, unknown> };

const call = (kv: Store, method: string, path: string, body: unknown, now: number, _unused: null = null, ip = "1.1.1.1"): Promise<Reply> =>
  route({ method, path, body, ip }, kv, { now });
const guest = (kv: Store, path: string, body: unknown, now: number) => call(kv, "POST", path, body, now);
const host = (kv: Store, method: string, path: string, body: unknown, now: number) => call(kv, method, path, body, now);

async function published(): Promise<Store> {
  const kv = memoryKV();
  expect((await host(kv, "POST", "/master/target", { ...SPOT, accuracy: 6 }, T0)).status).toBe(200);
  return kv;
}
async function started(kv: Store, n: number, name: string, now: number, metres = 400): Promise<void> {
  const r = await guest(kv, "/start", { ...who(n), name, ageMs: 0, ...near(metres) }, now);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
const master = async (kv: Store, now: number) => (await host(kv, "GET", "/master", null, now)).body as unknown as MasterState;
const boards = async (kv: Store, now: number) => ((await call(kv, "GET", "/board", null, now)).body as { boards: Boards }).boards;
const count = (kv: Store, part: string) => [...kv.data.keys()].filter((k) => k.includes(part)).length;

test("before Jacob marks a spot there is no target and nobody can start", async () => {
  const kv = memoryKV();
  const s = await call(kv, "GET", "/state", null, T0);
  expect(s.body).toMatchObject({ ok: true, round: 1, target: null, serverNow: T0 });
  expect((await guest(kv, "/start", { ...who(1), name: "Asha", ageMs: 0 }, T0)).body).toEqual({ error: "not_published" });
  expect((await guest(kv, "/ping", who(1), T0)).status).toBe(404);
  expect(kv.data.size).toBe(0);
});

test("opening the link writes nothing; a start creates exactly one row", async () => {
  const kv = await published();
  const before = kv.data.size;
  await call(kv, "GET", "/state", null, T0 + 1);
  await call(kv, "GET", "/board", null, T0 + 1);
  expect(kv.data.size).toBe(before);
  expect((await master(kv, T0 + 2)).rows).toEqual([]);

  await started(kv, 1, "  Asha   Rao ", T0 + 5000, 430);
  const rows = (await master(kv, T0 + 6000)).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ name: "Asha Rao", status: "looking", startedAt: T0 + 5000, startDistanceM: 430, requestedAt: null, finishedAt: null });
});

test("the start is idempotent, keeps its first time, and rejects a wrong token", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0 + 1000);
  // Retry and double tap: same id and token.
  const again = await Promise.all([guest(kv, "/start", { ...who(1), name: "Asha", ageMs: 0 }, T0 + 9000), guest(kv, "/start", { ...who(1), name: "Asha", ageMs: 0 }, T0 + 9001)]);
  for (const r of again) expect(r.body).toMatchObject({ ok: true, startedAt: T0 + 1000, status: "looking" });
  expect(count(kv, "/attempts/")).toBe(1);
  expect((await guest(kv, "/start", { id: id(1), token: token(2), name: "Mallory", ageMs: 0 }, T0 + 9500)).status).toBe(403);
  expect((await guest(kv, "/ping", { id: id(1), token: token(2) }, T0 + 9500)).status).toBe(403);
  expect((await guest(kv, "/finish", { id: id(1), token: token(2), ...near(3), accuracy: 5, ageMs: 0 }, T0 + 9500)).status).toBe(403);
});

test("a start sent late (no signal at the countdown) keeps the real start time", async () => {
  const kv = await published();
  const r = await guest(kv, "/start", { ...who(1), name: "Asha", ageMs: 42_000 }, T0 + 60_000);
  expect(r.body).toMatchObject({ startedAt: T0 + 18_000 });
  // Nonsense ages are ignored rather than trusted.
  const r2 = await guest(kv, "/start", { ...who(2), name: "Ben", ageMs: -5000 }, T0 + 60_000);
  expect(r2.body).toMatchObject({ startedAt: T0 + 60_000 });
});

test("two guests with the same name stay separate", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0 + 1000);
  await started(kv, 2, "Asha", T0 + 2000);
  const rows = (await master(kv, T0 + 3000)).rows;
  expect(rows.map((r) => r.name)).toEqual(["Asha", "Asha"]);
  expect(new Set(rows.map((r) => r.id)).size).toBe(2);
});

test("names are cleaned and bounded; bad input is refused", async () => {
  const kv = await published();
  for (const name of ["", "   ", "x".repeat(LIMITS.nameMax + 1), 42, null]) {
    expect((await guest(kv, "/start", { ...who(1), name, ageMs: 0 }, T0)).body).toEqual({ error: "invalid_name" });
  }
  await guest(kv, "/start", { ...who(1), name: "<b>Zo\u0000ya</b>", ageMs: 0 }, T0);
  expect((await master(kv, T0)).rows[0].name).toBe("b Zo ya /b");
  expect((await guest(kv, "/start", { id: "nope", token: token(1), name: "A" }, T0)).body).toEqual({ error: "invalid_id" });
  expect((await guest(kv, "/start", { id: id(3), token: "short", name: "A" }, T0)).body).toEqual({ error: "invalid_token_format" });
  expect((await guest(kv, "/start", null, T0)).status).toBe(400);
});

test("a finish is checked by the server: too far or too vague is refused", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0);
  expect((await guest(kv, "/finish", { ...who(1), ...near(90), accuracy: 5, ageMs: 0 }, T0 + 60_000)).body).toEqual({ error: "too_far" });
  expect((await guest(kv, "/finish", { ...who(1), ...near(53), accuracy: 5, ageMs: 0 }, T0 + 60_000)).body).toEqual({ error: "too_far" });
  expect((await guest(kv, "/finish", { ...who(1), ...near(4), accuracy: 40, ageMs: 0 }, T0 + 60_000)).body).toEqual({ error: "weak_reading" });
  expect((await guest(kv, "/finish", { ...who(1), accuracy: 5, ageMs: 0 }, T0 + 60_000)).body).toEqual({ error: "invalid_position" });
  expect(count(kv, "/finishes/")).toBe(0);
  const ok = await guest(kv, "/finish", { ...who(1), ...near(8), accuracy: 5, ageMs: 0 }, T0 + 90_000);
  expect(ok.body).toMatchObject({ ok: true, status: "found", result: { method: "auto", finishedAt: T0 + 90_000, durationMs: 90_000 } });
  expect((await master(kv, T0 + 91_000)).rows[0]).toMatchObject({ status: "found", method: "auto", durationMs: 90_000 });
});

test("a finish sent late keeps the reading's own time, clamped to sensible bounds", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0);
  // Reached Jacob at +5 min with no signal; the phone got through two minutes later.
  const late = await guest(kv, "/finish", { ...who(1), ...near(5), accuracy: 6, ageMs: 120_000 }, T0 + 420_000);
  expect(late.body).toMatchObject({ result: { finishedAt: T0 + 300_000, durationMs: 300_000 } });

  await started(kv, 2, "Ben", T0 + 10_000);
  // A reading claimed to be older than the start can't finish before the start.
  const early = await guest(kv, "/finish", { ...who(2), ...near(5), accuracy: 6, ageMs: 9_999_999 }, T0 + 20_000);
  expect(early.body).toMatchObject({ result: { finishedAt: T0 + 10_000, durationMs: 0 } });

  await started(kv, 3, "Cy", T0 + 10_000);
  // A reading from the future counts as now.
  const future = await guest(kv, "/finish", { ...who(3), ...near(5), accuracy: 6, ageMs: -60_000 }, T0 + 30_000);
  expect(future.body).toMatchObject({ result: { finishedAt: T0 + 30_000 } });
});

test("Ask Jacob: the first request time sticks, retries change nothing, approval uses that time", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0);
  const first = await guest(kv, "/request", who(1), T0 + 200_000);
  expect(first.body).toMatchObject({ ok: true, status: "pending", result: null });
  await Promise.all([guest(kv, "/request", who(1), T0 + 230_000), guest(kv, "/request", who(1), T0 + 231_000)]);
  expect(count(kv, "/requests/")).toBe(1);
  const m = await master(kv, T0 + 240_000);
  expect(m.rows[0]).toMatchObject({ status: "pending", requestedAt: T0 + 200_000 });

  // Jacob is busy greeting people and approves two minutes later: the guest isn't penalised.
  const a = await host(kv, "POST", "/master/approve", { id: id(1) }, T0 + 320_000);
  expect(a.body).toMatchObject({ ok: true, already: false, result: { method: "approved", finishedAt: T0 + 200_000, durationMs: 200_000 } });
  expect((await guest(kv, "/ping", who(1), T0 + 321_000)).body).toMatchObject({ status: "found", result: { method: "approved", durationMs: 200_000 } });
  // Asking again after being found is a harmless no-op.
  expect((await guest(kv, "/request", who(1), T0 + 330_000)).body).toMatchObject({ status: "found" });
});

test("Jacob can approve straight from a Looking row; that uses the approval time", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0);
  const a = await host(kv, "POST", "/master/approve", { id: id(1) }, T0 + 75_000);
  expect(a.body).toMatchObject({ already: false, result: { method: "approved", finishedAt: T0 + 75_000, durationMs: 75_000 } });
  expect((await host(kv, "POST", "/master/approve", { id: id(9) }, T0)).status).toBe(404);
  expect((await host(kv, "POST", "/master/approve", { id: "x" }, T0)).status).toBe(400);
});

test("races leave exactly one result: compass vs approval, double approval, retries", async () => {
  for (let round = 0; round < 25; round++) {
    const kv = await published();
    await started(kv, 1, "Asha", T0);
    await guest(kv, "/request", who(1), T0 + 100_000);
    const fin = () => guest(kv, "/finish", { ...who(1), ...near(6), accuracy: 5, ageMs: 0 }, T0 + 130_000);
    const app = () => host(kv, "POST", "/master/approve", { id: id(1) }, T0 + 131_000);
    const req = () => guest(kv, "/request", who(1), T0 + 132_000);
    // Shuffle the order each round so both winners get exercised.
    const calls = [fin, app, app, req, req, req, fin].sort(() => (round % 2 ? 1 : -1));
    const replies = await Promise.all(calls.map((c) => c()));
    for (const r of replies) expect(r.status).toBe(200);
    expect(count(kv, "/finishes/")).toBe(1);

    const results = replies.map((r) => r.body.result as { method: string; finishedAt: number } | undefined).filter(Boolean);
    // Everyone is told the same stored result, whoever won.
    expect(new Set(results.map((r) => `${r!.method}:${r!.finishedAt}`)).size).toBe(1);
    const b = await boards(kv, T0 + 140_000);
    expect(b.first).toHaveLength(1);
    expect(b.fastest).toHaveLength(1);
    expect(b.searching).toBe(0);
    const m = await master(kv, T0 + 140_000);
    expect(m.rows).toHaveLength(1);
    expect(m.rows[0].status).toBe("found");
    // The pending request is closed by the finish: it no longer shows as waiting.
    expect(m.rows.filter((r) => r.status === "pending")).toHaveLength(0);
  }
});

test("when approval wins, the approved result is kept and a later compass finish doesn't replace it", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0);
  await host(kv, "POST", "/master/approve", { id: id(1) }, T0 + 50_000);
  const later = await guest(kv, "/finish", { ...who(1), ...near(3), accuracy: 5, ageMs: 0 }, T0 + 60_000);
  expect(later.body).toMatchObject({ status: "found", result: { method: "approved", finishedAt: T0 + 50_000 } });
  const second = await host(kv, "POST", "/master/approve", { id: id(1) }, T0 + 70_000);
  expect(second.body).toMatchObject({ already: true, result: { method: "approved", finishedAt: T0 + 50_000 } });
});

test("both rankings: first to arrive by finish time, fastest by own time, ties share a rank", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0, 600); // arrives 1st, slow: 300 s
  await started(kv, 2, "Ben", T0 + 200_000, 80); // arrives 2nd, fastest: 110 s
  await started(kv, 3, "Cy", T0 + 100_000, 300); // arrives 3rd: 300 s (ties Asha on time)
  await started(kv, 4, "Dee", T0 + 50_000, 300); // still looking
  const fin = (n: number, at: number) => guest(kv, "/finish", { ...who(n), ...near(5), accuracy: 5, ageMs: 0 }, at);
  await fin(1, T0 + 300_000);
  await fin(2, T0 + 310_000);
  await fin(3, T0 + 400_000);
  const b = await boards(kv, T0 + 500_000);
  expect(b.first.map((r) => [r.rank, r.name])).toEqual([
    [1, "Asha"],
    [2, "Ben"],
    [3, "Cy"],
  ]);
  expect(b.fastest.map((r) => [r.rank, r.name, r.durationMs, r.startDistanceM])).toEqual([
    [1, "Ben", 110_000, 80],
    [2, "Asha", 300_000, 600],
    [2, "Cy", 300_000, 300],
  ]);
  expect(b.searching).toBe(1);
  // The master list: looking first, then finishers in arrival order.
  expect((await master(kv, T0 + 500_000)).rows.map((r) => r.name)).toEqual(["Dee", "Asha", "Ben", "Cy"]);
});

test("the master list puts people waiting for Jacob on top, oldest request first", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0);
  await started(kv, 2, "Ben", T0 + 1000);
  await started(kv, 3, "Cy", T0 + 2000);
  await started(kv, 4, "Dee", T0 + 3000);
  await guest(kv, "/request", who(4), T0 + 60_000);
  await guest(kv, "/request", who(2), T0 + 50_000);
  await guest(kv, "/finish", { ...who(1), ...near(5), accuracy: 5, ageMs: 0 }, T0 + 70_000);
  const rows = (await master(kv, T0 + 80_000)).rows;
  expect(rows.map((r) => `${r.name}:${r.status}`)).toEqual(["Ben:pending", "Dee:pending", "Cy:looking", "Asha:found"]);
});

test("searchers see each other, never themselves, and not finished or silent guests", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0, 400);
  await started(kv, 2, "Ben", T0, 200);
  await started(kv, 3, "Cy", T0, 100);
  const ping = async (n: number, metres: number, now: number) => (await guest(kv, "/ping", { ...who(n), ...near(metres, 40 * n) }, now)).body as unknown as PingReply;

  await ping(2, 190, T0 + 5000);
  await ping(3, 90, T0 + 5000);
  const a = await ping(1, 380, T0 + 6000);
  expect(a.status).toBe("looking");
  expect(a.searchers.map((s) => s.name).sort()).toEqual(["Ben", "Cy"]);
  expect(a.searchers.map((s) => s.k)).not.toContain(publicKey(id(1)));
  // Positions are rounded (about 10 m) and carry no ids or tokens.
  const text = JSON.stringify(a);
  expect(text).not.toContain(id(2));
  expect(text).not.toContain(token(2));
  for (const s of a.searchers) expect(String(s.lat).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);

  // Cy finishes: gone from everyone's compass straight away.
  await guest(kv, "/finish", { ...who(3), ...near(5), accuracy: 5, ageMs: 0 }, T0 + 10_000);
  expect((await ping(1, 370, T0 + 11_000)).searchers.map((s) => s.name)).toEqual(["Ben"]);
  // A finished guest's own pings don't put them back.
  const c = await ping(3, 5, T0 + 12_000);
  expect(c.status).toBe("found");
  expect((await ping(1, 360, T0 + 14_000)).searchers.map((s) => s.name)).toEqual(["Ben"]);

  // Ben's phone goes quiet: after a minute he drops off.
  const later = await ping(1, 300, T0 + 5000 + LIMITS.searcherStaleMs + 1000);
  expect(later.searchers).toEqual([]);
  // The master still has Ben's last known position, marked as old.
  const m = await master(kv, T0 + 5000 + LIMITS.searcherStaleMs + 1000);
  expect(m.rows.find((r) => r.name === "Ben")!.pos!.age).toBeGreaterThan(LIMITS.searcherStaleMs);
  expect(m.rows.find((r) => r.name === "Cy")!.pos).toBeNull();
});

test("positions are stored at most every couple of seconds per guest", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0, 400);
  await started(kv, 2, "Ben", T0, 300);
  const seenByBen = async (now: number) => ((await guest(kv, "/ping", who(2), now)).body as unknown as PingReply).searchers[0];
  await guest(kv, "/ping", { ...who(1), ...near(300) }, T0 + 500); // too soon after the start: ignored
  expect((await seenByBen(T0 + 600)).lat).toBeCloseTo(near(400).lat, 4);
  await guest(kv, "/ping", { ...who(1), ...near(300) }, T0 + LIMITS.pingMinMs + 10);
  expect((await seenByBen(T0 + LIMITS.pingMinMs + 20)).lat).toBeCloseTo(near(300).lat, 4);
});

test("the master board has no key; guests' private tokens still never leak", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0);
  // Open by design: the board is a page nobody else is told about.
  expect((await call(kv, "GET", "/master", null, T0)).status).toBe(200);

  // Only a hash of the token is stored, and no reply carries it.
  const stored = JSON.stringify([...kv.data.values()]);
  expect(stored).not.toContain(token(1));
  expect(stored).toContain(sha256(token(1)));
  for (const r of [await call(kv, "GET", "/state", null, T0), await call(kv, "GET", "/board", null, T0), await host(kv, "GET", "/master", null, T0), await guest(kv, "/ping", who(1), T0)]) {
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(token(1));
    expect(text).not.toContain(sha256(token(1)));
  }
  expect((await call(kv, "GET", "/nope", null, T0)).status).toBe(404);
  expect((await call(kv, "DELETE", "/state", null, T0)).status).toBe(405);
});

test("the spot stays fixed until Jacob marks a new one; bad positions are refused", async () => {
  const kv = await published();
  const before = ((await call(kv, "GET", "/state", null, T0 + 1)).body as { target: unknown }).target;
  await started(kv, 1, "Asha", T0 + 10);
  await guest(kv, "/ping", { ...who(1), ...near(200) }, T0 + 5000);
  await host(kv, "GET", "/master", null, T0 + 6000);
  expect(((await call(kv, "GET", "/state", null, T0 + 7000)).body as { target: unknown }).target).toEqual(before);
  for (const bad of [{}, { lat: 91, lng: 0 }, { lat: "12", lng: 77 }, { lat: Number.NaN, lng: 77 }]) {
    expect((await host(kv, "POST", "/master/target", bad, T0 + 8000)).status).toBe(400);
  }
  const moved = near(150, 10);
  await host(kv, "POST", "/master/target", { ...moved, accuracy: 4.26 }, T0 + 9000);
  const s = (await call(kv, "GET", "/state", null, T0 + 9500)).body as { round: number; target: { lat: number; accuracy: number; publishedAt: number } };
  expect(s.target).toMatchObject({ lat: moved.lat, accuracy: 4.3, publishedAt: T0 + 9000 });
  // Moving the spot keeps everyone's attempts.
  expect(s.round).toBe(1);
  expect((await master(kv, T0 + 9600)).rows).toHaveLength(1);
});

test("a fresh round clears players and boards; old attempts no longer work", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0);
  await guest(kv, "/finish", { ...who(1), ...near(5), accuracy: 5, ageMs: 0 }, T0 + 60_000);
  await started(kv, 2, "Ben", T0);
  const r = await host(kv, "POST", "/master/reset", { keepTarget: true }, T0 + 70_000);
  expect(r.body).toMatchObject({ round: 2, target: { lat: SPOT.lat } });
  const m = await master(kv, T0 + 71_000);
  expect(m.rows).toEqual([]);
  expect(m.boards).toEqual({ first: [], fastest: [], searching: 0 });
  expect((await guest(kv, "/ping", who(2), T0 + 72_000)).body).toEqual({ error: "unknown_attempt" });
  // A phone still on the old round is told so when it tries to start.
  expect((await guest(kv, "/start", { ...who(3), name: "Cy", round: 1, ageMs: 0 }, T0 + 73_000)).body).toEqual({ error: "round_changed" });
  await started(kv, 1, "Asha", T0 + 80_000);
  expect((await master(kv, T0 + 81_000)).rows).toHaveLength(1);
  const cleared = await host(kv, "POST", "/master/reset", {}, T0 + 90_000);
  expect(cleared.body).toMatchObject({ round: 3, target: null });
});

test("one address can't flood the board with starts", async () => {
  const kv = await published();
  let blocked = 0;
  // Phone networks put many people behind one address, so the limit is generous: 80 starts per 10 minutes.
  for (let i = 0; i < 100; i++) {
    const n = String(i).padStart(8, "0");
    const r = await call(kv, "POST", "/start", { id: `${n}-2222-4222-8222-222222222222`, token: token(1), name: `G${i}`, ageMs: 0 }, T0 + i, null, "9.9.9.9");
    if (r.status === 429) blocked++;
  }
  expect(blocked).toBe(20);
  expect((await master(kv, T0 + 100)).rows).toHaveLength(80);
  // A different address (another phone network) is unaffected.
  await started(kv, 5, "Eve", T0 + 200);
});

test("thirty guests at once: every start lands and every finisher has one result", async () => {
  const kv = await published();
  const ids = Array.from({ length: 30 }, (_, i) => ({ id: `${String(i).padStart(8, "0")}-3333-4333-8333-333333333333`, token: token(3) }));
  await Promise.all(ids.map((w, i) => call(kv, "POST", "/start", { ...w, name: `Guest ${i}`, ageMs: 0, ...near(300 + i) }, T0 + i, null, `ip-${i % 8}`)));
  await Promise.all(ids.map((w, i) => guest(kv, "/ping", { ...w, ...near(200 + i, i * 12) }, T0 + 5000 + i)));
  const m1 = await master(kv, T0 + 6000);
  expect(m1.rows).toHaveLength(30);
  expect(m1.rows.filter((r) => r.pos).length).toBe(30);
  await Promise.all([
    ...ids.slice(0, 10).map((w) => guest(kv, "/request", w, T0 + 50_000)),
    ...ids.slice(0, 20).flatMap((w, i) => [
      guest(kv, "/finish", { ...w, ...near(4), accuracy: 5, ageMs: 0 }, T0 + 60_000 + i),
      host(kv, "POST", "/master/approve", { id: w.id }, T0 + 60_000 + i),
    ]),
  ]);
  const m2 = await master(kv, T0 + 70_000);
  expect(m2.rows.filter((r) => r.status === "found")).toHaveLength(20);
  expect(m2.rows.filter((r) => r.status === "looking")).toHaveLength(10);
  expect(count(kv, "/finishes/")).toBe(20);
  expect(m2.boards.first).toHaveLength(20);
  expect(new Set(m2.boards.first.map((r) => r.k)).size).toBe(20);
  // Finished guests are off the live map.
  expect(m2.rows.filter((r) => r.status === "found" && r.pos)).toHaveLength(0);
});

test("searchers are told who just found Jacob, once each, however the finish happened", async () => {
  const kv = await published();
  await started(kv, 1, "Asha", T0);
  await started(kv, 2, "Ben", T0);
  await started(kv, 3, "Cy", T0);
  const done = async (now: number) => ((await guest(kv, "/ping", who(1), now)).body as unknown as PingReply).done;
  expect(await done(T0 + 1000)).toEqual([]);
  await guest(kv, "/finish", { ...who(2), ...near(5), accuracy: 5, ageMs: 0 }, T0 + 20_000);
  // Retries and a late approval don't announce Ben twice.
  await guest(kv, "/finish", { ...who(2), ...near(5), accuracy: 5, ageMs: 0 }, T0 + 21_000);
  await host(kv, "POST", "/master/approve", { id: id(2) }, T0 + 22_000);
  await host(kv, "POST", "/master/approve", { id: id(3) }, T0 + 30_000);
  expect(await done(T0 + 31_000)).toEqual([
    { k: publicKey(id(2)), name: "Ben", at: T0 + 20_000 },
    { k: publicKey(id(3)), name: "Cy", at: T0 + 30_000 },
  ]);
});
