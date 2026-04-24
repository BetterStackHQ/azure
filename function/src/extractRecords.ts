import { ActivityLogRecord } from "./types.js";

export interface ExtractLogger {
  warn(msg: string): void;
}

export function extractRecords(
  message: unknown,
  logger?: ExtractLogger,
): ActivityLogRecord[] | null {
  let payload: unknown = message;

  if (Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    try {
      payload = JSON.parse(Buffer.from(payload as Uint8Array).toString("utf8"));
    } catch (err) {
      logger?.warn(`binary message is not valid JSON: ${(err as Error).message}`);
      return null;
    }
  } else if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch (err) {
      logger?.warn(`string message is not valid JSON: ${(err as Error).message}`);
      return null;
    }
  }

  if (!payload || typeof payload !== "object") return null;

  const envelope = payload as { records?: unknown };
  if (Array.isArray(envelope.records)) {
    return envelope.records.filter(
      (r): r is ActivityLogRecord => typeof r === "object" && r !== null,
    );
  }
  return [payload as ActivityLogRecord];
}
