import { expect, test } from "@playwright/test";
import { BOARD_CACHE_MS, route } from "../netlify/lib/core.ts";
import { kvFromStore, type BlobStore } from "../netlify/lib/store.ts";
import type { MasterState } from "../src/config.ts";

BOARD_CACHE_MS.value = 0;

/**
 * A stand-in for Netlify Blobs with the same conditional-write behaviour (onlyIfNew, onlyIfMatch + etags)
 * and a random delay on every call, so concurrent requests really interleave like they do on the network.
 */
function fakeBlobs(): BlobStore & { data: Map<string, { json: string; etag: string }>; writes: number } {
  const data = new Map<string, { json: string; etag: string }>();
  let n = 0;
  const lag = () => new Promise<void>((r) => setTimeout(r, Math.random() * 4));
  const self = {
    data,
    writes: 0,
    async get(key: string) {
      await lag();
      const v = data.get(key);
      return v ? JSON.parse(v.json) : null;
    },
    async getWithMetadata(key: string) {
      await lag();
      const v = data.get(key);
      return v ? { data: JSON.parse(v.json), etag: v.etag } : null;
    },
    async setJSON(key: string, value: unknown, options?: { onlyIfNew?: true; onlyIfMatch?: string }) {
      await lag();
      const cur = data.get(key);
      if (options?.onlyIfNew && cur) return { modified: false };
      if (options?.onlyIfMatch !== undefined && cur?.etag !== options.onlyIfMatch) return { modified: false };
      data.set(key, { json: JSON.stringify(value), etag: `"e${++n}"` });
      self.writes++;
      return { modified: true };
    },
    async list({ prefix }: { prefix: string }) {
      await lag();
      return { blobs: [...data.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
  return self;
}

test("setIfNew lets exactly one of many concurrent writers win", async () => {
  const kv = kvFromStore(fakeBlobs());
  const wins = await Promise.all(Array.from({ length: 12 }, (_, i) => kv.setIfNew("k", { i })));
  expect(wins.filter(Boolean)).toHaveLength(1);
});

test("update never loses a concurrent change", async () => {
  const kv = kvFromStore(fakeBlobs());
  await Promise.all(
    Array.from({ length: 7 }, (_, i) =>
      kv.update("live", (cur) => ({ ...((cur as Record<string, number> | null) ?? {}), [`guest${i}`]: i })),
    ),
  );
  expect(Object.keys((await kv.get("live")) as object).sort()).toEqual(["guest0", "guest1", "guest2", "guest3", "guest4", "guest5", "guest6"]);
  // Returning undefined leaves the value alone.
  await kv.update("live", () => undefined);
  expect(Object.keys((await kv.get("live")) as object)).toHaveLength(7);
});

test("the whole game holds together on the real storage wrapper under concurrency", async () => {
  const blobs = fakeBlobs();
  const kv = kvFromStore(blobs);
  const KEY = "k";
  const call = (method: string, path: string, body: unknown, admin = false, ip = "a") => route({ method, path, body, adminKey: admin ? KEY : null, ip }, kv, { adminKey: KEY });
  await call("POST", "/master/target", { lat: 12.9763, lng: 77.5929, accuracy: 5 }, true);
  const who = Array.from({ length: 12 }, (_, i) => ({ id: `${String(i).padStart(8, "0")}-4444-4444-8444-444444444444`, token: "c".repeat(64) }));
  const starts = await Promise.all(who.map((w, i) => call("POST", "/start", { ...w, name: `G${i}`, ageMs: 0, lat: 12.979, lng: 77.5929 }, false, `ip${i}`)));
  expect(starts.map((r) => r.status)).toEqual(Array(12).fill(200));
  await Promise.all(who.map((w, i) => call("POST", "/ping", { ...w, lat: 12.978 + i / 1e5, lng: 77.5929 })));
  // Everyone asks, reaches the circle and gets approved at the same moment.
  const replies = await Promise.all(
    who.flatMap((w) => [
      call("POST", "/request", w),
      call("POST", "/finish", { ...w, lat: 12.97632, lng: 77.5929, accuracy: 5, ageMs: 0 }),
      call("POST", "/master/approve", { id: w.id }, true),
      call("POST", "/master/approve", { id: w.id }, true),
    ]),
  );
  expect(replies.every((r) => r.status === 200)).toBe(true);
  const m = (await call("GET", "/master", null, true)).body as unknown as MasterState;
  expect(m.rows).toHaveLength(12);
  expect(m.rows.every((r) => r.status === "found")).toBe(true);
  expect(m.boards.first).toHaveLength(12);
  expect([...blobs.data.keys()].filter((k) => k.includes("/finishes/"))).toHaveLength(12);
  // Nobody is left on the live map once they've finished.
  expect(m.rows.filter((r) => r.pos)).toHaveLength(0);
  const live = JSON.parse(blobs.data.get("r1/live")!.json) as { at: object; done: unknown[] };
  expect(Object.keys(live.at)).toHaveLength(0);
  // The recent-finishers list is capped and has no duplicates.
  expect(live.done).toHaveLength(8);
  expect(new Set(live.done.map((d) => (d as { k: string }).k)).size).toBe(8);
});
