import { TokenCredential } from "@azure/identity";
import { SubscriptionClient } from "@azure/arm-subscriptions";

const REFRESH_INTERVAL_MS = 60 * 60 * 1000;

export interface SubscriptionSummary {
  subscriptionId?: string;
  displayName?: string;
}

export type SubscriptionFetcher = () => AsyncIterable<SubscriptionSummary>;

export class SubscriptionDirectory {
  private entries = new Map<string, string>();
  private ready = false;
  private inflight: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly fetcher: SubscriptionFetcher;

  constructor(credential: TokenCredential, fetcher?: SubscriptionFetcher) {
    this.fetcher =
      fetcher ??
      (() => new SubscriptionClient(credential).subscriptions.list() as AsyncIterable<SubscriptionSummary>);
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
