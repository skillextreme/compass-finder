import type { Config, Context } from "@netlify/functions";
import { route } from "../lib/core.ts";
import { blobKV } from "../lib/store.ts";

/** One function serves every /api route. The rules live in ../lib/core.ts. */
export default async (req: Request, context: Context): Promise<Response> => {
  const headers = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
  const send = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers });
  let body: unknown = null;
  if (req.method === "POST") {
    try {
      const text = await req.text();
      if (text.length > 2048) return send(413, { error: "too_large" });
      body = text ? JSON.parse(text) : null;
    } catch {
      return send(400, { error: "invalid_json" });
    }
  }
  try {
    const url = new URL(req.url);
    const reply = await route(
      {
        method: req.method,
        path: url.pathname.replace(/^\/api/, ""),
        body,
        adminKey: req.headers.get("x-admin-key"),
        ip: context.ip || "unknown",
      },
      blobKV(),
      { adminKey: process.env.ADMIN_KEY },
    );
    return send(reply.status, reply.body);
  } catch (err) {
    console.error("api failed", err);
    return send(500, { error: "server_error" });
  }
};

export const config: Config = { path: "/api/*" };
