// Real PayPal (sandbox) through the PayPal Agent Toolkit, or an in-memory stand-in when no
// credentials are set, so the demo and the tests run without an account.
import { PayPalAgentToolkit } from "@paypal/agent-toolkit/bedrock";
import { PAYPAL_TOOLS, type PayPal } from "./shop.ts";

const toolkitFor = (clientId: string, clientSecret: string) =>
  new PayPalAgentToolkit({
    clientId,
    clientSecret,
    configuration: {
      actions: { invoices: { create: true, send: true, get: true, sendReminder: true, recordPayment: true } },
      context: { sandbox: process.env.PAYPAL_ENVIRONMENT !== "live" },
    },
  });

// The toolkit's own JSON schemas are what the model sees for the PayPal tools, in both modes.
export const paypalToolSchemas = () =>
  toolkitFor("schema-only", "schema-only")
    .getTools()
    .filter((t) => PAYPAL_TOOLS.includes(t.toolSpec.name))
    .map((t) => ({ name: t.toolSpec.name, description: t.toolSpec.description, input_schema: t.toolSpec.inputSchema.json }));

export function realPayPal(clientId: string, clientSecret: string): PayPal {
  const toolkit = toolkitFor(clientId, clientSecret);
  return async (name, input) => {
    const res = await toolkit.handleToolCall({ toolUseId: "x", name, input });
    // The toolkit JSON-encodes PayPal's response, which can itself be a JSON string: unwrap until it is an object.
    let out: unknown = res.content[0]?.text ?? "null";
    for (let i = 0; i < 3 && typeof out === "string"; i++) {
      try {
        out = JSON.parse(out);
      } catch {
        break;
      }
    }
    return failIfError(out);
  };
}

// The toolkit returns failures as values ({ok:false,...} or {error:{...}}) instead of throwing.
// Turn them into exceptions so no caller can mistake a PayPal rejection for success.
export function failIfError(out: unknown): unknown {
  const o = out as any;
  if (o && typeof o === "object" && (o.ok === false || (o.error && !o.id))) {
    const msg = o.message ?? o.error?.message ?? o.code ?? "unknown error";
    throw new Error(`PayPal rejected the request: ${String(msg).slice(0, 300)}`);
  }
  return out;
}

export function mockPayPal() {
  const invoices = new Map<string, { status: string; total: string }>();
  let n = 0;
  const id = () => `INV2-DEMO-${String(++n).padStart(4, "0")}-MOCK-PAYS`;
  const run: PayPal = async (name, input: any) => {
    switch (name) {
      case "create_invoice": {
        const inv = id();
        const total = input.items.reduce((t: number, l: any) => t + Number(l.unit_amount.value) * Number(l.quantity), 0);
        invoices.set(inv, { status: "DRAFT", total: total.toFixed(2) });
        return { rel: "self", href: `https://api.sandbox.paypal.com/v2/invoicing/invoices/${inv}` };
      }
      case "send_invoice":
        invoices.get(input.invoice_id)!.status = "SENT";
        return { status: "SENT" };
      case "get_invoice": {
        const inv = invoices.get(input.invoice_id)!;
        return {
          id: input.invoice_id,
          status: inv.status,
          due_amount: { value: inv.status === "SENT" ? inv.total : "0.00" },
          detail: { metadata: { recipient_view_url: `${process.env.PUBLIC_HOST ? `https://${process.env.PUBLIC_HOST}` : `http://localhost:${process.env.PORT ?? 3000}`}/pay/${input.invoice_id}` } },
        };
      }
      case "send_invoice_reminder":
        return { status: "REMINDER_SENT" };
      case "create_recurring_series":
        return { id: `RI-MOCK${String(++n).padStart(4, "0")}`, status: "DRAFT", plan_detail: { start_series_date: input.start_series_date } };
      case "activate_recurring_series":
        return { recurring_series_id: input.recurring_series_id, status: 204 };
      case "get_recurring_series":
        return { id: input.recurring_series_id, status: "ACTIVE" };
      case "record_payment_for_invoice":
        invoices.get(input.invoice_id)!.status = "MARKED_AS_PAID";
        return { payment_id: "EXTR-MOCK" };
      default:
        throw new Error(`mock has no ${name}`);
    }
  };
  // Stands in for the customer paying on PayPal's page.
  const pay = (inv: string) => {
    const x = invoices.get(inv);
    if (x) x.status = "PAID";
  };
  return { run, pay };
}
