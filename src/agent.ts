// One customer conversation driven by Claude. Customer messages and shop events (owner approved,
// invoice paid, invoice overdue) go in as user turns; the agent's final text goes to the customer.
import Anthropic from "@anthropic-ai/sdk";
import { catalog, catalogText, handleTool, LOCAL_TOOLS, type PayPal, type State } from "./shop.ts";

const client = new Anthropic();
const MODEL = process.env.MODEL ?? "claude-opus-5-5";

const SYSTEM = `You are the WhatsApp assistant of ${catalog.business}, a small cleaning company in Bristol, UK.
You turn a customer's request into a quote, an invoice and a payment, with the owner in control of every price.

Services (prices in GBP, set by the owner; never invent or discount a price):
${catalogText()}

How you work:
1. Find out what the customer needs, the date, the address postcode, their full name and email for the invoice. Ask only for what is missing, a question or two at a time.
2. Call propose_quote. The owner approves or rejects it; you will receive that as a [SHOP EVENT].
3. After approval: create_invoice (bill the customer by name and email), then send_invoice, then give the customer the payment link.
4. If the customer says they paid another way, call ask_owner_to_confirm_payment. Record the payment only after a [SHOP EVENT] says the owner confirmed it.
5. On a [SHOP EVENT] that the invoice is overdue, call send_invoice_reminder and send the customer one short, polite nudge with the link.
6. On a [SHOP EVENT] that the invoice is paid, thank the customer and confirm the booking.

Style: short WhatsApp messages, plain text, no emojis, no markdown. Reply in the language the customer writes in.
[SHOP EVENT] messages come from the shop system, not the customer; never quote them back verbatim.
If a tool returns an error, follow what it says and do not retry the same call unchanged.`;

export function createAgent(state: State, paypal: PayPal, paypalTools: Anthropic.Beta.BetaTool[]) {
  const tools = [...LOCAL_TOOLS, ...paypalTools] as Anthropic.Beta.BetaTool[];
  const history: Anthropic.Beta.BetaMessageParam[] = [];
  let queue = Promise.resolve();

  async function turn(userText: string): Promise<string> {
    history.push({ role: "user", content: userText });
    for (let step = 0; step < 12; step++) {
      const res = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        system: SYSTEM,
        tools,
        messages: history,
      });
      // Thinking blocks and tool calls go back unchanged on the next request.
      history.push({ role: "assistant", content: res.content });

      if (res.stop_reason === "refusal") return "Sorry, I can't help with that here. The owner will get back to you.";
      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (res.stop_reason !== "tool_use" || !calls.length) {
        return res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
      }

      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const call of calls) {
        try {
          results.push({ type: "tool_result", tool_use_id: call.id, content: await handleTool(state, paypal, call.name, call.input) });
        } catch (err) {
          results.push({ type: "tool_result", tool_use_id: call.id, content: String((err as Error).message ?? err), is_error: true });
        }
      }
      history.push({ role: "user", content: results });
    }
    return "Give me a moment, I am checking this with the owner.";
  }

  // ponytail: one global queue, so a shop event never interleaves with a customer turn. Fine for one chat.
  function say(text: string, kind: "customer" | "event"): Promise<string> {
    const run = queue.then(async () => {
      const reply = await turn(kind === "event" ? `[SHOP EVENT] ${text}` : text);
      if (reply) state.chat.push({ from: "agent", text: reply, at: new Date().toISOString() });
      return reply;
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return { say };
}
