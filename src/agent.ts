// One customer conversation driven by Claude. Customer messages and shop events (owner approved,
// invoice paid, invoice overdue) go in as user turns; the agent's final text goes to the customer.
import Anthropic from "@anthropic-ai/sdk";
import { catalog, catalogText, handleTool, LOCAL_TOOLS, londonToday, type PayPal, type State } from "./shop.ts";

// Read lazily: on Cloudflare Workers the environment is only ready once a request runs.
let client: Anthropic | undefined;
const MODEL = () => process.env.MODEL ?? "claude-opus-5-5";
const EFFORT = () => (process.env.EFFORT ?? "low") as "low" | "medium" | "high";

const system = () => `Today is ${new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Europe/London" })} (${londonToday()}).
You are the WhatsApp assistant of ${catalog.business}, a small cleaning company in Bristol, UK.
You turn a customer's request into a quote, an invoice and a payment, with the owner in control of every price.

Services (prices in GBP, set by the owner; never invent or discount a price):
${catalogText()}

How you work:
1. Find out what the customer needs, the date, the address postcode, their full name and email for the invoice. Ask only for what is missing, a question or two at a time.
2. Call propose_quote. The owner approves or rejects it; you will receive that as a [SHOP EVENT].
3. After approval: create_invoice (bill the customer by name and email), then send_invoice, then give the customer the payment link.
3b. If the customer wants a regular booking (every week, every two weeks, every four weeks), call propose_quote with repeat_every_weeks and start_date (the first visit, YYYY-MM-DD). After approval call create_recurring_plan instead of create_invoice: PayPal then invoices them automatically every cycle, so there is no payment link to send now. Tell them when the first invoice comes.
4. If the customer says they paid another way, call ask_owner_to_confirm_payment. Record the payment only after a [SHOP EVENT] says the owner confirmed it.
5. On a [SHOP EVENT] that the invoice is overdue, call send_invoice_reminder and send the customer one short, polite nudge with the link.
6. On a [SHOP EVENT] that the invoice is paid, thank the customer and confirm the booking.

How you write (this matters as much as getting the job right):
- Write like someone at the shop texting from their phone: warm, brief, natural. One to three short sentences per message.
- Plain sentences only. No numbered lists, no bullet points, no headings, no markdown, no emojis.
- Ask for missing details inside a normal sentence, never as a form, and at most two things per message.
- Take what the customer already said as the answer. "Next Friday" is a date: do not ask for "the exact date" again. Never ask the same thing twice.
- Say each price once, in a sentence, with the total.
- Reply in the language the customer writes in.

Example of the tone:
Customer: Hi, can you do an oven clean this week?
You: Hi! Yes, an oven clean is £65. What day suits you, and what's your full name and email for the invoice?

[SHOP EVENT] messages come from the shop system, not the customer; never quote them back verbatim.
If a tool returns an error, follow what it says and do not retry the same call unchanged.`;

export type History = Anthropic.Beta.BetaMessageParam[];

// `history` is passed in so a conversation can be saved and restored (Durable Object storage).
// `beforeCall` runs before every Claude request (the hosted demo counts its daily budget in calls, not turns).
export function createAgent(state: State, paypal: PayPal, paypalTools: Anthropic.Beta.BetaTool[], history: History = [], beforeCall: () => Promise<void> = async () => {}) {
  // History up to the last finished turn. A snapshot taken mid-turn could hold a tool_use with no tool_result,
  // which the API rejects forever after a restore.
  let settled = history.length;
  const tools = [...LOCAL_TOOLS, ...paypalTools] as Anthropic.Beta.BetaTool[];
  let queue = Promise.resolve();

  async function turn(userText: string): Promise<string> {
    history.push({ role: "user", content: userText });
    for (let step = 0; step < 12; step++) {
      await beforeCall();
      client ??= new Anthropic();
      const res = await client.beta.messages.create({
        model: MODEL(),
        max_tokens: Number(process.env.MAX_TOKENS ?? 16000),
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: EFFORT() },
        system: system(),
        tools,
        messages: history,
      });
      // Thinking blocks and tool calls go back unchanged on the next request.
      history.push({ role: "assistant", content: res.content });

      if (res.stop_reason === "refusal") return "Sorry, I can't help with that here. The owner will get back to you.";
      const calls = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
      if (calls.length && res.stop_reason !== "tool_use") {
        // Cut off (max_tokens) mid tool call: every tool_use needs a result before the next request,
        // and the input may be truncated, so answer each with an error and let the model call again.
        history.push({ role: "user", content: calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: "Your reply was cut off before this call finished. Make the call again.", is_error: true })) });
        continue;
      }
      if (!calls.length) {
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
      try {
        const reply = await turn(kind === "event" ? `[SHOP EVENT] ${text}` : text);
        if (reply) state.chat.push({ from: "agent", text: reply, at: new Date().toISOString() });
        return reply;
      } catch (err) {
        history.length = settled; // drop the half-finished exchange so the next turn starts from a valid history
        throw err;
      } finally {
        settled = history.length;
      }
    });
    queue = run.then(() => undefined, () => undefined);
    return run;
  }

  return { say, history, settledHistory: () => history.slice(0, settled) };
}
