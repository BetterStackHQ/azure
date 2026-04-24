import { gzip } from "node:zlib";
import { promisify } from "node:util";
import { EnrichedRecord } from "../types.js";

const gzipAsync = promisify(gzip);

const DEFAULT_MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface SendResult {
  sent: number;
  dropped: number;
}

export interface SinkLogger {
  warn(msg: string): void;
  error(msg: string): void;
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

export class RetryableSinkError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "RetryableSinkError";
  }
}

export class BetterStackSink {
  private readonly url: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly maxUncompressedBytes: number;
  private readonly requestTimeoutMs: number;
  private readonly logger: SinkLogger;

  constructor(private readonly options: BetterStackSinkOptions) {
    this.url = `https://${options.ingestingHost}`;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.maxAttempts = options.maxAttempts ?? 3;
    this.backoffBaseMs = options.backoffBaseMs ?? 250;
    this.maxUncompressedBytes = options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.logger = options.logger ?? { warn: () => {}, error: () => {} };
  }

  async send(records: EnrichedRecord[]): Promise<SendResult> {
    if (records.length === 0) return { sent: 0, dropped: 0 };

    let sent = 0;
    let dropped = 0;

    for (const batch of this.chunk(records)) {
      try {
        await this.sendBatch(batch);
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

  private *chunk(records: EnrichedRecord[]): Generator<EnrichedRecord[]> {
    let current: EnrichedRecord[] = [];
    let currentBytes = 0;

    for (const record of records) {
      let line: string;
      try {
        line = JSON.stringify(record);
      } catch (err) {
        this.logger.warn(
          `dropping unserializable record: ${(err as Error).message}`,
        );
        continue;
      }

      if (line.length > this.maxUncompressedBytes) {
        this.logger.warn(
          `dropping oversized record (${line.length} bytes > ${this.maxUncompressedBytes} cap)`,
        );
        continue;
      }

      const addedBytes = line.length + (current.length > 0 ? 1 : 0);
      if (current.length > 0 && currentBytes + addedBytes > this.maxUncompressedBytes) {
        yield current;
        current = [];
        currentBytes = 0;
      }
      current.push(record);
      currentBytes += addedBytes;
    }

    if (current.length > 0) yield current;
  }

  private async sendBatch(records: EnrichedRecord[]): Promise<void> {
    const ndjson = records.map((r) => JSON.stringify(r)).join("\n");
    const body = await gzipAsync(Buffer.from(ndjson, "utf8"));

    let attempt = 0;
    while (true) {
      attempt++;

      let res: Response;
      try {
        res = await this.fetchImpl(this.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-ndjson",
            "Content-Encoding": "gzip",
            Authorization: `Bearer ${this.options.sourceToken}`,
          },
          body,
          signal: AbortSignal.timeout(this.requestTimeoutMs),
        });
      } catch (err) {
        if (attempt >= this.maxAttempts) {
          throw new RetryableSinkError(
            `Better Stack unreachable after ${attempt} attempts: ${(err as Error).message}`,
          );
        }
        await sleep(this.backoffWithJitter(attempt));
        continue;
      }

      if (res.ok) return;

      const retriable = res.status === 429 || res.status >= 500;
      if (!retriable) {
        const preview = await readBodyPreview(res);
        throw new Error(`Better Stack rejected ${res.status}: ${preview}`);
      }

      if (attempt >= this.maxAttempts) {
        throw new RetryableSinkError(
          `Better Stack unavailable after ${attempt} attempts (status ${res.status})`,
          res.status,
        );
      }

      await sleep(this.backoffWithJitter(attempt));
    }
  }

  private backoffWithJitter(attempt: number): number {
    const base = this.backoffBaseMs * 2 ** (attempt - 1);
    return base + Math.random() * base * 0.5;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBodyPreview(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.slice(0, 512);
  } catch {
    return "<body unreadable>";
  }
}
