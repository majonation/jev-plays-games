import test from "node:test";
import assert from "node:assert/strict";
import { jsonTokens } from "../public/debug.js";

test("JSON highlighting preserves provider content including escapes and HTML-like strings", () => {
  const value = {
    'escaped"key': '<script>alert("hello")</script> & \\ true 123',
    movement: "flap",
    confidence: 0.85,
    number: -1.2e-7,
    optional: null,
    enabled: true,
    list: [false, "false", "123"],
  };
  const tokens = jsonTokens(value);
  assert.equal(tokens.map((token) => token.text).join(""), JSON.stringify(value, null, 2));
  assert.ok(tokens.some((token) => token.type === "key" && token.text === '"escaped\\"key"'));
  assert.ok(tokens.some((token) => token.type === "string" && token.text.includes("<script>")));
  assert.ok(tokens.some((token) => token.type === "boolean" && token.text === "false"));
  assert.ok(tokens.some((token) => token.type === "string" && token.text === '"false"'));
  assert.ok(tokens.some((token) => token.type === "number" && token.text === "-1.2e-7"));
});
