// The shop's state and every tool the agent can call. The gates live here, in code:
// prices come from the catalogue, nothing is invoiced before the owner approves the quote,
// a payment is only recorded after the owner confirms the money arrived, and a repeating plan is built
// by the server from the approved quote.
import catalog from "./catalog.json" with { type: "json" };

export type PayPal = (tool: string, input: Record<string, unknown>) => Promise<unknown>;

type Money = { currency_code: string; value: string };
export type Line = { name: string; description: string; quantity: string; unit_amount: Money };
export type ChatMsg = { from: "customer" | "agent"; text: string; at: string };
export type OwnerEvent = { id: number; kind: "quote" | "payment" | "info"; text: string; status: "open" | "done"; at: string };

export type State = {
  chat: ChatMsg[];
  owner: OwnerEvent[];
  quote?: { lines: Line[]; total: string; note: string; status: "pending" | "approved" | "rejected"; repeat?: Repeat };
  invoice?: { id: string; status: string; payUrl?: string; notifiedPaid?: boolean };
  paymentClaim?: { method: string; customerSaid: string; status: "pending" | "confirmed" | "rejected" };
  series?: { id: string; status: string; everyWeeks: number; start: string; cycles: number };
};
export type Repeat = { everyWeeks: 1 | 2 | 4; start: string };

const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86400_000).toISOString().slice(0, 10);

// A repeating plan: weekly, fortnightly or every four weeks, starting tomorrow at the earliest and within 60 days.
export function checkRepeat(items: { service_id: string }[], every: unknown, start: unknown): Repeat {
  if (![1, 2, 4].includes(Number(every))) throw new Error("repeat_every_weeks must be 1, 2 or 4.");
  const s = String(start ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new Error("start_date must be a date in YYYY-MM-DD format.");
  if (s <= today() || s > addDays(today(), 60)) throw new Error(`start_date must be between ${addDays(today(), 1)} and ${addDays(today(), 60)}.`);
  const notRepeatable = items.filter((i) => !catalog.services.find((x) => x.id === i.service_id)?.recurring).map((i) => i.service_id);
  if (notRepeatable.length) throw new Error(`These services cannot be booked as a repeating plan: ${notRepeatable.join(", ")}. Repeatable: ${catalog.services.filter((x) => x.recurring).map((x) => x.id).join(", ")}.`);
  return { everyWeeks: Number(every) as Repeat["everyWeeks"], start: s };
}

// Who to bill. Public demo: everything goes to one sandbox address, so visitors cannot make it email strangers.
function recipient(input: any) {
  const name = String(input.customer_name ?? "").trim();
  const email = String(input.customer_email ?? "").trim();
  if (!name || name.length > 100) throw new Error("customer_name is required (max 100 characters).");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) throw new Error("customer_email must be a valid email address.");
  const [given, ...rest] = name.split(/\s+/);
  return [{ billing_info: { name: { given_name: given, surname: rest.join(" ") || undefined }, email_address: process.env.DEMO_RECIPIENT_EMAIL || email } }];
}

export const newState = (): State => ({ chat: [], owner: [] });

const now = () => new Date().toISOString();
export function ownerEvent(s: State, kind: OwnerEvent["kind"], text: string): OwnerEvent {
  // Ids come from the conversation itself, so a restored conversation keeps counting where it left off.
  const id = s.owner.reduce((m, e) => Math.max(m, e.id), 0) + 1;
  const e: OwnerEvent = { id, kind, text, status: kind === "info" ? "done" : "open", at: now() };
  s.owner.push(e);
  return e;
}

export function priceQuote(items: { service_id: string; quantity: number }[]): { lines: Line[]; total: string } {
  if (!items.length) throw new Error("A quote needs at least one item.");
  let pence = 0;
  const lines = items.map(({ service_id, quantity }) => {
    const svc = catalog.services.find((x) => x.id === service_id);
    if (!svc) throw new Error(`Unknown service_id "${service_id}". Use one of: ${catalog.services.map((x) => x.id).join(", ")}.`);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error(`Quantity for ${service_id} must be a whole number from 1 to 20.`);
    pence += Math.round(Number(svc.price) * 100) * quantity;
    return {
      name: svc.name,
      description: svc.unit,
      quantity: String(quantity),
      unit_amount: { currency_code: catalog.currency, value: svc.price },
    };
  });
  return { lines, total: (pence / 100).toFixed(2) };
}

// PayPal returns the new invoice either as an id or as a link ending in it.
const invoiceIdIn = (x: unknown) => JSON.stringify(x).match(/INV2(?:-[A-Z0-9]{4}){4}/)?.[0];

