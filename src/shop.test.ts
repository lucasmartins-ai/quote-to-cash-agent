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
