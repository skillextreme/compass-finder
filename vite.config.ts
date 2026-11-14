import { defineConfig, type Connect, type Plugin } from "vite";
import { resolve } from "node:path";
import { BOARD_CACHE_MS, memoryKV, route, type KV } from "./netlify/lib/core.ts";

/**
 * Serves /api locally with the same rules Netlify runs, backed by memory instead of Blobs.
 * `npm run dev` and the Playwright tests use it, so no Netlify login is needed to try the game.
 * The x-ns header gives each test its own empty game.
 */
function devApi(): Plugin {
  const stores = new Map<string, KV>();
  const handler: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith("/api/")) return next();
    BOARD_CACHE_MS.value = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const send = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("content-type", "application/json; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(body));
        };
        let body: unknown = null;
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          return send(400, { error: "invalid_json" });
        }
        const ns = String(req.headers["x-ns"] ?? "default");
        if (!stores.has(ns)) stores.set(ns, memoryKV());
        try {
          const reply = await route(
            {
              method: req.method ?? "GET",
              path: new URL(req.url!, "http://localhost").pathname.replace(/^\/api/, ""),
              body,
              ip: ns,
            },
            stores.get(ns)!,
            {},
          );
          send(reply.status, reply.body);
        } catch (err) {
          console.error(err);
          send(500, { error: "server_error" });
        }
      })();
    });
  };
  return {
    name: "dev-api",
    configureServer: (server) => void server.middlewares.use(handler),
    configurePreviewServer: (server) => void server.middlewares.use(handler),
  };
}

/**
 * WhatsApp only shows a link preview picture when its address is absolute.
 * Netlify provides the site's address as URL at build time; locally the tags are left relative.
 */
function siteUrl(): Plugin {
  const base = (process.env.URL ?? "").replace(/\/+$/, "");
  return { name: "site-url", transformIndexHtml: (html) => html.replaceAll("%SITE_URL%", base) };
}

export default defineConfig({
  plugins: [devApi(), siteUrl()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        master: resolve(import.meta.dirname, "master.html"),
      },
    },
  },
});