export async function handleTool(s: State, paypal: PayPal, name: string, input: any): Promise<string> {
  switch (name) {
    case "propose_quote": {
      if (s.invoice || s.series) throw new Error("This conversation already has an invoice or a plan.");
      const { lines, total } = priceQuote(input.items ?? []);
      const repeat = input.repeat_every_weeks != null ? checkRepeat(input.items, input.repeat_every_weeks, input.start_date) : undefined;
      // A new quote supersedes any open one, so an old Approve button cannot approve it.
      for (const e of s.owner) if (e.kind === "quote" && e.status === "open") e.status = "done";
      s.quote = { lines, total, note: String(input.note ?? "").slice(0, 500), status: "pending", repeat };
      const summary = lines.map((l) => `${l.quantity} × ${l.name} @ £${l.unit_amount.value}`).join("; ");
      const plan = repeat ? ` every ${repeat.everyWeeks === 1 ? "week" : `${repeat.everyWeeks} weeks`} from ${repeat.start}` : "";
      ownerEvent(s, "quote", `Quote for £${total}${plan}: ${summary}${input.note ? ` (${input.note})` : ""}`);
      return `Quote of £${total}${plan} sent to the owner for approval. Tell the customer the total and that you will confirm shortly. Do not create an invoice or plan yet.`;
    }

    case "ask_owner_to_confirm_payment": {
      if (!s.invoice) throw new Error("There is no invoice to pay.");
      // A new claim supersedes any open one, so an old "Money arrived" button cannot confirm it.
      for (const e of s.owner) if (e.kind === "payment" && e.status === "open") e.status = "done";
      s.paymentClaim = { method: input.method, customerSaid: input.customer_said, status: "pending" };
      ownerEvent(s, "payment", `Customer says they paid by ${input.method}: "${input.customer_said}". Did the money arrive?`);
      return "The owner has been asked to check the account. Tell the customer you are checking and will confirm. Do not record the payment yet.";
    }

    case "create_invoice": {
      if (s.quote?.status !== "approved") throw new Error("The owner has not approved a quote yet. Wait for approval.");
      if (s.quote.repeat) throw new Error("This quote is a repeating plan. Use create_recurring_plan instead.");
      if (s.invoice) throw new Error(`Invoice ${s.invoice.id} already exists. Send that one.`);
      // The model only supplies who to bill. Everything that touches money (lines, currency,
      // shipping, tips, partial payment) is never taken from its input.
      const result = await paypal("create_invoice", {
        currency_code: catalog.currency,
        items: s.quote.lines,
        invoicer_business_name: catalog.business,
        primary_recipients: recipient(input),
      });
      const id = invoiceIdIn(result);
      if (!id) throw new Error(`PayPal did not return an invoice id: ${JSON.stringify(result).slice(0, 300)}`);
      s.invoice = { id, status: "DRAFT" };
      return `Draft invoice ${id} created for £${s.quote.total}. Now send it with send_invoice.`;
    }

    case "create_recurring_plan": {
      if (s.quote?.status !== "approved") throw new Error("The owner has not approved a quote yet. Wait for approval.");
      const repeat = s.quote.repeat;
      if (!repeat) throw new Error("The approved quote is a one-off job. Use create_invoice instead.");
      if (s.series) throw new Error(`Plan ${s.series.id} is already set up.`);
      if (repeat.start <= today()) throw new Error("The plan's start date has passed. Ask the customer for a new date and propose the quote again.");
      // Every cycle, amount and date comes from the approved quote; the model only says who to bill.
      const cycles = Number(process.env.PLAN_MAX_CYCLES ?? 12);
      const created: any = await paypal("create_recurring_series", {
        interval_unit: "WEEK",
        interval_count: repeat.everyWeeks,
        start_series_date: repeat.start,
        total_cycles: cycles,
        currency_code: catalog.currency,
        invoicer_business_name: catalog.business,
        items: s.quote.lines,
        primary_recipients: recipient(input),
      });
      const id = String(created?.id ?? "");
      if (!/^RI-[A-Z0-9]+$/.test(id)) throw new Error(`PayPal did not return a plan id: ${JSON.stringify(created).slice(0, 300)}`);
      await paypal("activate_recurring_series", { recurring_series_id: id });
      s.series = { id, status: "ACTIVE", everyWeeks: repeat.everyWeeks, start: repeat.start, cycles };
      ownerEvent(s, "info", `Plan ${id} active: £${s.quote.total} every ${repeat.everyWeeks === 1 ? "week" : `${repeat.everyWeeks} weeks`} from ${repeat.start}, ${cycles} invoices.`);
      return `Plan ${id} is active. PayPal will email an invoice for £${s.quote.total} on ${repeat.start} and then every ${repeat.everyWeeks === 1 ? "week" : `${repeat.everyWeeks} weeks`} (${cycles} visits). Tell the customer, plainly.`;
    }

    case "send_invoice": {
      assertOurs(s, input.invoice_id);
      await paypal("send_invoice", { invoice_id: s.invoice!.id, note: input.note, send_to_recipient: true });
      const detail: any = await paypal("get_invoice", { invoice_id: s.invoice!.id });
      s.invoice!.status = detail?.status ?? "SENT";
      s.invoice!.payUrl = detail?.detail?.metadata?.recipient_view_url;
      ownerEvent(s, "info", `Invoice ${s.invoice!.id} sent (£${s.quote!.total}).`);
      return `Invoice sent. Payment link for the customer: ${s.invoice!.payUrl ?? "(PayPal emailed it to the customer)"}`;
    }

    case "get_invoice": {
      assertOurs(s, input.invoice_id);
      const detail: any = await paypal("get_invoice", { invoice_id: s.invoice!.id });
      s.invoice!.status = detail?.status ?? s.invoice!.status;
      return JSON.stringify({ id: s.invoice!.id, status: s.invoice!.status, due: detail?.due_amount, paid: detail?.payments?.paid_amount });
    }

    case "send_invoice_reminder": {
      assertOurs(s, input.invoice_id);
      if (isPaid(s.invoice!.status)) throw new Error("This invoice is already paid. Do not send a reminder.");
      await paypal("send_invoice_reminder", { invoice_id: s.invoice!.id, subject: input.subject, note: input.note });
      ownerEvent(s, "info", `Reminder sent for invoice ${s.invoice!.id}.`);
      return "Reminder sent through PayPal.";
    }

    case "record_payment_for_invoice": {
      assertOurs(s, input.invoice_id);
      if (s.paymentClaim?.status !== "confirmed") throw new Error("The owner has not confirmed this payment. Never record a payment on the customer's word alone.");
      await paypal("record_payment_for_invoice", {
        invoice_id: s.invoice!.id,
        method: s.paymentClaim.method,
        payment_date: now().slice(0, 10),
        amount: { currency_code: catalog.currency, value: s.quote!.total },
        note: "Confirmed by the owner.",
      });
      s.invoice!.status = "MARKED_AS_PAID";
      s.invoice!.notifiedPaid = true;
      ownerEvent(s, "info", `Payment of £${s.quote!.total} recorded on ${s.invoice!.id}.`);
      return "Payment recorded on the invoice. Thank the customer.";
    }

    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

export const isPaid = (status: string) => status === "PAID" || status === "MARKED_AS_PAID";

function assertOurs(s: State, id: unknown) {
  if (!s.invoice) throw new Error("No invoice has been created yet.");
  if (id !== s.invoice.id) throw new Error(`Only invoice ${s.invoice.id} belongs to this conversation.`);
}

// create_invoice and create_recurring_plan get our own narrow schemas; the rest use the PayPal Agent Toolkit's schemas.
export const PAYPAL_TOOLS = ["send_invoice", "get_invoice", "send_invoice_reminder", "record_payment_for_invoice"];

const CREATE_INVOICE_TOOL = {
  name: "create_invoice",
  description:
    "Create the PayPal invoice for the approved quote. Line items, prices and currency are filled in from the approved quote; you only say who to bill.",
  input_schema: {
    type: "object" as const,
    properties: {
      customer_name: { type: "string", description: "The customer's full name." },
      customer_email: { type: "string", description: "The email PayPal sends the invoice to." },
    },
    required: ["customer_name", "customer_email"],
    additionalProperties: false,
  },
};

export const LOCAL_TOOLS = [
  {
    name: "propose_quote",
    description:
      "Price the services the customer asked for and send the quote to the owner for approval. Prices come from the catalogue; you only choose service ids and quantities. Call this once you know what the customer needs.",
    input_schema: {
      type: "object" as const,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              service_id: { type: "string", enum: catalog.services.map((x) => x.id) },
              quantity: { type: "integer", minimum: 1, maximum: 20 },
            },
            required: ["service_id", "quantity"],
            additionalProperties: false,
          },
        },
        note: { type: "string", description: "Date, address or anything the owner should know." },
        repeat_every_weeks: { type: "integer", enum: [1, 2, 4], description: "Only for a regular booking (weekly, fortnightly, every four weeks). Leave out for a one-off job." },
        start_date: { type: "string", description: "First visit of a regular booking, YYYY-MM-DD. Required with repeat_every_weeks." },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
  {
    name: "ask_owner_to_confirm_payment",
    description:
      "Use when the customer says they paid outside PayPal (bank transfer, cash). The owner checks the account; only after the owner confirms may you call record_payment_for_invoice.",
    input_schema: {
      type: "object" as const,
      properties: {
        method: { type: "string", enum: ["BANK_TRANSFER", "CASH", "OTHER"] },
        customer_said: { type: "string", description: "The customer's own words about the payment." },
      },
      required: ["method", "customer_said"],
      additionalProperties: false,
    },
  },
  CREATE_INVOICE_TOOL,
  {
    name: "create_recurring_plan",
    description:
      "Set up the approved repeating plan in PayPal: a recurring invoice series that bills the customer automatically every cycle. Services, price, frequency and start date come from the approved quote; you only say who to bill.",
    input_schema: CREATE_INVOICE_TOOL.input_schema,
  },
];

export function catalogText(): string {
  return catalog.services.map((x) => `- ${x.id}: ${x.name}, £${x.price} ${x.unit}${x.recurring ? " (can repeat)" : ""}`).join("\n");
}

export { catalog };
