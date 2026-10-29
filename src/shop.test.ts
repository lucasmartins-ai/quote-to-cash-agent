import assert from "node:assert/strict";
import { test } from "node:test";
import { failIfError, mockPayPal } from "./paypal.ts";
import { handleTool, newState, priceQuote } from "./shop.ts";

const bill = { customer_name: "Sam Taylor", customer_email: "sam@example.com" };

test("prices come from the catalogue", () => {
  const q = priceQuote([{ service_id: "deep-clean", quantity: 1 }, { service_id: "oven", quantity: 2 }]);
  assert.equal(q.total, "350.00");
  assert.throws(() => priceQuote([{ service_id: "free-clean", quantity: 1 }]), /Unknown service_id/);
  assert.throws(() => priceQuote([{ service_id: "oven", quantity: 0 }]), /whole number/);
});

test("no invoice before the owner approves, and the invoice uses the approved lines", async () => {
  const { run } = mockPayPal();
  const s = newState();
  await handleTool(s, run, "propose_quote", { items: [{ service_id: "deep-clean", quantity: 1 }] });
  await assert.rejects(handleTool(s, run, "create_invoice", bill), /not approved/);

  s.quote!.status = "approved";
  const seen: any[] = [];
  const spy = async (name: string, input: any) => (seen.push([name, input]), run(name, input));
  await assert.rejects(handleTool(s, spy, "create_invoice", { customer_name: "Sam", customer_email: "nope" }), /valid email/);
  // The model tries to slip in its own price and extra charges; only the approved quote reaches PayPal.
  await handleTool(s, spy, "create_invoice", { ...bill, shipping_cost: "500.00", allow_tip: true, items: [{ name: "x", quantity: "1", unit_amount: { currency_code: "GBP", value: "1.00" } }] });
  const sent = seen[0][1];
  assert.equal(sent.items[0].unit_amount.value, "220.00");
  assert.equal(sent.shipping_cost, undefined);
  assert.equal(sent.allow_tip, undefined);
  assert.equal(sent.primary_recipients[0].billing_info.email_address, "sam@example.com");
  assert.match(s.invoice!.id, /^INV2-/);
});

test("only this conversation's invoice can be sent or reminded", async () => {
  const { run } = mockPayPal();
  const s = newState();
  await handleTool(s, run, "propose_quote", { items: [{ service_id: "oven", quantity: 1 }] });
  s.quote!.status = "approved";
  await handleTool(s, run, "create_invoice", bill);
  await assert.rejects(handleTool(s, run, "send_invoice", { invoice_id: "INV2-AAAA-BBBB-CCCC-DDDD" }), /Only invoice/);
  const sent = await handleTool(s, run, "send_invoice", { invoice_id: s.invoice!.id });
  assert.match(sent, /pay\/INV2-/);
  assert.match(await handleTool(s, run, "send_invoice_reminder", { invoice_id: s.invoice!.id }), /Reminder sent/);
});

test("a payment is recorded only after the owner confirms it", async () => {
  const { run } = mockPayPal();
  const s = newState();
  await handleTool(s, run, "propose_quote", { items: [{ service_id: "windows", quantity: 1 }] });
  s.quote!.status = "approved";
  await handleTool(s, run, "create_invoice", bill);
  await handleTool(s, run, "send_invoice", { invoice_id: s.invoice!.id });
  await handleTool(s, run, "ask_owner_to_confirm_payment", { method: "BANK_TRANSFER", customer_said: "sent it this morning" });
  await assert.rejects(handleTool(s, run, "record_payment_for_invoice", { invoice_id: s.invoice!.id, method: "CASH" }), /not confirmed/);

  s.paymentClaim!.status = "confirmed";
  await handleTool(s, run, "record_payment_for_invoice", { invoice_id: s.invoice!.id, method: "CASH" });
  assert.equal(s.invoice!.status, "MARKED_AS_PAID");
  await assert.rejects(handleTool(s, run, "send_invoice_reminder", { invoice_id: s.invoice!.id }), /already paid/);
});

test("a new quote closes the previous quote's approval item", async () => {
  const { run } = mockPayPal();
  const s = newState();
  await handleTool(s, run, "propose_quote", { items: [{ service_id: "oven", quantity: 1 }] });
  await handleTool(s, run, "propose_quote", { items: [{ service_id: "deep-clean", quantity: 1 }] });
  const open = s.owner.filter((e) => e.kind === "quote" && e.status === "open");
  assert.equal(open.length, 1);
  assert.match(open[0].text, /220\.00/);
});

test("a PayPal rejection returned as a value becomes an error", () => {
  assert.throws(() => failIfError({ ok: false, status: 422, code: "UNPROCESSABLE_ENTITY", message: "bad amount" }), /PayPal rejected.*bad amount/);
  assert.throws(() => failIfError({ error: { message: "boom", type: "paypal_error" } }), /PayPal rejected.*boom/);
  assert.deepEqual(failIfError({ id: "INV2-AAAA-BBBB-CCCC-DDDD", status: "SENT" }), { id: "INV2-AAAA-BBBB-CCCC-DDDD", status: "SENT" });
});

