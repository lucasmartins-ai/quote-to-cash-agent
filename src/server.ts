// Node server: run it locally (npm start). The hosted demo runs src/worker.ts on Cloudflare instead.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Conversation, HttpError, type DailyBudget } from "./conversation.ts";
import { mockPayPal, paypalToolSchemas, realPayPal } from "./paypal.ts";
import type { PayPal } from "./shop.ts";

const PORT = Number(process.env.PORT ?? 3000);
// ponytail: no login. Each visitor gets their own conversation by cookie; bind to localhost unless HOST is set.
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_HOST = process.env.PUBLIC_HOST;
// Host allowlist blocks DNS rebinding: a hostile domain resolving to this machine still sends its own Host.
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, ...(PUBLIC_HOST ? [PUBLIC_HOST] : [])]);
const DEMO = process.env.DEMO === "1"; // public demo: behind a proxy, with spending limits shown in the UI
const LIMIT = {
  turnsPerConversation: Number(process.env.SESSION_TURN_CAP ?? 30),
  turnsPerDay: Number(process.env.DAILY_CALL_CAP ?? 600),
  conversations: Number(process.env.MAX_SESSIONS ?? 200),
  newConversationsPerIpHour: 6,
};
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
const mock = !(id && secret) ? mockPayPal() : undefined;
const paypal: PayPal = mock ? mock.run : realPayPal(id!, secret!);
const toolSchemas = paypalToolSchemas();
if (DEMO && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.DEMO_RECIPIENT_EMAIL ?? "")) {
  throw new Error("DEMO=1 needs DEMO_RECIPIENT_EMAIL, so visitors cannot make the demo invoice strangers");
}

let day = new Date().toISOString().slice(0, 10);
let turnsToday = 0;
// Synchronous check-and-count, so concurrent requests cannot both slip under the cap.
function dailyCheck() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; turnsToday = 0; }
  if (turnsToday >= LIMIT.turnsPerDay) throw new HttpError(429, "The live demo reached today's usage limit. The code runs locally in a few minutes: see the GitHub README.");
}
const budget: DailyBudget = {
  async check() { dailyCheck(); },
  async reserve() { dailyCheck(); turnsToday++; },
};

type Session = { convo: Conversation; seen: number };
const sessions = new Map<string, Session>();
const ipLog = new Map<string, number[]>();
// Behind one trusted proxy the LAST X-Forwarded-For entry is the one the proxy added; earlier ones can be forged.
const clientIp = (req: IncomingMessage) =>
  (DEMO ? String(req.headers["x-forwarded-for"] ?? "").split(",").at(-1)!.trim() : "") || req.socket.remoteAddress || "?";

function sessionFor(req: IncomingMessage, res: ServerResponse, create: boolean): Conversation {
  const sid = /(?:^|;\s*)q2c=([0-9a-f-]{36})/.exec(req.headers.cookie ?? "")?.[1];
  const found = sid && sessions.get(sid);
  if (found) { found.seen = Date.now(); return found.convo; }
  if (!create) throw new HttpError(409, "Your demo session expired. Reload the page.");
  const ip = clientIp(req);
  const recent = (ipLog.get(ip) ?? []).filter((t) => Date.now() - t < 3_600_000);
  if (recent.length >= LIMIT.newConversationsPerIpHour) throw new HttpError(429, "Too many new demo sessions from this address. Try again in an hour.");
  ipLog.set(ip, [...recent, Date.now()]);
  if (sessions.size >= LIMIT.conversations) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].seen - b[1].seen)[0];
    sessions.delete(oldest[0]);
  }
  const fresh = randomUUID();
  const convo = new Conversation(paypal, toolSchemas, budget, LIMIT.turnsPerConversation);
  sessions.set(fresh, { convo, seen: Date.now() });
  res.setHeader("set-cookie", `q2c=${fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200${PUBLIC_HOST ? "; Secure" : ""}`);
  return convo;
}

// Forget conversations idle for two hours, and IP records older than the one-hour window.
setInterval(() => {
  for (const [k, s] of sessions) if (Date.now() - s.seen > 7_200_000) sessions.delete(k);
  for (const [ip, ts] of ipLog) if (!ts.some((t) => Date.now() - t < 3_600_000)) ipLog.delete(ip);
  if (ipLog.size > 10_000) ipLog.clear(); // ponytail: crude ceiling; a flood of addresses just resets the window
}, 60_000);

// Payment watcher for every open conversation.
setInterval(() => {
  for (const s of sessions.values()) s.convo.checkPayment().catch((e) => console.error("payment check:", e.message));
}, 10_000);

const body = async (req: IncomingMessage) => {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new HttpError(413, "request too large");
  }
  return raw ? JSON.parse(raw) : {};
};

createServer(async (req, res) => {
  const send = (code: number, data: unknown, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(data) : (data as string));
  };
  try {
    if (!HOSTS.has(req.headers.host ?? "")) return send(403, { error: "unknown host" });
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/healthz") return send(200, { ok: true });
    if (req.method === "GET" && url.pathname === "/") return send(200, await readFile(new URL("../public/index.html", import.meta.url), "utf8"), "text/html");
    if (req.method === "GET" && url.pathname === "/api/state") {
      const c = sessionFor(req, res, true);
      return send(200, { ...c.state, mode: mock ? "mock" : "sandbox", demo: DEMO, turnsLeft: c.turnsLeft });
    }
    if (req.method === "GET" && url.pathname.startsWith("/pay/") && mock) {
      mock.pay(url.pathname.slice(5));
      return send(200, "<p>Demo payment done. Go back to the chat.</p>", "text/html");
    }
    if (req.method !== "POST") return send(404, { error: "not found" });
    // Reject cross-site POSTs: a page on another origin must not be able to press the owner's buttons.
    const origin = req.headers.origin;
    if (!origin || !URL.canParse(origin) || !HOSTS.has(new URL(origin).host)) return send(403, { error: "cross-origin request" });

    const c = sessionFor(req, res, false);
    const b = await body(req);
    if (url.pathname === "/api/customer") return send(200, { reply: await c.customer(b.text, DEMO ? 600 : 2000) });
    if (url.pathname === "/api/owner") return send(200, { reply: await c.owner(String(b.action), Number(b.id)) });
    if (url.pathname === "/api/simulate-overdue") return send(200, { reply: await c.overdue() });
    if (url.pathname === "/api/reset") { c.reset(); return send(200, { ok: true }); }
    send(404, { error: "not found" });
  } catch (err) {
    const code = err instanceof HttpError ? err.code : 500;
    if (code === 500) console.error(err);
    send(code, { error: (err as Error).message });
  }
}).listen(PORT, HOST, () => console.log(`quote-to-cash-agent on http://${HOST}:${PORT} (${mock ? "mock PayPal" : "PayPal sandbox"}${DEMO ? ", public demo limits on" : ""})`));
