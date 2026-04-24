export interface ActivityLogRecord {
  time?: string;
  operationName?: string;
  category?: string;
  resultType?: string;
  resultSignature?: string;
  resultDescription?: string;
  correlationId?: string;
  level?: string;
  resourceId?: string;
  callerIpAddress?: string;
  identity?: {
    authorization?: unknown;
    claims?: Record<string, string>;
  };
  properties?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ResourceIdParts {
  subscriptionId?: string;
  resourceGroupName?: string;
  resourceProvider?: string;
  resourceType?: string;
  resourceName?: string;
}

export interface OperationDefinition {
  name: string;
  operationDisplayName?: string;
  description?: string;
  resourceProviderDisplayName?: string;
  resourceTypeDisplayName?: string;
}

export type EnrichmentStatus =
  | "ok"
  | "pending"
  | "unknown-operation"
  | "no-access"
  | "parse-error";

export interface AzureEnrichment {
  subscriptionId?: string;
  subscriptionName?: string | null;
  resourceGroupName?: string;
  resourceProvider?: string;
  resourceType?: string;
  resourceName?: string;
  operation?: {
    displayName?: string;
    description?: string;
    resourceProviderDisplayName?: string;
    resourceTypeDisplayName?: string;
  } | null;
  enrichment: {
    status: EnrichmentStatus;
    sourceId: string;
    forwarderVersion: string;
    error?: string;
  };
}

export interface EnrichedRecord extends ActivityLogRecord {
  dt?: string;
  callerDisplayName?: string;
  azure: AzureEnrichment;
}
