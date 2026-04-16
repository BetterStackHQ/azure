import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface SinkLogger {
  warn(msg: string): void;
  error(msg: string): void;
}

export const NOOP_LOGGER: SinkLogger = { warn: () => {}, error: () => {} };

export class RetryableSinkError extends Error {
  constructor(message: string, public readonly status?: number) {
    super(message);
    this.name = "RetryableSinkError";
  }
}

export interface ChunkOptions {
  maxUncompressedBytes: number;
  logger: SinkLogger;
}

export function* chunkNdjson<T>(
  records: T[],
  opts: ChunkOptions,
): Generator<{ batch: T[]; lines: string[] }> {
  let current: T[] = [];
  let currentLines: string[] = [];
  let currentBytes = 0;

  for (const record of records) {
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch (err) {
      opts.logger.warn(
        `dropping unserializable record: ${(err as Error).message}`,
      );
      continue;
    }

    if (line.length > opts.maxUncompressedBytes) {
      opts.logger.warn(
        `dropping oversized record (${line.length} bytes > ${opts.maxUncompressedBytes} cap)`,
      );
      continue;
    }

    const addedBytes = line.length + (current.length > 0 ? 1 : 0);
    if (current.length > 0 && currentBytes + addedBytes > opts.maxUncompressedBytes) {
      yield { batch: current, lines: currentLines };
      current = [];
      currentLines = [];
      currentBytes = 0;
    }
    current.push(record);
    currentLines.push(line);
    currentBytes += addedBytes;
  }

  if (current.length > 0) yield { batch: current, lines: currentLines };
}

export interface SendNdjsonOptions {
  url: string;
  sourceToken: string;
  fetchImpl: typeof fetch;
  maxAttempts: number;
  backoffBaseMs: number;
  requestTimeoutMs: number;
}

export async function sendGzippedNdjson(
  lines: string[],
  opts: SendNdjsonOptions,
): Promise<void> {
  const ndjson = lines.join("\n");
  const body = await gzipAsync(Buffer.from(ndjson, "utf8"));

  let attempt = 0;
  while (true) {
    attempt++;

    let res: Response;
    try {
      res = await opts.fetchImpl(opts.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-ndjson",
          "Content-Encoding": "gzip",
          Authorization: `Bearer ${opts.sourceToken}`,
        },
        body,
        signal: AbortSignal.timeout(opts.requestTimeoutMs),
      });
    } catch (err) {
      if (attempt >= opts.maxAttempts) {
        throw new RetryableSinkError(
          `Better Stack unreachable after ${attempt} attempts: ${(err as Error).message}`,
        );
      }
      await sleep(backoffWithJitter(opts.backoffBaseMs, attempt));
      continue;
    }

    if (res.ok) return;

    const retriable = res.status === 429 || res.status >= 500;
    if (!retriable) {
      const preview = await readBodyPreview(res);
      throw new Error(`Better Stack rejected ${res.status}: ${preview}`);
    }

    if (attempt >= opts.maxAttempts) {
      throw new RetryableSinkError(
        `Better Stack unavailable after ${attempt} attempts (status ${res.status})`,
        res.status,
      );
    }

    await sleep(backoffWithJitter(opts.backoffBaseMs, attempt));
  }
}

function backoffWithJitter(base: number, attempt: number): number {
  const b = base * 2 ** (attempt - 1);
  return b + Math.random() * b * 0.5;
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
