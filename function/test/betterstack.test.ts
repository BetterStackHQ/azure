import { test } from "node:test";
import assert from "node:assert/strict";
import { gunzipSync } from "node:zlib";
import { BetterStackSink, RetryableSinkError } from "../src/sink/betterstack.js";
import { EnrichedRecord } from "../src/types.js";

function record(suffix: string): EnrichedRecord {
  return {
    dt: "2026-04-24T00:00:00Z",
    operationName: `OP/${suffix}`,
    azure: {
      enrichment: { status: "ok", sourceId: "s1", forwarderVersion: "1.0.0" },
    },
  };
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: Buffer;
}

function recorder(
  responses: Array<{ status: number; body?: string }>,
): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const fakeFetch = (async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const next = responses.shift();
    if (!next) throw new Error("no more fake responses queued");
    const bodyBuf = Buffer.from(init?.body as ArrayBuffer);
    calls.push({
      url: url.toString(),
      headers: init?.headers as Record<string, string>,
      body: bodyBuf,
    });
    return new Response(next.body ?? "", { status: next.status });
  }) as unknown as typeof fetch;
  return { calls, fetch: fakeFetch };
}

test("posts gzipped ndjson with bearer auth on 200", async () => {
  const { calls, fetch: fakeFetch } = recorder([{ status: 200 }]);
  const sink = new BetterStackSink({
    ingestingHost: "ingest.example.com",
    sourceToken: "tok",
    fetchImpl: fakeFetch,
  });

  const result = await sink.send([record("A"), record("B")]);

  assert.equal(result.sent, 2);
  assert.equal(result.dropped, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://ingest.example.com");
  assert.equal(calls[0].headers["Authorization"], "Bearer tok");
  assert.equal(calls[0].headers["Content-Encoding"], "gzip");
  assert.equal(calls[0].headers["Content-Type"], "application/x-ndjson");

  const decoded = gunzipSync(calls[0].body).toString("utf8");
  const lines = decoded.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /"OP\/A"/);
  assert.match(lines[1], /"OP\/B"/);
});

test("no-op on empty batch", async () => {
  const { calls, fetch: fakeFetch } = recorder([]);
  const sink = new BetterStackSink({
    ingestingHost: "ingest.example.com",
    sourceToken: "tok",
    fetchImpl: fakeFetch,
  });
  await sink.send([]);
  assert.equal(calls.length, 0);
});

test("retries on 500 then succeeds", async () => {
  const { calls, fetch: fakeFetch } = recorder([{ status: 500 }, { status: 200 }]);
  const sink = new BetterStackSink({
    ingestingHost: "ingest.example.com",
    sourceToken: "tok",
    fetchImpl: fakeFetch,
    backoffBaseMs: 1,
  });
  await sink.send([record("A")]);
  assert.equal(calls.length, 2);
});

test("throws RetryableSinkError after exhausting attempts on 429", async () => {
  const { fetch: fakeFetch } = recorder([
    { status: 429 },
    { status: 429 },
    { status: 429 },
  ]);
  const sink = new BetterStackSink({
    ingestingHost: "ingest.example.com",
    sourceToken: "tok",
    fetchImpl: fakeFetch,
    backoffBaseMs: 1,
  });
  await assert.rejects(() => sink.send([record("A")]), RetryableSinkError);
});

test("drops batch and logs on 400 (non-retryable) without propagating", async () => {
  const { calls, fetch: fakeFetch } = recorder([{ status: 400, body: "bad token" }]);
  const errors: string[] = [];
  const sink = new BetterStackSink({
    ingestingHost: "ingest.example.com",
    sourceToken: "tok",
    fetchImpl: fakeFetch,
    backoffBaseMs: 1,
    logger: { warn: () => {}, error: (m) => errors.push(m) },
  });
  const result = await sink.send([record("A")]);
  assert.equal(result.sent, 0);
  assert.equal(result.dropped, 1);
  assert.equal(calls.length, 1);
  assert.ok(errors.some((e) => e.includes("400")));
});

test("retries on network error, succeeds", async () => {
  let calls = 0;
  const fakeFetch = (async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    return new Response("", { status: 200 });
  }) as unknown as typeof fetch;
  const sink = new BetterStackSink({
    ingestingHost: "ingest.example.com",
    sourceToken: "tok",
    fetchImpl: fakeFetch,
    backoffBaseMs: 1,
  });
  const result = await sink.send([record("A")]);
  assert.equal(result.sent, 1);
  assert.equal(calls, 2);
});

test("drops oversized single record, proceeds with rest", async () => {
  const { calls, fetch: fakeFetch } = recorder([{ status: 200 }]);
  const warnings: string[] = [];
  const sink = new BetterStackSink({
    ingestingHost: "ingest.example.com",
    sourceToken: "tok",
    fetchImpl: fakeFetch,
    maxUncompressedBytes: 500,
    logger: { warn: (m) => warnings.push(m), error: () => {} },
  });

  const huge: EnrichedRecord = {
    dt: "2026-04-24T00:00:00Z",
    operationName: "OP/HUGE",
    azure: {
      enrichment: { status: "ok", sourceId: "s1", forwarderVersion: "1.0.0" },
    },
    payload: "x".repeat(1000),
  };

  const result = await sink.send([huge, record("OK")]);
  assert.equal(result.sent, 1);
  assert.equal(result.dropped, 0);
  assert.equal(calls.length, 1);
  assert.ok(warnings.some((w) => w.includes("oversized")));
});
