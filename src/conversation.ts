// One visitor's conversation: chat, owner buttons, overdue jump, payment watch and the turn budget.
// Shared by the Node server (src/server.ts) and the Cloudflare Worker (src/worker.ts).
import { createAgent, type History } from "./agent.ts";
import { isPaid, newState, ownerEvent, type PayPal, type State } from "./shop.ts";

export class HttpError extends Error {
  constructor(public code: number, message: string) { super(message); }
}

// Spend across all conversations (per day). The Node server keeps it in memory; the Worker in a Durable Object.
// check() is a read-only early answer; reserve() checks and counts one Claude call atomically and throws 429 when full.
export type DailyBudget = { check(): Promise<void>; reserve(): Promise<void> };

const LIMIT_MSG = "This demo conversation reached its message limit. Reload the page tomorrow, or run the code locally (see the GitHub README).";

export type Snapshot = { state: State; history: History; turns: number };

export class Conversation {
  state: State;
  turns: number;
  private agent: ReturnType<typeof createAgent>;

  constructor(private paypal: PayPal, private tools: any[], private budget: DailyBudget, private perConversation: number, snap?: Snapshot) {
    this.state = snap?.state ?? newState();
    this.turns = snap?.turns ?? 0;
    this.agent = createAgent(this.state, paypal, tools, snap?.history ?? [], () => budget.reserve());
  }

  snapshot(): Snapshot {
    return { state: this.state, history: this.agent.settledHistory(), turns: this.turns };
  }

  get turnsLeft() {
    return Math.max(0, this.perConversation - this.turns);
  }

  async checkBudget() {
    if (this.turns >= this.perConversation) throw new HttpError(429, LIMIT_MSG);
    await this.budget.check();
  }

  private async say(text: string, kind: "customer" | "event") {
    // Count the turn before any await, so two concurrent requests cannot both pass the per-conversation cap.
    if (this.turns >= this.perConversation) throw new HttpError(429, LIMIT_MSG);
    this.turns++;
    return this.agent.say(text, kind); // the daily budget is reserved per Claude call inside the agent
  }

  async customer(raw: unknown, maxLen: number) {
    const text = String(raw ?? "").trim().slice(0, maxLen);
    if (!text) throw new HttpError(400, "empty message");
    await this.checkBudget(); // before the message shows up in the chat
    this.state.chat.push({ from: "customer", text, at: new Date().toISOString() });
    return this.say(text, "customer");
  }

  async owner(action: string, eventId: number) {
    const { state } = this;
    await this.checkBudget(); // before any state changes, so a hit limit never leaves a half-approved quote
    const e = state.owner.find((x) => x.id === eventId && x.status === "open");
    if (!e) throw new HttpError(409, "That item is no longer open.");
    const kind = action.endsWith("_quote") ? "quote" : "payment";
    if (e.kind !== kind) throw new HttpError(400, "That button does not belong to this item.");
    if (kind === "quote" ? state.quote?.status !== "pending" : state.paymentClaim?.status !== "pending") throw new HttpError(409, "Nothing is waiting for that answer.");
    e.status = "done";
    if (action === "approve_quote" && state.quote) {
      state.quote.status = "approved";
      return this.say(`The owner approved the quote of £${state.quote.total}. Create and send the invoice now.`, "event");
    }
    if (action === "reject_quote" && state.quote) {
      state.quote.status = "rejected";
      state.quote = undefined;
      return this.say("The owner rejected the quote. Apologise and say the owner will call to discuss the job.", "event");
    }
    if (action === "confirm_payment" && state.paymentClaim) {
      state.paymentClaim.status = "confirmed";
      return this.say("The owner confirmed the money arrived. Record the payment now.", "event");
    }
    if (action === "reject_payment" && state.paymentClaim) {
      state.paymentClaim.status = "rejected";
      return this.say("The owner cannot see the payment yet. Ask the customer politely for the transfer reference.", "event");
    }
    throw new HttpError(400, `Unknown action ${action}`);
  }

  async overdue() {
    const inv = this.state.invoice;
    if (!inv || isPaid(inv.status)) throw new HttpError(400, "no unpaid invoice");
    return this.say(`Seven days have passed. Invoice ${inv.id} is overdue and unpaid.`, "event");
  }

  // A fresh conversation keeps the turn count, so Start over cannot be used to dodge the limit.
  reset() {
    this.state = newState();
    this.agent = createAgent(this.state, this.paypal, this.tools, [], () => this.budget.reserve());
  }

  // True while there is a sent, unpaid invoice worth polling.
  get watching() {
    const inv = this.state.invoice;
    return !!inv && !inv.notifiedPaid && inv.status !== "DRAFT";
  }

  // Polls the invoice and tells the agent once PayPal marks it paid.
  async checkPayment() {
    const st = this.state;
    const inv = st.invoice;
    if (!this.watching || !inv) return;
    const detail: any = await this.paypal("get_invoice", { invoice_id: inv.id });
    if (this.state !== st) return; // "Start over" happened while waiting: this answer belongs to the old conversation
    inv.status = detail?.status ?? inv.status;
    if (!isPaid(inv.status)) return;
    inv.notifiedPaid = true;
    ownerEvent(st, "info", `Invoice ${inv.id} paid on PayPal.`);
    try {
      await this.say(`Invoice ${inv.id} has been paid on PayPal.`, "event");
    } catch (err) {
      if (!(err instanceof HttpError && err.code === 429)) throw err;
      // Out of demo turns: still tell the customer, without Claude.
      st.chat.push({ from: "agent", text: `Thank you, your payment of £${st.quote?.total ?? ""} has arrived and your booking is confirmed.`, at: new Date().toISOString() });
    }
  }
}