test("a new payment claim closes the previous Money arrived item", async () => {
  const { run } = mockPayPal();
  const s = newState();
  await handleTool(s, run, "propose_quote", { items: [{ service_id: "oven", quantity: 1 }] });
  s.quote!.status = "approved";
  await handleTool(s, run, "create_invoice", bill);
  await handleTool(s, run, "ask_owner_to_confirm_payment", { method: "BANK_TRANSFER", customer_said: "sent it" });
  await handleTool(s, run, "ask_owner_to_confirm_payment", { method: "CASH", customer_said: "paid cash" });
  const open = s.owner.filter((e) => e.kind === "payment" && e.status === "open");
  assert.equal(open.length, 1);
  assert.match(open[0].text, /CASH/);
});

test("in the public demo the invoice goes to the fixed sandbox address", async () => {
  process.env.DEMO_RECIPIENT_EMAIL = "buyer@sandbox.example";
  try {
    const { run } = mockPayPal();
    const s = newState();
    await handleTool(s, run, "propose_quote", { items: [{ service_id: "oven", quantity: 1 }] });
    s.quote!.status = "approved";
    const seen: any[] = [];
    await handleTool(s, async (n, i) => (seen.push(i), run(n, i)), "create_invoice", { customer_name: "Eve", customer_email: "stranger@example.com" });
    assert.equal(seen[0].primary_recipients[0].billing_info.email_address, "buyer@sandbox.example");
  } finally {
    Reflect.deleteProperty(process.env, "DEMO_RECIPIENT_EMAIL");
  }
});

const inDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

test("a repeating plan is built from the approved quote, and only after approval", async () => {
  const { run } = mockPayPal();
  const s = newState();
  await handleTool(s, run, "propose_quote", { items: [{ service_id: "regular-clean", quantity: 1 }], repeat_every_weeks: 2, start_date: inDays(3) });
  await assert.rejects(handleTool(s, run, "create_recurring_plan", bill), /not approved/);
  await assert.rejects(handleTool(s, run, "create_invoice", bill), /not approved/);
  s.quote!.status = "approved";
  await assert.rejects(handleTool(s, run, "create_invoice", bill), /repeating plan/);
  const seen: any[] = [];
  const spy = async (n: string, i: any) => (seen.push([n, i]), run(n, i));
  await handleTool(s, spy, "create_recurring_plan", { ...bill, interval_count: 1, total_cycles: 99, items: [{ name: "x", quantity: "1", unit_amount: { currency_code: "GBP", value: "1.00" } }] });
  const [name, payload] = seen[0];
  assert.equal(name, "create_recurring_series");
  assert.equal(payload.interval_count, 2);
  assert.equal(payload.start_series_date, inDays(3));
  assert.equal(payload.items[0].unit_amount.value, "75.00");
  assert.equal(payload.total_cycles, 12);
  assert.equal(seen[1][0], "activate_recurring_series");
  assert.match(s.series!.id, /^RI-/);
  await assert.rejects(handleTool(s, run, "create_recurring_plan", bill), /already set up/);
});

test("only repeatable services, and a start date inside the window, can become a plan", async () => {
  const { run } = mockPayPal();
  const s = newState();
  await assert.rejects(handleTool(s, run, "propose_quote", { items: [{ service_id: "deep-clean", quantity: 1 }], repeat_every_weeks: 2, start_date: inDays(3) }), /cannot be booked as a repeating plan/);
  await assert.rejects(handleTool(s, run, "propose_quote", { items: [{ service_id: "regular-clean", quantity: 1 }], repeat_every_weeks: 3, start_date: inDays(3) }), /must be 1, 2 or 4/);
  await assert.rejects(handleTool(s, run, "propose_quote", { items: [{ service_id: "regular-clean", quantity: 1 }], repeat_every_weeks: 1, start_date: inDays(0) }), /start_date must be between/);
  await assert.rejects(handleTool(s, run, "propose_quote", { items: [{ service_id: "regular-clean", quantity: 1 }], repeat_every_weeks: 1, start_date: inDays(90) }), /start_date must be between/);
});

test("an impossible date is refused, and the number of visits is part of the approved quote", async () => {
  const { run } = mockPayPal();
  const s = newState();
  const y = new Date().getUTCFullYear() + 1;
  await assert.rejects(handleTool(s, run, "propose_quote", { items: [{ service_id: "regular-clean", quantity: 1 }], repeat_every_weeks: 2, start_date: `${y}-02-30` }), /real date/);
  await handleTool(s, run, "propose_quote", { items: [{ service_id: "regular-clean", quantity: 1 }], repeat_every_weeks: 2, start_date: inDays(5) });
  assert.equal(s.quote!.repeat!.cycles, 12);
  assert.match(s.owner.at(-1)!.text, /12 visits/);
});

test("a lost activation reply resumes the same plan instead of creating a second one", async () => {
  const { run } = mockPayPal();
  const s = newState();
  await handleTool(s, run, "propose_quote", { items: [{ service_id: "regular-clean", quantity: 1 }], repeat_every_weeks: 1, start_date: inDays(2) });
  s.quote!.status = "approved";
  const calls: string[] = [];
  let failOnce = true;
  const flaky = async (n: string, i: any) => {
    calls.push(n);
    if (n === "activate_recurring_series" && failOnce) { failOnce = false; throw new Error("timeout"); }
    if (n === "get_recurring_series") return { status: "DRAFT" };
    return run(n, i);
  };
  await assert.rejects(handleTool(s, flaky, "create_recurring_plan", bill), /timeout/);
  assert.ok(s.seriesDraft);
  await handleTool(s, flaky, "create_recurring_plan", bill);
  assert.equal(calls.filter((n) => n === "create_recurring_series").length, 1);
  assert.match(s.series!.id, /^RI-/);
  assert.equal(s.seriesDraft, undefined);
});
