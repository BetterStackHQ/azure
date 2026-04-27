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

test("ok: operation + subscription both resolve, raw fields forwarded untouched", () => {
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

  const out = new Enricher(ops, dir).enrich(sampleRecord);

  assert.equal(out._azure_arm.status, "ok");
  assert.equal(out._azure_arm.subscription_name, "Production");
  assert.equal(out._azure_arm.operation?.displayName, "Create or Update Container Group");

  // Raw fields are forwarded untouched - no time->dt rename, no callerDisplayName,
  // no azure block. Those transforms now happen in the ingester-side AzureMapper.
  assert.equal(out.time, "2026-04-24T09:22:09.8045981Z");
  assert.equal((out as { dt?: string }).dt, undefined);
  assert.equal((out as { callerDisplayName?: string }).callerDisplayName, undefined);
  assert.equal((out as { azure?: unknown }).azure, undefined);
});

test("pending: catalog not yet ready", () => {
  const ops = fakeCatalog({ ready: false, known: new Map() });
  const dir = fakeDirectory(false, new Map());
  const out = new Enricher(ops, dir).enrich(sampleRecord);
  assert.equal(out._azure_arm.status, "pending");
  assert.equal(out._azure_arm.operation, null);
});

test("unknown-operation: catalog ready but this op isn't in it", () => {
  const ops = fakeCatalog({ ready: true, known: new Map() });
  const dir = fakeDirectory(
    true,
    new Map([["645383e7-89f3-4494-b695-edfe4b926223", "Production"]]),
  );
  const out = new Enricher(ops, dir).enrich(sampleRecord);
  assert.equal(out._azure_arm.status, "unknown-operation");
  assert.equal(out._azure_arm.operation, null);
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
  const out = new Enricher(ops, dir).enrich(sampleRecord);
  assert.equal(out._azure_arm.status, "no-access");
  assert.equal(out._azure_arm.subscription_name, null);
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
  const out = new Enricher(ops, dir).enrich({
    time: "2026-04-24T00:00:00Z",
    operationName: "MICROSOFT.MANAGEMENT/MANAGEMENTGROUPS/READ",
    resourceId: "/providers/Microsoft.Management/managementGroups/root-mg",
  });
  assert.equal(out._azure_arm.status, "ok");
  assert.equal(out._azure_arm.subscription_name, null);
});
