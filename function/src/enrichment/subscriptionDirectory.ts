import { TokenCredential } from "@azure/identity";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;
const ARM_SCOPE = "https://management.azure.com/.default";
const ARM_BASE = "https://management.azure.com";
const API_VERSION = "2022-12-01";

export interface SubscriptionSummary {
  subscriptionId?: string;
  displayName?: string;
}

export type SubscriptionFetcher = () => AsyncIterable<SubscriptionSummary>;

interface SubscriptionsResponse {
  value: Array<{ subscriptionId?: string; displayName?: string }>;
  nextLink?: string;
}

export class SubscriptionDirectory {
  private entries = new Map<string, string>();
  private ready = false;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly fetcher: SubscriptionFetcher;

  constructor(credential: TokenCredential, fetcher?: SubscriptionFetcher) {
    this.fetcher = fetcher ?? (() => listSubscriptionsViaRest(credential));
  }

  get isReady(): boolean {
    return this.ready;
  }

  lookup(subscriptionId: string | undefined): string | undefined {
    if (!subscriptionId) return undefined;
    return this.entries.get(subscriptionId.toLowerCase());
  }

  async warm(): Promise<void> {
    if (this.ready) return;
    await this.triggerRefresh();
  }

  scheduleRefresh(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.triggerRefresh().catch(() => {
        /* silent */
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
      const next = new Map<string, string>();
      try {
        for await (const sub of this.fetcher()) {
          if (sub.subscriptionId && sub.displayName) {
            next.set(sub.subscriptionId.toLowerCase(), sub.displayName);
          }
        }
      } catch {
        // Iterator failed mid-walk; keep previous entries (don't flip to stale/empty).
        return;
      }
      this.entries = next;
      this.ready = true;
    } finally {
      this.inflight = null;
    }
  }
}

async function* listSubscriptionsViaRest(
  credential: TokenCredential,
): AsyncIterable<SubscriptionSummary> {
  const token = await credential.getToken(ARM_SCOPE);
  if (!token) throw new Error("failed to acquire ARM token");
  const headers = { Authorization: `Bearer ${token.token}` };

  let url: string | undefined = `${ARM_BASE}/subscriptions?api-version=${API_VERSION}`;
  while (url) {
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`subscriptions list failed: ${res.status}`);
    const body = (await res.json()) as SubscriptionsResponse;
    for (const sub of body.value) yield sub;
    url = body.nextLink;
  }
}
