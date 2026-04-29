import { test } from "node:test";
import assert from "node:assert/strict";
import { OperationsCatalog } from "../src/enrichment/operationsCatalog.js";
import type { TokenCredential } from "@azure/identity";

const fakeCredential: TokenCredential = {
  getToken: async () => ({ token: "fake-token", expiresOnTimestamp: Date.now() + 3600_000 }),
};

const PROVIDER_OPS_PATH =
  "/providers/Microsoft.Authorization/providerOperations";

test("concurrent warm() calls coalesce into one refresh", async () => {
  const body = {
    value: [
      {
        name: "Microsoft.Test",
        displayName: "Microsoft Test",
        operations: [
          {
            name: "Microsoft.Test/register/action",
            displayName: "Register Test RP",
          },
        ],
        resourceTypes: [
          {
            name: "widgets",
            displayName: "Widgets",
            operations: [
              {
                name: "Microsoft.Test/widgets/read",
                displayName: "Read Widget",
                description: "Read a widget",
              },
            ],
          },
        ],
      },
    ],
  };

  let fetches = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL): Promise<Response> => {
    const href = url.toString();
    if (href.includes(PROVIDER_OPS_PATH)) {
      fetches++;
      return new Response(JSON.stringify(body), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    const cat = new OperationsCatalog(fakeCredential);
    await Promise.all([cat.warm(), cat.warm(), cat.warm()]);
    assert.equal(fetches, 1, "expected a single providerOperations round-trip");
    assert.equal(cat.isReady, true);

    const widget = cat.lookup("MICROSOFT.TEST/WIDGETS/READ");
    assert.equal(widget?.operationDisplayName, "Read Widget");
    assert.equal(widget?.resourceProviderDisplayName, "Microsoft Test");
    assert.equal(widget?.resourceTypeDisplayName, "Widgets");

    const register = cat.lookup("MICROSOFT.TEST/REGISTER/ACTION");
    assert.equal(register?.operationDisplayName, "Register Test RP");
    assert.equal(register?.resourceProviderDisplayName, "Microsoft Test");
    assert.equal(register?.resourceTypeDisplayName, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("pagination: follows nextLink through multiple pages", async () => {
  const pages = [
    {
      value: [
        {
          name: "Microsoft.A",
          displayName: "Microsoft A",
          resourceTypes: [
            {
              name: "things",
              displayName: "Things",
              operations: [{ name: "Microsoft.A/things/read", displayName: "Read A" }],
            },
          ],
        },
      ],
      nextLink: "https://management.azure.com/page2",
    },
    {
      value: [
        {
          name: "Microsoft.B",
          displayName: "Microsoft B",
          resourceTypes: [
            {
              name: "things",
              displayName: "Things",
              operations: [{ name: "Microsoft.B/things/read", displayName: "Read B" }],
            },
          ],
        },
      ],
    },
  ];
  let pageIndex = 0;

  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL): Promise<Response> => {
    const href = url.toString();
    if (href.includes(PROVIDER_OPS_PATH) || href.includes("/page2")) {
      return new Response(JSON.stringify(pages[pageIndex++]), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  try {
    const cat = new OperationsCatalog(fakeCredential);
    await cat.warm();
    assert.equal(pageIndex, 2, "expected two pages fetched");
    assert.equal(cat.isReady, true);
    assert.equal(cat.lookup("MICROSOFT.A/THINGS/READ")?.operationDisplayName, "Read A");
    assert.equal(cat.lookup("MICROSOFT.B/THINGS/READ")?.operationDisplayName, "Read B");
  } finally {
    globalThis.fetch = original;
  }
});

test("provider with missing operations/resourceTypes fields is tolerated", async () => {
  const body = {
    value: [
      { name: "Microsoft.Empty", displayName: "Empty" },
      {
        name: "Microsoft.Good",
        displayName: "Good",
        resourceTypes: [
          {
            name: "x",
            displayName: "X",
            operations: [{ name: "Microsoft.Good/x/read", displayName: "Read X" }],
          },
        ],
      },
    ],
  };

  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL): Promise<Response> => {
    const href = url.toString();
    if (href.includes(PROVIDER_OPS_PATH)) {
      return new Response(JSON.stringify(body), { status: 200 });
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
