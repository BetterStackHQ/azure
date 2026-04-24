import { test } from "node:test";
import assert from "node:assert/strict";
import { parseResourceId } from "../src/enrichment/resourceIdParser.js";

interface Case {
  name: string;
  input: string | undefined;
  expect: {
    subscriptionId?: string;
    resourceGroupName?: string;
    resourceProvider?: string;
    resourceType?: string;
    resourceName?: string;
  };
}

const cases: Case[] = [
  {
    name: "undefined input",
    input: undefined,
    expect: {},
  },
  {
    name: "empty string",
    input: "",
    expect: {},
  },
  {
    name: "subscription only",
    input: "/subscriptions/00000000-0000-0000-0000-000000000000",
    expect: { subscriptionId: "00000000-0000-0000-0000-000000000000" },
  },
  {
    name: "subscription + rg",
    input: "/subscriptions/sub1/resourceGroups/rg-web",
    expect: { subscriptionId: "sub1", resourceGroupName: "rg-web" },
  },
  {
    name: "simple resource",
    input:
      "/subscriptions/sub1/resourceGroups/rg-web/providers/Microsoft.ContainerInstance/containerGroups/web-aci",
    expect: {
      subscriptionId: "sub1",
      resourceGroupName: "rg-web",
      resourceProvider: "Microsoft.ContainerInstance",
      resourceType: "containerGroups",
      resourceName: "web-aci",
    },
  },
  {
    name: "uppercase path (as seen in activity logs)",
    input:
      "/SUBSCRIPTIONS/SUB1/RESOURCEGROUPS/RG-WEB/PROVIDERS/MICROSOFT.CONTAINERINSTANCE/CONTAINERGROUPS/WEB-ACI",
    expect: {
      subscriptionId: "sub1",
      resourceGroupName: "RG-WEB",
      resourceProvider: "MICROSOFT.CONTAINERINSTANCE",
      resourceType: "CONTAINERGROUPS",
      resourceName: "WEB-ACI",
    },
  },
  {
    name: "nested resource (site/slot)",
    input:
      "/subscriptions/sub1/resourceGroups/rg-web/providers/Microsoft.Web/sites/app1/slots/staging",
    expect: {
      subscriptionId: "sub1",
      resourceGroupName: "rg-web",
      resourceProvider: "Microsoft.Web",
      resourceType: "sites/slots",
      resourceName: "staging",
    },
  },
  {
    name: "nested resource (vault/secret)",
    input:
      "/subscriptions/sub1/resourceGroups/rg-sec/providers/Microsoft.KeyVault/vaults/kv1/secrets/api-key",
    expect: {
      subscriptionId: "sub1",
      resourceGroupName: "rg-sec",
      resourceProvider: "Microsoft.KeyVault",
      resourceType: "vaults/secrets",
      resourceName: "api-key",
    },
  },
  {
    name: "deployment at subscription scope",
    input:
      "/subscriptions/sub1/providers/Microsoft.Resources/deployments/Microsoft.Template-20260424",
    expect: {
      subscriptionId: "sub1",
      resourceProvider: "Microsoft.Resources",
      resourceType: "deployments",
      resourceName: "Microsoft.Template-20260424",
    },
  },
  {
    name: "role assignment at subscription scope",
    input:
      "/subscriptions/sub1/providers/Microsoft.Authorization/roleAssignments/abc123",
    expect: {
      subscriptionId: "sub1",
      resourceProvider: "Microsoft.Authorization",
      resourceType: "roleAssignments",
      resourceName: "abc123",
    },
  },
  {
    name: "tenant-scoped resource",
    input: "/providers/Microsoft.Management/managementGroups/root-mg",
    expect: {
      resourceProvider: "Microsoft.Management",
      resourceType: "managementGroups",
      resourceName: "root-mg",
    },
  },
  {
    name: "triple-nested resource",
    input:
      "/subscriptions/sub1/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns1/eventhubs/logs/consumergroups/vector-consumer-group",
    expect: {
      subscriptionId: "sub1",
      resourceGroupName: "rg-eh",
      resourceProvider: "Microsoft.EventHub",
      resourceType: "namespaces/eventhubs/consumergroups",
      resourceName: "vector-consumer-group",
    },
  },
  {
    name: "trailing slash",
    input: "/subscriptions/sub1/resourceGroups/rg-web/",
    expect: { subscriptionId: "sub1", resourceGroupName: "rg-web" },
  },
  {
    name: "authorization rule under namespace",
    input:
      "/subscriptions/sub1/resourceGroups/rg-eh/providers/Microsoft.EventHub/namespaces/ns1/authorizationRules/DiagnosticSettingsSend",
    expect: {
      subscriptionId: "sub1",
      resourceGroupName: "rg-eh",
      resourceProvider: "Microsoft.EventHub",
      resourceType: "namespaces/authorizationRules",
      resourceName: "DiagnosticSettingsSend",
    },
  },
];

for (const tc of cases) {
  test(tc.name, () => {
    const actual = parseResourceId(tc.input);
    assert.deepEqual(actual, tc.expect);
  });
}
