import assert from "node:assert/strict";
import { test } from "node:test";
import { Messages } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { Conversation, HttpError, type DailyBudget } from "./conversation.ts";
import { mockPayPal } from "./paypal.ts";

test("two simultaneous messages cannot both get past a one-turn cap", async () => {
  (Messages.prototype as any).create = async () => {
    await new Promise((r) => setTimeout(r, 20)); // keep the first turn in flight while the second arrives
    return { stop_reason: "end_turn", content: [{ type: "text", text: "Hi!" }] };
  };
  let reserved = 0;
  const budget: DailyBudget = { async check() {}, async reserve() { reserved++; } };
  const c = new Conversation(mockPayPal().run, [], budget, 1);
  const results = await Promise.allSettled([c.customer("one", 600), c.customer("two", 600)]);
  const ok = results.filter((r) => r.status === "fulfilled").length;
  const capped = results.filter((r) => r.status === "rejected" && (r.reason as HttpError).code === 429).length;
  assert.equal(ok, 1);
  assert.equal(capped, 1);
  assert.equal(c.turns, 1);
  assert.equal(reserved, 1);
});
