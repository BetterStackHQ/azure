import { test } from "node:test";
import assert from "node:assert/strict";
import { Enricher } from "../src/enrichment/enricher.js";
import { OperationsCatalog } from "../src/enrichment/operationsCatalog.js";
import { SubscriptionDirectory } from "../src/enrichment/subscriptionDirectory.js";
import { ActivityLogRecord } from "../src/types.js";

interface FakeOps {
  ready: boolean;
  known: Map<string, ReturnType<OperationsCatalog["lookup"]>>;
}

function fakeCatalog(opts: FakeOps): OperationsCatalog {
  return {
    isReady: opts.ready,
    lookup: (name: string | undefined) => (name ? opts.known.get(name.toUpperCase()) : undefined),
    warm: async () => {},
    scheduleRefresh: () => {},
    stop: () => {},
  } as unknown as OperationsCatalog;
}

function fakeDirectory(ready: boolean, map: Map<string, string>): SubscriptionDirectory {
  return {
    isReady: ready,
    lookup: (id: string | undefined) => (id ? map.get(id.toLowerCase()) : undefined),
    warm: async () => {},
    scheduleRefresh: () => {},
    stop: () => {},
  } as unknown as SubscriptionDirectory;
}

const sampleRecord: ActivityLogRecord = {
  time: "2026-04-24T09:22:09.8045981Z",
  operationName: "MICROSOFT.CONTAINERINSTANCE/CONTAINERGROUPS/WRITE",
  category: "Administrative",
  resourceId:
    "/SUBSCRIPTIONS/645383E7-89F3-4494-B695-EDFE4B926223/RESOURCEGROUPS/RG-WEB/PROVIDERS/MICROSOFT.CONTAINERINSTANCE/CONTAINERGROUPS/WEB-ACI",
  identity: { claims: { name: "alistair@evanson.ltd" } },
  level: "Information",
};

const options = { sourceId: "s4267", forwarderVersion: "1.0.0" };

test("ok: operation + subscription both resolve", () => {
  const ops = fakeCatalog({
    ready: true,
    known: new Map([
      [
        "MICROSOFT.CONTAINERINSTANCE/CONTAINERGROUPS/WRITE",
        {
          name: "Microsoft.ContainerInstance/containerGroups/write",
          operationDisplayName: "Create or Update Container Group",
          description: "Create or update a container group.",
          resourceProviderDisplayName: "Container Instance",
          resourceTypeDisplayName: "Container Groups",
        },
      ],
    ]),
  });
  const dir = fakeDirectory(
    true,
    new Map([["645383e7-89f3-4494-b695-edfe4b926223", "Production"]]),
  );

  const out = new Enricher(ops, dir, options).enrich(sampleRecord);

  assert.equal(out.azure.enrichment.status, "ok");
  assert.equal(out.azure.subscriptionName, "Production");
  assert.equal(out.azure.operation?.displayName, "Create or Update Container Group");
  assert.equal(out.azure.resourceType, "CONTAINERGROUPS");
  assert.equal(out.callerDisplayName, "alistair@evanson.ltd");
  assert.equal(out.dt, "2026-04-24T09:22:09.8045981Z");
  assert.equal((out as { time?: string }).time, undefined);
});

test("pending: catalog not yet ready", () => {
  const ops = fakeCatalog({ ready: false, known: new Map() });
  const dir = fakeDirectory(false, new Map());
  const out = new Enricher(ops, dir, options).enrich(sampleRecord);
  assert.equal(out.azure.enrichment.status, "pending");
  assert.equal(out.azure.operation, null);
});

test("unknown-operation: catalog ready but this op isn't in it", () => {
  const ops = fakeCatalog({ ready: true, known: new Map() });
  const dir = fakeDirectory(
    true,
    new Map([["645383e7-89f3-4494-b695-edfe4b926223", "Production"]]),
  );
  const out = new Enricher(ops, dir, options).enrich(sampleRecord);
  assert.equal(out.azure.enrichment.status, "unknown-operation");
  assert.equal(out.azure.operation, null);
});

test("no-access: subscription not in directory though directory is ready", () => {
  const ops = fakeCatalog({
    ready: true,
    known: new Map([
      [
        "MICROSOFT.CONTAINERINSTANCE/CONTAINERGROUPS/WRITE",
        {
          name: "Microsoft.ContainerInstance/containerGroups/write",
          operationDisplayName: "x",
        },
      ],
    ]),
  });
  const dir = fakeDirectory(true, new Map());
  const out = new Enricher(ops, dir, options).enrich(sampleRecord);
  assert.equal(out.azure.enrichment.status, "no-access");
  assert.equal(out.azure.subscriptionName, null);
});

test("no identity claims: callerDisplayName omitted", () => {
  const ops = fakeCatalog({ ready: true, known: new Map() });
  const dir = fakeDirectory(true, new Map());
  const out = new Enricher(ops, dir, options).enrich({
    ...sampleRecord,
    identity: undefined,
  });
  assert.equal(out.callerDisplayName, undefined);
});

test("schema-tagged claim is used when 'name' is absent", () => {
  const ops = fakeCatalog({ ready: true, known: new Map() });
  const dir = fakeDirectory(true, new Map());
  const out = new Enricher(ops, dir, options).enrich({
    ...sampleRecord,
    identity: {
      claims: {
        "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn": "alice@example.com",
      },
    },
  });
  assert.equal(out.callerDisplayName, "alice@example.com");
});

test("tenant-scoped resource (no subscription) still returns status ok", () => {
  const ops = fakeCatalog({
    ready: true,
    known: new Map([
      [
        "MICROSOFT.MANAGEMENT/MANAGEMENTGROUPS/READ",
        { name: "Microsoft.Management/managementGroups/read", operationDisplayName: "Read MG" },
      ],
    ]),
  });
  const dir = fakeDirectory(true, new Map());
  const out = new Enricher(ops, dir, options).enrich({
    time: "2026-04-24T00:00:00Z",
    operationName: "MICROSOFT.MANAGEMENT/MANAGEMENTGROUPS/READ",
    resourceId: "/providers/Microsoft.Management/managementGroups/root-mg",
  });
  assert.equal(out.azure.enrichment.status, "ok");
  assert.equal(out.azure.subscriptionId, undefined);
  assert.equal(out.azure.subscriptionName, null);
});
