import { EnrichedRecord } from "../types.js";
import {
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  NOOP_LOGGER,
  RetryableSinkError,
  SinkLogger,
  chunkNdjson,
  sendGzippedNdjson,
} from "./http.js";

export { RetryableSinkError, SinkLogger };

export interface SendResult {
  sent: number;
  dropped: number;
}

export interface BetterStackSinkOptions {
  ingestingHost: string;
  sourceToken: string;
  fetchImpl?: typeof fetch;
  maxAttempts?: number;
  backoffBaseMs?: number;
  maxUncompressedBytes?: number;
  requestTimeoutMs?: number;
  logger?: SinkLogger;
}

export class BetterStackSink {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxUncompressedBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: SinkLogger;
  private readonly sourceToken: string;

  constructor(options: BetterStackSinkOptions) {
    this.url = `https://${options.ingestingHost}/azure`;
    this.sourceToken = options.sourceToken;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffBaseMs = options.backoffBaseMs ?? 250;
    this.maxUncompressedBytes = options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger ?? NOOP_LOGGER;
  }

  async send(records: EnrichedRecord[]): Promise<SendResult> {
    if (records.length === 0) return { sent: 0, dropped: 0 };

    let sent = 0;
    let dropped = 0;

    for (const { batch, lines } of chunkNdjson(records, {
      maxUncompressedBytes: this.maxUncompressedBytes,
      logger: this.logger,
    })) {
      try {
        await sendGzippedNdjson(lines, {
          url: this.url,
          sourceToken: this.sourceToken,
          fetchImpl: this.fetchImpl,
          maxAttempts: this.maxAttempts,
          backoffBaseMs: this.backoffBaseMs,
          requestTimeoutMs: this.requestTimeoutMs,
        });
        sent += batch.length;
      } catch (err) {
        if (err instanceof RetryableSinkError) throw err;
        this.logger.error(
          `Better Stack rejected batch of ${batch.length} records (non-retryable): ${(err as Error).message}`,
        );
        dropped += batch.length;
      }
    }

    return { sent, dropped };
  }
}
