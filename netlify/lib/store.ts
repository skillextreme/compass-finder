import { getStore } from "@netlify/blobs";
import type { KV } from "./core.ts";

/** The few Netlify Blobs calls the game uses, so the wrapper below can be tested against a stand-in. */
export interface BlobStore {
  get(key: string, options: { type: "json" }): Promise<unknown>;
  getWithMetadata(key: string, options: { type: "json" }): Promise<{ data: unknown; etag?: string } | null>;
  setJSON(key: string, value: unknown, options?: { onlyIfNew: true } | { onlyIfMatch: string }): Promise<{ modified: boolean }>;
  list(options: { prefix: string }): Promise<{ blobs: { key: string }[] }>;
}

export function kvFromStore(store: BlobStore): KV {
  return {
    get: (key) => store.get(key, { type: "json" }),
    set: async (key, value) => {
      await store.setJSON(key, value);
    },
    setIfNew: async (key, value) => (await store.setJSON(key, value, { onlyIfNew: true })).modified,
    update: async (key, change) => {
      // Compare-and-swap: write only if nobody else wrote since we read, otherwise read again and retry.
      for (let i = 0; i < 8; i++) {
        const cur = await store.getWithMetadata(key, { type: "json" });
        const next = change(cur ? cur.data : null);
        if (next === undefined) return;
        const res = cur?.etag ? await store.setJSON(key, next, { onlyIfMatch: cur.etag }) : await store.setJSON(key, next, { onlyIfNew: true });
        if (res.modified) return;
      }
      // Still losing after eight tries: write anyway rather than drop the change.
      const next = change(await store.get(key, { type: "json" }));
      if (next !== undefined) await store.setJSON(key, next);
    },
    list: async (prefix) => (await store.list({ prefix })).blobs.map((b) => b.key),
  };
}

/** Netlify Blobs with strong consistency, so a finish is visible to the very next read. */
export function blobKV(): KV {
  return kvFromStore(getStore({ name: "compass", consistency: "strong" }) as unknown as BlobStore);
}
