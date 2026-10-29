import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createAgent } from "./agent.ts";
import { mockPayPal, paypalToolSchemas, realPayPal } from "./paypal.ts";
import { isPaid, newState, ownerEvent, type PayPal, type State } from "./shop.ts";

const PORT = Number(process.env.PORT ?? 3000);
// ponytail: no login. Each visitor gets their own conversation by cookie; bind to localhost unless HOST is set.
const HOST = process.env.HOST ?? "127.0.0.1";
const PUBLIC_HOST = process.env.PUBLIC_HOST;
// Host allowlist blocks DNS rebinding: a hostile domain resolving to this machine still sends its own Host.
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, ...(PUBLIC_HOST ? [PUBLIC_HOST] : [])]);
const DEMO = process.env.DEMO === "1"; // public demo: behind a proxy, with spending limits shown in the UI
const LIMIT = {
  turnsPerConversation: Number(process.env.SESSION_TURN_CAP ?? 30),
  turnsPerDay: Number(process.env.DAILY_TURN_CAP ?? 300),
  conversations: Number(process.env.MAX_SESSIONS ?? 200),
  newConversationsPerIpHour: 6,
};
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
const mock = !(id && secret) ? mockPayPal() : undefined;
const paypal: PayPal = mock ? mock.run : realPayPal(id!, secret!);
const toolSchemas = paypalToolSchemas();

type Session = { state: State; agent: ReturnType<typeof createAgent>; turns: number; seen: number };
const sessions = new Map<string, Session>();
const newSession = (turns = 0): Session => {
  const state = newState();
  return { state, agent: createAgent(state, paypal, toolSchemas), turns, seen: Date.now() };
};

class HttpError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

// Spending limits: every agent turn costs Claude tokens, so cap them per conversation and per day.
let day = new Date().toISOString().slice(0, 10);
let turnsToday = 0;
function checkBudget(s: Session) {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== day) { day = today; turnsToday = 0; }
  if (s.turns >= LIMIT.turnsPerConversation) throw new HttpError(429, "This demo conversation reached its message limit. Reload the page tomorrow, or run the code locally (see the GitHub README).");
  if (turnsToday >= LIMIT.turnsPerDay) throw new HttpError(429, "The live demo reached today's usage limit. The code runs locally in a few minutes: see the GitHub README.");
}
function spend(s: Session) {
  checkBudget(s);
  s.turns++;
  turnsToday++;
}
const say = (s: Session, text: string, kind: "customer" | "event") => { spend(s); return s.agent.say(text, kind); };

const ipLog = new Map<string, number[]>();
// Behind one trusted proxy (Railway's edge) the LAST X-Forwarded-For entry is the one the proxy added;
// earlier entries come from the client and can be forged.
const clientIp = (req: IncomingMessage) =>
  (DEMO ? String(req.headers["x-forwarded-for"] ?? "").split(",").at(-1)!.trim() : "") || req.socket.remoteAddress || "?";
if (DEMO && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(process.env.DEMO_RECIPIENT_EMAIL ?? "")) {
  throw new Error("DEMO=1 needs DEMO_RECIPIENT_EMAIL, so visitors cannot make the demo invoice strangers");
}

function cookieId(req: IncomingMessage) {
  return /(?:^|;\s*)q2c=([0-9a-f-]{36})/.exec(req.headers.cookie ?? "")?.[1];
}

function sessionFor(req: IncomingMessage, res: ServerResponse, create: boolean): Session {
  const sid = cookieId(req);
  const found = sid && sessions.get(sid);
  if (found) { found.seen = Date.now(); return found; }
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
  const s = newSession();
  sessions.set(fresh, s);
  res.setHeader("set-cookie", `q2c=${fresh}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200${PUBLIC_HOST ? "; Secure" : ""}`);
  return s;
}

// Forget conversations idle for two hours, and IP records older than the one-hour window.
setInterval(() => {
  for (const [k, s] of sessions) if (Date.now() - s.seen > 7_200_000) sessions.delete(k);
  for (const [ip, ts] of ipLog) if (!ts.some((t) => Date.now() - t < 3_600_000)) ipLog.delete(ip);
  if (ipLog.size > 10_000) ipLog.clear(); // ponytail: crude ceiling; a flood of addresses just resets the window
}, 60_000);

const body = async (req: IncomingMessage) => {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20_000) throw new HttpError(413, "request too large");
  }
  return raw ? JSON.parse(raw) : {};
};

