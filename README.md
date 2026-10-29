# Quote-to-Cash Agent

A chat agent that turns a customer's WhatsApp-style conversation into a PayPal invoice and a confirmed payment, while the business owner stays in control of every price.

Built for the PayPal AI Hackathon 2026 with [Claude](https://www.anthropic.com/claude) and the [PayPal Agent Toolkit](https://github.com/paypal/agent-toolkit).

## The problem

Small service businesses (cleaners, repairers, tutors) sell over chat. The owner answers "how much for…", works out a price, writes an invoice somewhere else, sends a link, then chases the payment days later. Most of that is copy and paste, and the chasing is the part that gets forgotten.

## What it does

1. **Customer asks in chat.** The agent finds out what they need, when, and who to bill.
2. **Agent prices it from the owner's catalogue** and sends the quote to the owner panel. The model chooses services and quantities; it cannot set or change a price.
3. **Owner taps Approve.** Only then does the agent create and send a PayPal invoice, and give the customer the payment link.
4. **Payment lands.** The server polls the invoice; when PayPal marks it paid, the agent thanks the customer and confirms the booking.
5. **Payment doesn't land.** After the due date the agent sends a PayPal reminder and one polite nudge in the chat.
6. **"I paid by bank transfer."** The agent asks the owner to check the account. It records the payment on the invoice only after the owner confirms. It never marks money as received on the customer's word.

## Guardrails are code, not prompt

The rules that protect the owner live in [`src/shop.ts`](src/shop.ts), not in the system prompt:

| Rule | Where it is enforced |
| --- | --- |
| Prices come only from `catalog.json` | `propose_quote` prices the items itself; for `create_invoice` the model can only give the customer's name and email, and the server builds the rest (lines, currency, no shipping, tips or partial payments) from the approved quote |
| No invoice before the owner approves | `create_invoice` refuses while the quote is pending; a new quote closes the previous Approve button |
| The agent touches only this conversation's invoice | `send_invoice`, `get_invoice`, `send_invoice_reminder` and `record_payment_for_invoice` reject any other id |
| No payment recorded without the owner | `record_payment_for_invoice` refuses until the owner confirms; amount and date are set by the server |
| No reminder on a paid invoice | `send_invoice_reminder` refuses once the invoice is paid |

[`src/shop.test.ts`](src/shop.test.ts) checks each of these, including a model trying to slip its own price into the invoice.

## PayPal and AI used

- **PayPal Invoicing API through the PayPal Agent Toolkit** (`@paypal/agent-toolkit`): `create_invoice`, `send_invoice`, `get_invoice`, `send_invoice_reminder`, `record_payment_for_invoice`. The model sees the toolkit's own tool schemas, except `create_invoice`, which is narrowed to name and email; every call runs through `PayPalAgentToolkit.handleToolCall` against the sandbox.
- **Claude** (`claude-opus-5-5` by default, set `MODEL` to change) through the official Anthropic TypeScript SDK, with tool use. Shop events (owner approved, invoice paid, invoice overdue) are fed to the same conversation, so the agent reacts to them in context.

## Run it

Requires Node 22.9+.

```bash
npm install
cp .env.example .env   # add ANTHROPIC_API_KEY; PayPal keys optional
npm start              # http://localhost:3000
```

- **With PayPal sandbox keys** in `.env`, invoices are real sandbox invoices: the payment link opens PayPal's sandbox page, and paying it with a [sandbox personal account](https://developer.paypal.com/dashboard/accounts) flips the invoice to paid within about 10 seconds.
- **Without PayPal keys**, a built-in mock stands in for PayPal and the payment link marks the invoice as paid, so the whole flow runs with only a Claude key.

Use the invoice email of a sandbox personal account as the customer's email, so PayPal can deliver the sandbox invoice.

### Try this script

1. As the customer: *"Hi, I'm moving out of my flat in Clifton next Friday. Need an end of tenancy clean and the oven done, 2 bedrooms."*
2. Give a name and email when asked.
3. In the owner panel, approve the quote. The payment link appears in the chat.
4. Either pay it, or press **Skip 7 days unpaid** to see the reminder, or reply *"I paid by bank transfer this morning"* and confirm it in the owner panel.

```bash
npm test        # guardrail tests, no keys needed
npm run typecheck
```

## Hosting a public demo

Set `DEMO=1` to run it for strangers: each visitor gets their own conversation (cookie), and Claude spend is capped.

| Variable | Default | What it does |
| --- | --- | --- |
| `DEMO` | off | `1` turns on per-visitor sessions, limits and the demo notice |
| `DEMO_RECIPIENT_EMAIL` | required with `DEMO=1` | every invoice goes to this sandbox address, never to what a visitor types |
| `SESSION_TURN_CAP` | 30 | agent turns per conversation (Start over keeps the count) |
| `DAILY_CALL_CAP` | 600 | Claude API calls per day across everyone (a turn can take several) |
| `MAX_SESSIONS` | 200 | conversations kept in memory; idle ones expire after 2 h |
| `MODEL`, `EFFORT` | `claude-opus-5-5`, `low` | the Claude model and effort; the hosted demo runs `claude-haiku-5-5` at `medium` |
| `HOST`, `PUBLIC_HOST` | `127.0.0.1`, none | bind address and the public host name the server accepts |

New conversations are limited to 6 per IP per hour. Put a monthly spend limit on the Anthropic key as well; the caps above are a second line.

## Layout

```
src/catalog.json   services and prices (the owner's, edited by hand)
src/shop.ts        state, tool definitions and the guardrails
src/paypal.ts      PayPal Agent Toolkit wiring, plus the mock
src/agent.ts       Claude tool-use loop for one conversation
src/server.ts      HTTP server, owner actions, payment watcher
public/index.html  customer chat and owner panel
```

## Limits

- One conversation at a time, kept in memory. A real deployment needs a store keyed by phone number and the WhatsApp Business API in front of `/api/customer`.
- Paid status is found by polling. PayPal webhooks (`INVOICING.INVOICE.PAID`) would replace the poll in production.
- The catalogue is fixed prices only; jobs that need a site visit should go to the owner.
- The owner panel has no login. The server binds to `127.0.0.1`; for a hosted demo set `HOST=0.0.0.0` and `PUBLIC_HOST=<your.domain>`, and only if you are happy for anyone with the URL to drive it. Requests with any other Host header, and POSTs without a matching Origin, are refused.

## License

MIT
