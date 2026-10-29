// Hosted demo on Cloudflare Workers. One Durable Object per visitor holds their conversation; a single
// Budget object holds the daily cap and the per-IP limit. Same Conversation logic as the Node server.
import { DurableObject } from "cloudflare:workers";
import html from "../public/index.html";
import { Conversation, HttpError, type DailyBudget, type Snapshot } from "./conversation.ts";
import { addressGroup } from "./net.ts";
import { paypalToolSchemas, realPayPal } from "./paypal.ts";

interface Env {
  CONVO: DurableObjectNamespace<ConversationDO>;
  BUDGET: DurableObjectNamespace<BudgetDO>;
  PUBLIC_HOSTS: string; // comma-separated hosts this worker answers on
  DEMO_RECIPIENT_EMAIL: string;
  SESSION_TURN_CAP?: string;
  DAILY_CALL_CAP?: string;
  PAYPAL_CLIENT_ID: string;
  PAYPAL_CLIENT_SECRET: string;
  ANTHROPIC_API_KEY: string;
}

type Reply = { status: number; body: any }; // any, not unknown: RPC types turn unknown into never
const IDLE_MS = 2 * 3600_000;
const POLL_MS = 10_000;
const MAX_POLLS = 360; // stop watching an unpaid invoice after an hour of polling
const COOKIE = "__Host-q2c"; // __Host-: no other lookadev.com subdomain can plant or read it

// The shared modules read settings from process.env (agent model, demo recipient, PayPal mode).
function loadEnv(env: Env) {
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") process.env[k] = v;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.DEMO_RECIPIENT_EMAIL ?? "")) throw new Error("DEMO_RECIPIENT_EMAIL is required");
}

export class BudgetDO extends DurableObject<Env> {
  private async day() {
    const today = new Date().toISOString().slice(0, 10);
    const d = (await this.ctx.storage.get<{ day: string; turns: number }>("day")) ?? { day: today, turns: 0 };
    return d.day === today ? d : { day: today, turns: 0 };
  }
  async check(): Promise<string | null> {
    const d = await this.day();
    return d.turns >= Number(this.env.DAILY_CALL_CAP ?? 600) ? "The live demo reached today's usage limit. The code runs locally in a few minutes: see the GitHub README." : null;
  }
  // Check and count in one method: Durable Object input gates keep other calls out between the get and the put.
  async reserve(): Promise<string | null> {
    const d = await this.day();
    if (d.turns >= Number(this.env.DAILY_CALL_CAP ?? 600)) return "The live demo reached today's usage limit. The code runs locally in a few minutes: see the GitHub README.";
    await this.ctx.storage.put("day", { day: d.day, turns: d.turns + 1 });
    return null;
  }
  // At most 20 new conversations per address per hour (IPv6 counted per /64), and 600 per hour in total.
  async allowNewSession(ip: string): Promise<boolean> {
    const key = "ip:" + addressGroup(ip);
    const recent = ((await this.ctx.storage.get<number[]>(key)) ?? []).filter((t) => Date.now() - t < 3600_000);
    const all = ((await this.ctx.storage.get<number[]>("all")) ?? []).filter((t) => Date.now() - t < 3600_000);
    // The global ceiling only bounds storage writes; Claude spend is capped per call elsewhere, so keep it high.
    if (recent.length >= 20 || all.length >= 600) return false;
    await this.ctx.storage.put(key, [...recent, Date.now()]);
    await this.ctx.storage.put("all", [...all, Date.now()]);
    if (!(await this.ctx.storage.getAlarm())) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
    return true;
  }
  // Hourly sweep of expired IP records.
  async alarm() {
    const all = await this.ctx.storage.list<number[]>({ prefix: "ip:" });
    for (const [k, ts] of all) if (!ts.some((t) => Date.now() - t < 3600_000)) await this.ctx.storage.delete(k);
    if (all.size) await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }
}

export class ConversationDO extends DurableObject<Env> {
  private convo?: Conversation;

  private async load(create: boolean): Promise<Conversation | null> {
    if (this.convo) return this.convo;
    loadEnv(this.env);
    const snap = await this.ctx.storage.get<Snapshot>("snap");
    if (!snap && !create) return null;
    const budgetStub = this.env.BUDGET.get(this.env.BUDGET.idFromName("global"));
    const budget: DailyBudget = {
      async check() { const msg = await budgetStub.check(); if (msg) throw new HttpError(429, msg); },
      async reserve() { const msg = await budgetStub.reserve(); if (msg) throw new HttpError(429, msg); },
    };
    const paypal = realPayPal(this.env.PAYPAL_CLIENT_ID, this.env.PAYPAL_CLIENT_SECRET);
    this.convo = new Conversation(paypal, paypalToolSchemas(), budget, Number(this.env.SESSION_TURN_CAP ?? 30), snap ?? undefined);
    return this.convo;
  }

  // Save after every step, and keep an alarm running while there is an invoice to watch or until idle expiry.
  private async save() {
    if (!this.convo) return;
    await this.ctx.storage.put("snap", this.convo.snapshot());
    await this.ctx.storage.put("seen", Date.now());
    await this.ctx.storage.put("polls", 0); // a visitor action restarts the payment watch
    await this.ctx.storage.setAlarm(Date.now() + (this.convo.watching ? POLL_MS : IDLE_MS));
  }

