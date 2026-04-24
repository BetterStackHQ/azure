import { app, InvocationContext } from "@azure/functions";
import { ManagedIdentityCredential, DefaultAzureCredential, TokenCredential } from "@azure/identity";
import { ActivityLogRecord, EnrichedRecord } from "./types.js";
import { OperationsCatalog } from "./enrichment/operationsCatalog.js";
import { SubscriptionDirectory } from "./enrichment/subscriptionDirectory.js";
import { Enricher } from "./enrichment/enricher.js";
import { BetterStackSink } from "./sink/betterstack.js";
import { extractRecords } from "./extractRecords.js";

const FORWARDER_VERSION = "1.0.0";
const SOURCE_ID = requireEnv("BETTERSTACK_SOURCE_ID");

const credential: TokenCredential = process.env.FUNCTIONS_WORKER_RUNTIME
  ? new ManagedIdentityCredential()
  : new DefaultAzureCredential();

const operationsCatalog = new OperationsCatalog(credential);
const subscriptionDirectory = new SubscriptionDirectory(credential);

const enricher = new Enricher(operationsCatalog, subscriptionDirectory, {
  sourceId: SOURCE_ID,
  forwarderVersion: FORWARDER_VERSION,
});

const sink = new BetterStackSink({
  ingestingHost: requireEnv("BETTERSTACK_INGESTING_HOST"),
  sourceToken: requireEnv("BETTERSTACK_SOURCE_TOKEN"),
  logger: {
    warn: (msg) => console.warn(`[sink] ${msg}`),
    error: (msg) => console.error(`[sink] ${msg}`),
  },
});

operationsCatalog.warm().catch((e) => console.warn(`ops catalog warm failed: ${e}`));
subscriptionDirectory.warm().catch((e) => console.warn(`subscription directory warm failed: ${e}`));
operationsCatalog.scheduleRefresh();
subscriptionDirectory.scheduleRefresh();

export async function handleBatch(
  messages: unknown[],
  context: InvocationContext,
): Promise<void> {
  const enriched: EnrichedRecord[] = [];
  let parseErrors = 0;
  let enrichErrors = 0;

  for (const message of messages) {
    const records = extractRecords(message, context);
    if (records === null) {
      parseErrors++;
      continue;
    }
    for (const record of records) {
      try {
        enriched.push(enricher.enrich(record));
      } catch (err) {
        enrichErrors++;
        context.warn(
          `enrichment threw, forwarding raw: ${(err as Error).message}`,
        );
        enriched.push(toFallbackEnriched(record, (err as Error).message));
      }
    }
  }

  if (enriched.length === 0) {
    if (parseErrors > 0) context.warn(`batch contained ${parseErrors} unparseable messages, nothing to forward`);
    return;
  }

  const result = await sink.send(enriched);
  context.log(
    `batch complete: sent=${result.sent} dropped=${result.dropped} parseErrors=${parseErrors} enrichErrors=${enrichErrors}`,
  );
}

function toFallbackEnriched(record: ActivityLogRecord, error: string): EnrichedRecord {
  const { time, ...rest } = record;
  return {
    ...rest,
    dt: time,
    azure: {
      enrichment: {
        status: "parse-error",
        sourceId: SOURCE_ID,
        forwarderVersion: FORWARDER_VERSION,
        error,
      },
    },
  };
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`missing required env var: ${name}`);
  return value;
}

app.eventHub("Forwarder", {
  connection: "EventHubConnection",
  eventHubName: process.env.EVENTHUB_NAME ?? "logs",
  consumerGroup: process.env.EVENTHUB_CONSUMER_GROUP ?? "betterstack-consumer-group",
  cardinality: "many",
  handler: handleBatch,
});
