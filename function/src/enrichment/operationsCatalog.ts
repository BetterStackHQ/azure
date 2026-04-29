import { TokenCredential } from "@azure/identity";
import { OperationDefinition } from "../types.js";

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ARM_SCOPE = "https://management.azure.com/.default";
const ARM_BASE = "https://management.azure.com";
const API_VERSION = "2022-04-01";

interface OperationMetadata {
  name?: string;
  displayName?: string;
  description?: string;
}

interface ProviderOperationsResponse {
  value: Array<{
    name?: string;
    displayName?: string;
    operations?: OperationMetadata[];
    resourceTypes?: Array<{
      name?: string;
      displayName?: string;
      operations?: OperationMetadata[];
    }>;
  }>;
  nextLink?: string;
}

export class OperationsCatalog {
  private entries = new Map<string, OperationDefinition>();
  private ready = false;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly credential: TokenCredential) {}

  get isReady(): boolean {
    return this.ready;
  }

  lookup(operationName: string | undefined): OperationDefinition | undefined {
    if (!operationName) return undefined;
    return this.entries.get(operationName.toUpperCase());
  }

  async warm(): Promise<void> {
    if (this.ready) return;
    await this.triggerRefresh();
  }

  scheduleRefresh(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.triggerRefresh().catch(() => {
        /* silent — next cycle will retry */
      });
    }, REFRESH_INTERVAL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private triggerRefresh(): Promise<void> {
    if (!this.inflight) this.inflight = this.refresh();
    return this.inflight;
  }

  private async refresh(): Promise<void> {
    try {
      const token = await this.credential.getToken(ARM_SCOPE);
      if (!token) throw new Error("failed to acquire ARM token");

      const headers = { Authorization: `Bearer ${token.token}` };
      const next = new Map<string, OperationDefinition>();

      let url: string | undefined =
        `${ARM_BASE}/providers/Microsoft.Authorization/providerOperations?api-version=${API_VERSION}&$expand=resourceTypes`;
      while (url) {
        const res = await fetch(url, { headers });
        if (!res.ok) throw new Error(`providerOperations list failed: ${res.status}`);
        const body = (await res.json()) as ProviderOperationsResponse;
        for (const provider of body.value) {
          for (const op of provider.operations ?? []) {
            if (!op.name) continue;
            next.set(op.name.toUpperCase(), {
              name: op.name,
              operationDisplayName: op.displayName,
              description: op.description,
              resourceProviderDisplayName: provider.displayName,
            });
          }
          for (const rt of provider.resourceTypes ?? []) {
            for (const op of rt.operations ?? []) {
              if (!op.name) continue;
              next.set(op.name.toUpperCase(), {
                name: op.name,
                operationDisplayName: op.displayName,
                description: op.description,
                resourceProviderDisplayName: provider.displayName,
                resourceTypeDisplayName: rt.displayName,
              });
            }
          }
        }
        url = body.nextLink;
      }

      if (next.size > 0) {
        this.entries = next;
        this.ready = true;
      }
    } finally {
      this.inflight = null;
    }
  }
}
