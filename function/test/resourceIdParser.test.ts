import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSubscriptionId } from "../src/enrichment/resourceIdParser.js";

interface Case {
  name: string;
  input: string | undefined;
  expect: string | undefined;
}

const cases: Case[] = [
  { name: "undefined input", input: undefined, expect: undefined },
  { name: "empty string", input: "", expect: undefined },
  {
    name: "subscription only",
    input: "/subscriptions/00000000-0000-0000-0000-000000000000",
    expect: "00000000-0000-0000-0000-000000000000",
  },
  {
    name: "subscription + rg",
    input: "/subscriptions/sub1/resourceGroups/rg-web",
    expect: "sub1",
  },
  {
    name: "uppercase path (as seen in activity logs)",
    input:
      "/SUBSCRIPTIONS/SUB1/RESOURCEGROUPS/RG-WEB/PROVIDERS/MICROSOFT.CONTAINERINSTANCE/CONTAINERGROUPS/WEB-ACI",
    expect: "sub1",
  },
  {
    name: "tenant-scoped resource has no subscription",
    input: "/providers/Microsoft.Management/managementGroups/root-mg",
    expect: undefined,
  },
  {
    name: "trailing slash",
    input: "/subscriptions/sub1/resourceGroups/rg-web/",
    expect: "sub1",
  },
];

for (const tc of cases) {
  test(tc.name, () => {
    assert.equal(parseSubscriptionId(tc.input), tc.expect);
  });
}
