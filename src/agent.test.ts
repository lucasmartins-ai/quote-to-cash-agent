import assert from "node:assert/strict";
import { test } from "node:test";
import { Messages } from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { createAgent } from "./agent.ts";
import { mockPayPal } from "./paypal.ts";
import { newState } from "./shop.ts";

test("a tool call cut off by max_tokens is answered before the next request", async () => {
  const sent: any[] = [];
  const replies = [
    { stop_reason: "max_tokens", content: [{ type: "tool_use", id: "t1", name: "propose_quote", input: {} }] },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Let me try that again." }] },
  ];
  (Messages.prototype as any).create = async function (params: any) {
    sent.push(structuredClone(params.messages));
    return replies.shift();
  };
  const agent = createAgent(newState(), mockPayPal().run, []);
  assert.equal(await agent.say("Quote an oven clean, please.", "customer"), "Let me try that again.");
  const second = sent[1];
  const toolUse = second.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_use").map((b: any) => b.id);
  const answered = second.flatMap((m: any) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "tool_result").map((b: any) => b.tool_use_id);
  assert.deepEqual(toolUse, ["t1"]);
  assert.deepEqual(answered, ["t1"]);
});
