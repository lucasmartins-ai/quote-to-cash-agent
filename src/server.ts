import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { createAgent } from "./agent.ts";
import { mockPayPal, paypalToolSchemas, realPayPal } from "./paypal.ts";
import { isPaid, newState, ownerEvent, type PayPal } from "./shop.ts";

const PORT = Number(process.env.PORT ?? 3000);
// ponytail: no login. The owner panel is for a local or demo deployment; bind to localhost unless HOST is set.
const HOST = process.env.HOST ?? "127.0.0.1";
// Host allowlist blocks DNS rebinding: a hostile domain resolving to this machine still sends its own Host.
const HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, ...(process.env.PUBLIC_HOST ? [process.env.PUBLIC_HOST] : [])]);
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
const mock = !(id && secret) ? mockPayPal() : undefined;
const paypal: PayPal = mock ? mock.run : realPayPal(id!, secret!);
const toolSchemas = paypalToolSchemas();

let state = newState();
let agent = createAgent(state, paypal, toolSchemas);

const body = async (req: IncomingMessage) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
};

async function ownerAction(action: string, eventId: number) {
  const e = state.owner.find((x) => x.id === eventId && x.status === "open");
  if (!e) throw new Error("That item is no longer open.");
  const kind = action.endsWith("_quote") ? "quote" : "payment";
  if (e.kind !== kind) throw new Error("That button does not belong to this item.");
  if (kind === "quote" ? state.quote?.status !== "pending" : state.paymentClaim?.status !== "pending") throw new Error("Nothing is waiting for that answer.");
  e.status = "done";
  if (action === "approve_quote" && state.quote) {
    state.quote.status = "approved";
    return agent.say(`The owner approved the quote of £${state.quote.total}. Create and send the invoice now.`, "event");
  }
  if (action === "reject_quote" && state.quote) {
    state.quote.status = "rejected";
    state.quote = undefined;
    return agent.say("The owner rejected the quote. Apologise and say the owner will call to discuss the job.", "event");
  }
  if (action === "confirm_payment" && state.paymentClaim) {
    state.paymentClaim.status = "confirmed";
    return agent.say("The owner confirmed the money arrived. Record the payment now.", "event");
  }
  if (action === "reject_payment" && state.paymentClaim) {
    state.paymentClaim.status = "rejected";
    return agent.say("The owner cannot see the payment yet. Ask the customer politely for the transfer reference.", "event");
  }
  throw new Error(`Unknown action ${action}`);
}

// Payment watcher: polls the invoice and tells the agent once it is paid on PayPal.
async function checkPayment() {
  const inv = state.invoice;
  if (!inv || inv.notifiedPaid || inv.status === "DRAFT") return;
  const detail: any = await paypal("get_invoice", { invoice_id: inv.id });
  inv.status = detail?.status ?? inv.status;
  if (isPaid(inv.status)) {
    inv.notifiedPaid = true;
    ownerEvent(state, "info", `Invoice ${inv.id} paid on PayPal.`);
    await agent.say(`Invoice ${inv.id} has been paid on PayPal.`, "event");
  }
}
setInterval(() => checkPayment().catch((e) => console.error("payment check:", e.message)), 10_000);

createServer(async (req, res) => {
  const send = (code: number, data: unknown, type = "application/json") => {
    res.writeHead(code, { "content-type": type });
    res.end(type === "application/json" ? JSON.stringify(data) : (data as string));
  };
  try {
    if (!HOSTS.has(req.headers.host ?? "")) return send(403, { error: "unknown host" });
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method === "GET" && url.pathname === "/") return send(200, await readFile(new URL("../public/index.html", import.meta.url), "utf8"), "text/html");
    if (req.method === "GET" && url.pathname === "/api/state") return send(200, { ...state, mode: mock ? "mock" : "sandbox" });
    if (req.method === "GET" && url.pathname.startsWith("/pay/") && mock) {
      mock.pay(url.pathname.slice(5));
      return send(200, "<p>Demo payment done. Go back to the chat.</p>", "text/html");
    }
    if (req.method !== "POST") return send(404, { error: "not found" });
    // Reject cross-site POSTs: a page on another origin must not be able to press the owner's buttons.
    const origin = req.headers.origin;
    if (!origin || !URL.canParse(origin) || !HOSTS.has(new URL(origin).host)) return send(403, { error: "cross-origin request" });

    const b = await body(req);
    if (url.pathname === "/api/customer") {
      const text = String(b.text ?? "").trim().slice(0, 2000);
      if (!text) return send(400, { error: "empty message" });
      state.chat.push({ from: "customer", text, at: new Date().toISOString() });
      return send(200, { reply: await agent.say(text, "customer") });
    }
    if (url.pathname === "/api/owner") return send(200, { reply: await ownerAction(String(b.action), Number(b.id)) });
    if (url.pathname === "/api/simulate-overdue") {
      if (!state.invoice || isPaid(state.invoice.status)) return send(400, { error: "no unpaid invoice" });
      return send(200, { reply: await agent.say(`Seven days have passed. Invoice ${state.invoice.id} is overdue and unpaid.`, "event") });
    }
    if (url.pathname === "/api/reset") {
      state = newState();
      agent = createAgent(state, paypal, toolSchemas);
      return send(200, { ok: true });
    }
    send(404, { error: "not found" });
  } catch (err) {
    console.error(err);
    send(500, { error: (err as Error).message });
  }
}).listen(PORT, HOST, () => console.log(`quote-to-cash-agent on http://${HOST}:${PORT} (${mock ? "mock PayPal" : "PayPal sandbox"})`));
