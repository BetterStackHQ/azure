import {
  ActivityLogRecord,
  EnrichedRecord,
  EnrichmentStatus,
  AzureEnrichment,
} from "../types.js";
import { parseResourceId } from "./resourceIdParser.js";
import { OperationsCatalog } from "./operationsCatalog.js";
import { SubscriptionDirectory } from "./subscriptionDirectory.js";

export interface EnricherOptions {
  sourceId: string;
  forwarderVersion: string;
}

const CLAIM_NAME_KEYS = [
  "name",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/upn",
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
  "preferred_username",
  "upn",
];

export class Enricher {
  constructor(
    private readonly operations: OperationsCatalog,
    private readonly subscriptions: SubscriptionDirectory,
    private readonly options: EnricherOptions,
  ) {}

  enrich(record: ActivityLogRecord): EnrichedRecord {
    const { time, ...rest } = record;
    const enrichment: AzureEnrichment["enrichment"] = {
      status: "ok",
      sourceId: this.options.sourceId,
      forwarderVersion: this.options.forwarderVersion,
    };

    let status: EnrichmentStatus = "ok";
    const parsed = parseResourceId(record.resourceId);

    const operationDef = this.operations.lookup(record.operationName);
    if (!this.operations.isReady || !this.subscriptions.isReady) {
      status = "pending";
    } else if (!operationDef && record.operationName) {
      status = "unknown-operation";
    }

    const subscriptionName = parsed.subscriptionId
      ? this.subscriptions.lookup(parsed.subscriptionId) ?? null
      : null;

    if (
      status === "ok" &&
      parsed.subscriptionId &&
      subscriptionName === null &&
      this.subscriptions.isReady
    ) {
      status = "no-access";
    }

    enrichment.status = status;

    const azure: AzureEnrichment = {
      subscriptionId: parsed.subscriptionId,
      subscriptionName,
      resourceGroupName: parsed.resourceGroupName,
      resourceProvider: parsed.resourceProvider,
      resourceType: parsed.resourceType,
      resourceName: parsed.resourceName,
      operation: operationDef
        ? {
            displayName: operationDef.operationDisplayName,
            description: operationDef.description,
            resourceProviderDisplayName: operationDef.resourceProviderDisplayName,
            resourceTypeDisplayName: operationDef.resourceTypeDisplayName,
          }
        : null,
      enrichment,
    };

    const enriched: EnrichedRecord = {
      ...rest,
      dt: time,
      azure,
    };

    const callerDisplayName = extractCallerDisplayName(record);
    if (callerDisplayName) enriched.callerDisplayName = callerDisplayName;

    return enriched;
  }
}

function extractCallerDisplayName(record: ActivityLogRecord): string | undefined {
  const claims = record.identity?.claims;
  if (!claims) return undefined;
  for (const key of CLAIM_NAME_KEYS) {
    const value = claims[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}
