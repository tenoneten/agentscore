import { Database } from "bun:sqlite";
import { scoreUrl, type ScoringResult } from "./scorer";
import { readFileSync } from "fs";
import { join } from "path";

const db = new Database("scores.db");
db.run(`CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  result TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
)`);

db.run(`CREATE TABLE IF NOT EXISTS analytics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event TEXT NOT NULL,
  url TEXT,
  ip TEXT,
  ua TEXT,
  referrer TEXT,
  created_at TEXT DEFAULT (datetime('now'))
)`);

const insertStmt = db.prepare("INSERT INTO reports (id, url, result) VALUES (?, ?, ?)");
const getStmt = db.prepare("SELECT result FROM reports WHERE id = ?");
const getCachedStmt = db.prepare("SELECT result FROM reports WHERE url = ? AND created_at >= datetime('now', '-24 hours') ORDER BY created_at DESC LIMIT 1");
const trackStmt = db.prepare("INSERT INTO analytics (event, url, ip, ua, referrer) VALUES (?, ?, ?, ?, ?)");

const html = readFileSync(join(import.meta.dir, "index.html"), "utf-8");

function clientIp(req: Request): string {
  return req.headers.get("x-real-ip") || req.headers.get("x-forwarded-for") || "";
}

function cors(resp: Response): Response {
  resp.headers.set("Access-Control-Allow-Origin", "*");
  return resp;
}

const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      trackStmt.run("pageview", null, clientIp(req), req.headers.get("user-agent") || "", req.headers.get("referer") || "");
      return new Response(html, { headers: { "Content-Type": "text/html" } });
    }

    if (url.pathname === "/api/score" && req.method === "POST") {
      try {
        const body = await req.json() as { url?: string };
        if (!body.url) return Response.json({ error: "URL required" }, { status: 400 });

        // Normalize URL for cache lookup (same logic as scorer)
        let normalizedUrl: string;
        try {
          const u = new URL(body.url.startsWith("http") ? body.url : `https://${body.url}`);
          normalizedUrl = u.origin.replace("://www.", "://");
        } catch {
          normalizedUrl = body.url;
        }

        // Check 24h cache
        const cached = getCachedStmt.get(normalizedUrl) as { result: string } | null;
        if (cached) {
          trackStmt.run("scan_cached", normalizedUrl, clientIp(req), req.headers.get("user-agent") || "", req.headers.get("referer") || "");
          return Response.json(JSON.parse(cached.result));
        }

        const result = await scoreUrl(body.url);
        trackStmt.run("scan", result.url, clientIp(req), req.headers.get("user-agent") || "", req.headers.get("referer") || "");
        insertStmt.run(result.id, result.url, JSON.stringify(result));
        return Response.json(result);
      } catch (e: any) {
        return Response.json({ error: e.message || "Scoring failed" }, { status: 500 });
      }
    }

    if (url.pathname.startsWith("/api/report/")) {
      const id = url.pathname.split("/").pop();
      const row = getStmt.get(id) as { result: string } | null;
      if (!row) return Response.json({ error: "Report not found" }, { status: 404 });
      return Response.json(JSON.parse(row.result));
    }

    if (url.pathname === "/api/stats") {
      const today = db.prepare("SELECT event, COUNT(*) as count FROM analytics WHERE created_at >= date('now') GROUP BY event").all();
      const week = db.prepare("SELECT event, COUNT(*) as count FROM analytics WHERE created_at >= date('now', '-7 days') GROUP BY event").all();
      const allTime = db.prepare("SELECT event, COUNT(*) as count FROM analytics GROUP BY event").all();
      const topUrls = db.prepare("SELECT url, COUNT(*) as count FROM analytics WHERE event='scan' AND url IS NOT NULL GROUP BY url ORDER BY count DESC LIMIT 20").all();
      const daily = db.prepare("SELECT date(created_at) as day, event, COUNT(*) as count FROM analytics WHERE created_at >= date('now', '-30 days') GROUP BY day, event ORDER BY day").all();
      const topReferrers = db.prepare("SELECT referrer, COUNT(*) as count FROM analytics WHERE referrer IS NOT NULL AND referrer != '' GROUP BY referrer ORDER BY count DESC LIMIT 20").all();
      const uniqueVisitors = {
        today: (db.prepare("SELECT COUNT(DISTINCT ip) as count FROM analytics WHERE created_at >= date('now') AND ip != ''").get() as any)?.count || 0,
        week: (db.prepare("SELECT COUNT(DISTINCT ip) as count FROM analytics WHERE created_at >= date('now', '-7 days') AND ip != ''").get() as any)?.count || 0,
        allTime: (db.prepare("SELECT COUNT(DISTINCT ip) as count FROM analytics WHERE ip != ''").get() as any)?.count || 0,
      };
      return cors(Response.json({ today, week, allTime, topUrls, daily, topReferrers, uniqueVisitors }));
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`🤖 Agent Readiness Scorer running at http://localhost:${server.port}`);
