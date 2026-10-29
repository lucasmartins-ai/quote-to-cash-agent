import assert from "node:assert/strict";
import { test } from "node:test";
import { addressGroup } from "./net.ts";

test("IPv6 addresses group by /64 however they are written", () => {
  const g = addressGroup("2001:db8:0:1::1");
  assert.equal(g, "2001:db8:0:1::/64");
  assert.equal(addressGroup("2001:0db8:0000:0001:ffff:0:0:2"), g);
  assert.equal(addressGroup("2001:db8::1"), "2001:db8:0:0::/64");
  assert.equal(addressGroup("2001:db8::"), "2001:db8:0:0::/64");
  assert.equal(addressGroup("::ffff:192.0.2.1"), "0:0:0:0::/64");
  assert.equal(addressGroup("203.0.113.9"), "203.0.113.9");
});
