import { app, InvocationContext } from "@azure/functions";
import { ManagedIdentityCredential, DefaultAzureCredential, TokenCredential } from "@azure/identity";
import { ActivityLogRecord, EnrichedRecord } from "./types.js";
import { OperationsCatalog } from "./enrichment/operationsCatalog.js";
import { SubscriptionDirectory } from "./enrichment/subscriptionDirectory.js";
import { Enricher } from "./enrichment/enricher.js";
import { BetterStackSink } from "./sink/betterstack.js";
import { extractRecords } from "./extractRecords.js";

const credential: TokenCredential = process.env.FUNCTIONS_WORKER_RUNTIME
  ? new ManagedIdentityCredential()
  : new DefaultAzureCredential();

const operationsCatalog = new OperationsCatalog(credential);
const subscriptionDirectory = new SubscriptionDirectory(credential);

const enricher = new Enricher(operationsCatalog, subscriptionDirectory);

const INGESTING_HOST = requireEnv("BETTERSTACK_INGESTING_HOST");
const SOURCE_TOKEN = requireEnv("BETTERSTACK_SOURCE_TOKEN");

const sink = new BetterStackSink({
  ingestingHost: INGESTING_HOST,
  sourceToken: SOURCE_TOKEN,
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
        enriched.push(toFallbackEnriched(record));
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

function toFallbackEnriched(record: ActivityLogRecord): EnrichedRecord {
  return {
    ...record,
    _azure_arm: {
      subscription_name: null,
      operation: null,
      status: "parse-error",
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