  private async run(create: boolean, fn: (c: Conversation) => Promise<unknown>): Promise<Reply> {
    let loaded = false;
    try {
      const c = await this.load(create);
      if (!c) return { status: 409, body: { error: "Your demo session expired. Reload the page." } };
      loaded = true;
      const out = await fn(c);
      return { status: 200, body: out };
    } catch (err) {
      const status = err instanceof HttpError ? err.code : 500;
      if (status === 500) console.error(err);
      return { status, body: { error: status === 500 ? "Something went wrong. Try again in a moment." : (err as Error).message } };
    } finally {
      if (loaded) await this.save();
    }
  }

  init() { return this.run(true, async () => ({ ok: true })); }

  // The page polls this every 1.5 s, so it only reads; it refreshes the idle clock at most once a minute.
  private lastSeenWrite = 0;
  async state(): Promise<Reply> {
    const c = await this.load(false);
    if (!c) return { status: 409, body: { error: "Your demo session expired. Reload the page." } };
    if (Date.now() - this.lastSeenWrite > 60_000) {
      this.lastSeenWrite = Date.now();
      await this.ctx.storage.put("seen", Date.now());
    }
    return { status: 200, body: { ...c.state, mode: "sandbox", demo: true, turnsLeft: c.turnsLeft } };
  }
  customer(text: unknown) { return this.run(false, async (c) => ({ reply: await c.customer(text, 600) })); }
  owner(action: string, id: number) { return this.run(false, async (c) => ({ reply: await c.owner(action, id) })); }
  overdue() { return this.run(false, async (c) => ({ reply: await c.overdue() })); }
  reset() { return this.run(false, async (c) => { c.reset(); return { ok: true }; }); }

  async alarm() {
    const seen = (await this.ctx.storage.get<number>("seen")) ?? 0;
    if (Date.now() - seen > IDLE_MS) { await this.ctx.storage.deleteAll(); this.convo = undefined; return; }
    const c = await this.load(false);
    if (!c) return;
    const polls = (await this.ctx.storage.get<number>("polls")) ?? 0;
    if (c.watching && polls < MAX_POLLS) {
      const before = JSON.stringify(c.snapshot());
      try { await c.checkPayment(); } catch (e) { console.error("payment check:", (e as Error).message); }
      const after = c.snapshot();
      if (JSON.stringify(after) !== before) await this.ctx.storage.put("snap", after); // write only when something changed
      await this.ctx.storage.put("polls", polls + 1);
    }
    const keepPolling = c.watching && polls + 1 < MAX_POLLS;
    await this.ctx.storage.setAlarm(Date.now() + (keepPolling ? POLL_MS : Math.max(60_000, IDLE_MS - (Date.now() - seen))));
  }
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const hosts = new Set(env.PUBLIC_HOSTS.split(",").map((h) => h.trim()).filter(Boolean));
    if (!hosts.has(url.host)) return json(403, { error: "unknown host" });
    if (req.method === "GET" && url.pathname === "/") {
      return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "x-robots-tag": "noindex", "referrer-policy": "no-referrer", "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" } });
    }
    // Only this page may call the API: browsers mark requests from other sites (an <img> tag, a form) as cross-site.
    if (url.pathname.startsWith("/api/") && req.headers.get("sec-fetch-site") === "cross-site") return json(403, { error: "cross-site request" });
    if (req.method === "GET" && url.pathname === "/healthz") return json(200, { ok: true });

    const sid = /(?:^|;\s*)__Host-q2c=([0-9a-f-]{36})/.exec(req.headers.get("cookie") ?? "")?.[1];
    // The RPC stub types recurse through Conversation; a plain view of the methods keeps tsc fast and exact.
    type ConvoRpc = { [K in "init" | "state" | "customer" | "owner" | "overdue" | "reset"]: (...a: Parameters<ConversationDO[K]>) => Promise<Reply> };
    const stub = (id: string) => env.CONVO.get(env.CONVO.idFromName(id)) as unknown as ConvoRpc;

    if (req.method === "GET" && url.pathname === "/api/state") {
      if (sid) {
        const r = await stub(sid).state();
        if (r.status !== 409) return json(r.status, r.body);
      }
      // New visitor (or expired session): rate-limit by the address Cloudflare saw.
      const ip = req.headers.get("cf-connecting-ip") ?? "?";
      const budget = env.BUDGET.get(env.BUDGET.idFromName("global"));
      if (!(await budget.allowNewSession(ip))) return json(429, { error: "Too many new demo sessions from this address. Try again in an hour." });
      const fresh = crypto.randomUUID();
      await stub(fresh).init();
      const r = await stub(fresh).state();
      return json(r.status, r.body, { "set-cookie": `${COOKIE}=${fresh}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=7200` });
    }

    if (req.method !== "POST") return json(404, { error: "not found" });
    // Reject cross-site POSTs: a page on another origin must not be able to press the owner's buttons.
    const origin = req.headers.get("origin");
    if (!origin || !URL.canParse(origin) || !hosts.has(new URL(origin).host)) return json(403, { error: "cross-origin request" });
    if (!sid) return json(409, { error: "Your demo session expired. Reload the page." });
    if (Number(req.headers.get("content-length") ?? 0) > 20_000) return json(413, { error: "request too large" });
    const raw = await req.text();
    if (raw.length > 20_000) return json(413, { error: "request too large" });
    let b: any;
    try { b = raw ? JSON.parse(raw) : {}; } catch { return json(400, { error: "bad JSON" }); }
    const s = stub(sid);
    let r: Reply;
    if (url.pathname === "/api/customer") r = await s.customer(b.text);
    else if (url.pathname === "/api/owner") r = await s.owner(String(b.action), Number(b.id));
    else if (url.pathname === "/api/simulate-overdue") r = await s.overdue();
    else if (url.pathname === "/api/reset") r = await s.reset();
    else return json(404, { error: "not found" });
    return json(r.status, r.body);
  },
};