async function ownerAction(s: Session, action: string, eventId: number) {
  const { state } = s;
  checkBudget(s); // before any state changes, so a hit limit never leaves a half-approved quote
  const e = state.owner.find((x) => x.id === eventId && x.status === "open");
  if (!e) throw new HttpError(409, "That item is no longer open.");
  const kind = action.endsWith("_quote") ? "quote" : "payment";
  if (e.kind !== kind) throw new HttpError(400, "That button does not belong to this item.");
  if (kind === "quote" ? state.quote?.status !== "pending" : state.paymentClaim?.status !== "pending") throw new HttpError(409, "Nothing is waiting for that answer.");
  e.status = "done";
  if (action === "approve_quote" && state.quote) {
    state.quote.status = "approved";
    return say(s, `The owner approved the quote of £${state.quote.total}. Create and send the invoice now.`, "event");
  }
  if (action === "reject_quote" && state.quote) {
    state.quote.status = "rejected";
    state.quote = undefined;
    return say(s, "The owner rejected the quote. Apologise and say the owner will call to discuss the job.", "event");
  }
  if (action === "confirm_payment" && state.paymentClaim) {
    state.paymentClaim.status = "confirmed";
    return say(s, "The owner confirmed the money arrived. Record the payment now.", "event");
  }
  if (action === "reject_payment" && state.paymentClaim) {
    state.paymentClaim.status = "rejected";
    return say(s, "The owner cannot see the payment yet. Ask the customer politely for the transfer reference.", "event");
  }
  throw new HttpError(400, `Unknown action ${action}`);
}

// Payment watcher: polls each sent invoice and tells that conversation's agent once PayPal marks it paid.
async function checkPayment(s: Session) {
  const st = s.state;
  const inv = st.invoice;
  if (!inv || inv.notifiedPaid || inv.status === "DRAFT") return;
  const detail: any = await paypal("get_invoice", { invoice_id: inv.id });
  if (s.state !== st) return; // "Start over" happened while waiting: this answer belongs to the old conversation
  inv.status = detail?.status ?? inv.status;
  if (isPaid(inv.status)) {
    inv.notifiedPaid = true;
    ownerEvent(st, "info", `Invoice ${inv.id} paid on PayPal.`);
    try {
      await say(s, `Invoice ${inv.id} has been paid on PayPal.`, "event");
    } catch (err) {
      if (!(err instanceof HttpError && err.code === 429)) throw err;
      // Out of demo turns: still tell the customer, without Claude.
      st.chat.push({ from: "agent", text: `Thank you, your payment of £${st.quote?.total ?? ""} has arrived and your booking is confirmed.`, at: new Date().toISOString() });
    }
  }
}
setInterval(() => {
  for (const s of sessions.values()) checkPayment(s).catch((e) => console.error("payment check:", e.message));
}, 10_000);

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
      const s = sessionFor(req, res, true);
      return send(200, { ...s.state, mode: mock ? "mock" : "sandbox", demo: DEMO, turnsLeft: Math.max(0, LIMIT.turnsPerConversation - s.turns) });
    }
    if (req.method === "GET" && url.pathname.startsWith("/pay/") && mock) {
      mock.pay(url.pathname.slice(5));
      return send(200, "<p>Demo payment done. Go back to the chat.</p>", "text/html");
    }
    if (req.method !== "POST") return send(404, { error: "not found" });
    // Reject cross-site POSTs: a page on another origin must not be able to press the owner's buttons.
    const origin = req.headers.origin;
    if (!origin || !URL.canParse(origin) || !HOSTS.has(new URL(origin).host)) return send(403, { error: "cross-origin request" });

    const s = sessionFor(req, res, false);
    const b = await body(req);
    if (url.pathname === "/api/customer") {
      const text = String(b.text ?? "").trim().slice(0, DEMO ? 600 : 2000);
      if (!text) return send(400, { error: "empty message" });
      checkBudget(s); // before the message shows up in the chat
      s.state.chat.push({ from: "customer", text, at: new Date().toISOString() });
      return send(200, { reply: await say(s, text, "customer") });
    }
    if (url.pathname === "/api/owner") return send(200, { reply: await ownerAction(s, String(b.action), Number(b.id)) });
    if (url.pathname === "/api/simulate-overdue") {
      if (!s.state.invoice || isPaid(s.state.invoice.status)) return send(400, { error: "no unpaid invoice" });
      return send(200, { reply: await say(s, `Seven days have passed. Invoice ${s.state.invoice.id} is overdue and unpaid.`, "event") });
    }
    if (url.pathname === "/api/reset") {
      // A fresh conversation keeps the turn count, so Start over cannot be used to dodge the limit.
      const fresh = newSession(s.turns);
      s.state = fresh.state;
      s.agent = fresh.agent;
      return send(200, { ok: true });
    }
    send(404, { error: "not found" });
  } catch (err) {
    const code = err instanceof HttpError ? err.code : 500;
    if (code === 500) console.error(err);
    send(code, { error: (err as Error).message });
  }
}).listen(PORT, HOST, () => console.log(`quote-to-cash-agent on http://${HOST}:${PORT} (${mock ? "mock PayPal" : "PayPal sandbox"}${DEMO ? ", public demo limits on" : ""})`));
