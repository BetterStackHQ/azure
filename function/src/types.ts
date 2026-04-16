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

export interface AzureArmSidechannel {
  subscription_name: string | null;
  operation: {
    displayName?: string;
    description?: string;
    resourceProviderDisplayName?: string;
    resourceTypeDisplayName?: string;
  } | null;
  status: EnrichmentStatus;
}

export interface EnrichedRecord extends ActivityLogRecord {
  _azure_arm: AzureArmSidechannel;
}
