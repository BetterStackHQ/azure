import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationsCatalog } from "../src/enrichment/operationsCatalog.js";
import type { TokenCredential } from "@azure/identity";

const fakeCredential: TokenCredential = {
  getToken: async () => ({ token: "fake-token", expiresOnTimestamp: Date.now() + 3600_000 }),
};

function installFakeFetch(responses: Record<string, { value: unknown[]; nextLink?: string }>) {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL): Promise<Response> => {
    const href = url.toString();
    calls.push(href);
    const key = Object.keys(responses).find((k) => href.includes(k));
    if (!key) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(responses[key]), { status: 200 });
  }) as typeof fetch;
  return {
    restore: () => {
      globalThis.fetch = original;
    },
    calls,
  };
}

test("concurrent warm() calls coalesce into one refresh", async () => {
  const providersPage = {
    value: [{ namespace: "Microsoft.Test" }],
  };
  const opsPage = {
    value: [
      {
        name: "Microsoft.Test/widgets/read",
        display: { provider: "Test", resource: "Widgets", operation: "Read Widget" },
      },
    ],
  };

  let providerFetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL): Promise<Response> => {
    const href = url.toString();
    if (href.endsWith("/providers?api-version=2021-04-01")) {
      providerFetches++;
      return new Response(JSON.stringify(providersPage), { status: 200 });
    }
    if (href.includes("/providers/Microsoft.Test/operations")) {
      return new Response(JSON.stringify(opsPage), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    const cat = new OperationsCatalog(fakeCredential);
    await Promise.all([cat.warm(), cat.warm(), cat.warm()]);
    assert.equal(providerFetches, 1, "expected a single provider-list round-trip");
    assert.equal(cat.isReady, true);
    assert.equal(cat.lookup("MICROSOFT.TEST/WIDGETS/READ")?.operationDisplayName, "Read Widget");
  } finally {
    globalThis.fetch = original;
  }
});

test("pagination: follows nextLink through multiple pages", async () => {
  const pages: Array<{ value: Array<{ namespace?: string }>; nextLink?: string }> = [
    { value: [{ namespace: "Microsoft.A" }], nextLink: "https://example.com/page2" },
    { value: [{ namespace: "Microsoft.B" }] },
  ];
  let pageIndex = 0;

  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL): Promise<Response> => {
    const href = url.toString();
    if (href.includes("/providers?") || href.includes("/page2")) {
      return new Response(JSON.stringify(pages[pageIndex++]), { status: 200 });
    }
    if (href.includes("/operations")) {
      return new Response(
        JSON.stringify({ value: [{ name: `${href.split("/")[4]}/op`, display: { operation: "op" } }] }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    const cat = new OperationsCatalog(fakeCredential);
    await cat.warm();
    assert.equal(pageIndex, 2, "expected two provider-list pages fetched");
    assert.equal(cat.isReady, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("per-provider 404 doesn't prevent catalog readiness", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL): Promise<Response> => {
    const href = url.toString();
    if (href.includes("/providers?")) {
      return new Response(
        JSON.stringify({ value: [{ namespace: "Microsoft.Good" }, { namespace: "Microsoft.Bad" }] }),
        { status: 200 },
      );
    }
    if (href.includes("Microsoft.Bad/operations")) {
      return new Response("", { status: 404 });
    }
    if (href.includes("Microsoft.Good/operations")) {
      return new Response(
        JSON.stringify({
          value: [{ name: "Microsoft.Good/x/read", display: { operation: "Read X" } }],
        }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    const cat = new OperationsCatalog(fakeCredential);
    await cat.warm();
    assert.equal(cat.isReady, true);
    assert.equal(cat.lookup("MICROSOFT.GOOD/X/READ")?.operationDisplayName, "Read X");
  } finally {
    globalThis.fetch = original;
  }
});
