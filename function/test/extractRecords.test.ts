import { test } from "node:test";
import assert from "node:assert/strict";
import { extractRecords } from "../src/extractRecords.js";

const sampleEnvelope = {
  records: [
    { operationName: "OP/A", resourceId: "/subscriptions/s/resourceGroups/r" },
    { operationName: "OP/B", resourceId: "/subscriptions/s/resourceGroups/r" },
  ],
};

const noopLogger = { warn: () => {} };

test("object envelope with records array returns the array", () => {
  const out = extractRecords(sampleEnvelope, noopLogger);
  assert.equal(out?.length, 2);
  assert.equal(out?.[0].operationName, "OP/A");
});

test("object without records array is treated as a single record", () => {
  const single = { operationName: "OP/C" };
  const out = extractRecords(single, noopLogger);
  assert.equal(out?.length, 1);
  assert.equal(out?.[0].operationName, "OP/C");
});

test("Buffer input is JSON-parsed", () => {
  const buf = Buffer.from(JSON.stringify(sampleEnvelope), "utf8");
  const out = extractRecords(buf, noopLogger);
  assert.equal(out?.length, 2);
});

test("Uint8Array input is JSON-parsed", () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ operationName: "OP/UINT" }));
  const out = extractRecords(bytes, noopLogger);
  assert.equal(out?.length, 1);
  assert.equal(out?.[0].operationName, "OP/UINT");
});

test("string input is JSON-parsed", () => {
  const out = extractRecords(JSON.stringify(sampleEnvelope), noopLogger);
  assert.equal(out?.length, 2);
});

test("malformed JSON string returns null and warns", () => {
  const warnings: string[] = [];
  const out = extractRecords("not-json", { warn: (m) => warnings.push(m) });
  assert.equal(out, null);
  assert.ok(warnings.some((w) => w.includes("not valid JSON")));
});

test("malformed binary JSON returns null and warns", () => {
  const warnings: string[] = [];
  const out = extractRecords(Buffer.from("not-json"), { warn: (m) => warnings.push(m) });
  assert.equal(out, null);
  assert.ok(warnings.some((w) => w.includes("not valid JSON")));
});

test("null/undefined/primitive inputs return null", () => {
  assert.equal(extractRecords(null, noopLogger), null);
  assert.equal(extractRecords(undefined, noopLogger), null);
  assert.equal(extractRecords(42, noopLogger), null);
});

test("records array filters out non-objects", () => {
  const mixed = {
    records: [
      { operationName: "OP/A" },
      "a string",
      null,
      42,
      { operationName: "OP/B" },
    ],
  };
  const out = extractRecords(mixed, noopLogger);
  assert.equal(out?.length, 2);
});
