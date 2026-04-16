import { test } from "node:test";
import assert from "node:assert/strict";
import { SubscriptionDirectory, SubscriptionFetcher } from "../src/enrichment/subscriptionDirectory.js";
import type { TokenCredential } from "@azure/identity";

const fakeCredential: TokenCredential = {
  getToken: async () => ({ token: "fake", expiresOnTimestamp: Date.now() + 3600_000 }),
};

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return (async function* () {
    for (const item of items) yield item;
  })();
}

test("happy path populates entries and flips ready", async () => {
  const fetcher: SubscriptionFetcher = () =>
    asyncIter([
      { subscriptionId: "sub-1", displayName: "Prod" },
      { subscriptionId: "SUB-2", displayName: "Dev" },
    ]);

  const dir = new SubscriptionDirectory(fakeCredential, fetcher);
  await dir.warm();
  assert.equal(dir.isReady, true);
  assert.equal(dir.lookup("sub-1"), "Prod");
  assert.equal(dir.lookup("SUB-2"), "Dev");
  assert.equal(dir.lookup("sub-2"), "Dev"); // case-insensitive lookup
});

test("iterator throwing mid-walk preserves prior entries", async () => {
  let call = 0;
  const fetcher: SubscriptionFetcher = () => {
    call++;
    if (call === 1) {
      return asyncIter([{ subscriptionId: "sub-1", displayName: "Prod" }]);
    }
    return (async function* () {
      throw new Error("ARM unreachable");
      // eslint-disable-next-line no-unreachable
      yield { subscriptionId: "sub-2", displayName: "Dev" };
    })();
  };

  const dir = new SubscriptionDirectory(fakeCredential, fetcher);
  await dir.warm();
  assert.equal(dir.lookup("sub-1"), "Prod");

  // Second refresh: iterator throws. Existing entries should survive.
  await (dir as unknown as { triggerRefresh: () => Promise<void> }).triggerRefresh.call(dir);

  assert.equal(dir.lookup("sub-1"), "Prod", "existing entry must survive iterator failure");
  assert.equal(dir.isReady, true);
});

test("concurrent warm() calls coalesce", async () => {
  let callCount = 0;
  const fetcher: SubscriptionFetcher = () => {
    callCount++;
    return (async function* () {
      await new Promise((r) => setTimeout(r, 10));
      yield { subscriptionId: "sub-1", displayName: "Prod" };
    })();
  };

  const dir = new SubscriptionDirectory(fakeCredential, fetcher);
  await Promise.all([dir.warm(), dir.warm(), dir.warm()]);
  assert.equal(callCount, 1, "expected a single iterator walk");
  assert.equal(dir.lookup("sub-1"), "Prod");
});
