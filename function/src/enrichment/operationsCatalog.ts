import { TokenCredential } from "@azure/identity";
import { OperationDefinition } from "../types.js";

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ARM_SCOPE = "https://management.azure.com/.default";
const ARM_BASE = "https://management.azure.com";
const API_VERSION = "2021-04-01";

interface ProviderResponse {
  value: Array<{ namespace?: string }>;
  nextLink?: string;
}

interface OperationsResponse {
  value: Array<{
    name?: string;
    display?: {
      provider?: string;
      resource?: string;
      operation?: string;
      description?: string;
    };
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

      const providers = await this.listAllProviders(headers);
      const results = await Promise.allSettled(
        providers.map((ns) => this.listOperationsForProvider(ns, headers)),
      );

      for (const r of results) {
        if (r.status !== "fulfilled") continue;
        for (const op of r.value) {
          if (!op.name) continue;
          next.set(op.name.toUpperCase(), {
            name: op.name,
            operationDisplayName: op.display?.operation,
            description: op.display?.description,
            resourceProviderDisplayName: op.display?.provider,
            resourceTypeDisplayName: op.display?.resource,
          });
        }
      }

      if (next.size > 0) {
        this.entries = next;
        this.ready = true;
      }
    } finally {
      this.inflight = null;
    }
  }

  private async listAllProviders(headers: Record<string, string>): Promise<string[]> {
    const namespaces: string[] = [];
    let url: string | undefined = `${ARM_BASE}/providers?api-version=${API_VERSION}`;
    while (url) {
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`providers list failed: ${res.status}`);
      const body = (await res.json()) as ProviderResponse;
      for (const p of body.value) if (p.namespace) namespaces.push(p.namespace);
      url = body.nextLink;
    }
    return namespaces;
  }

  private async listOperationsForProvider(
    providerNamespace: string,
    headers: Record<string, string>,
  ): Promise<OperationsResponse["value"]> {
    const all: OperationsResponse["value"] = [];
    let url: string | undefined =
      `${ARM_BASE}/providers/${encodeURIComponent(providerNamespace)}/operations?api-version=${API_VERSION}`;
    while (url) {
      const res = await fetch(url, { headers });
      if (!res.ok) {
        if (res.status === 404 || res.status === 400) return all;
        throw new Error(`operations list failed for ${providerNamespace}: ${res.status}`);
      }
      const body = (await res.json()) as OperationsResponse;
      all.push(...body.value);
      url = body.nextLink;
    }
    return all;
  }
}
