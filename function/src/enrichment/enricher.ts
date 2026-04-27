import {
  ActivityLogRecord,
  AzureArmSidechannel,
  EnrichedRecord,
  EnrichmentStatus,
} from "../types.js";
import { parseSubscriptionId } from "./resourceIdParser.js";
import { OperationsCatalog } from "./operationsCatalog.js";
import { SubscriptionDirectory } from "./subscriptionDirectory.js";

export class Enricher {
  constructor(
    private readonly operations: OperationsCatalog,
    private readonly subscriptions: SubscriptionDirectory,
  ) {}

  enrich(record: ActivityLogRecord): EnrichedRecord {
    const subscriptionId = parseSubscriptionId(record.resourceId);
    const operationDef = this.operations.lookup(record.operationName);

    let status: EnrichmentStatus = "ok";
    if (!this.operations.isReady || !this.subscriptions.isReady) {
      status = "pending";
    } else if (!operationDef && record.operationName) {
      status = "unknown-operation";
    }

    const subscriptionName = subscriptionId
      ? this.subscriptions.lookup(subscriptionId) ?? null
      : null;

    if (
      status === "ok" &&
      subscriptionId &&
      subscriptionName === null &&
      this.subscriptions.isReady
    ) {
      status = "no-access";
    }

    const sidechannel: AzureArmSidechannel = {
      subscription_name: subscriptionName,
      operation: operationDef
        ? {
            displayName: operationDef.operationDisplayName,
            description: operationDef.description,
            resourceProviderDisplayName: operationDef.resourceProviderDisplayName,
            resourceTypeDisplayName: operationDef.resourceTypeDisplayName,
          }
        : null,
      status,
    };

    return { ...record, _azure_arm: sidechannel };
  }
}
