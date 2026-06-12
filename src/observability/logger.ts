import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import type { AppConfig, RuntimeEvent } from "../core/types.js";
import { redact, redactJsonValue } from "../security/redact.js";

export class EventLog {
  private readonly file: string;
  private readonly logger;
  private pendingAppend: Promise<void> = Promise.resolve();

  constructor(readonly config: AppConfig) {
    fs.mkdirSync(path.join(config.data_dir, "logs"), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.file = path.join(
      config.data_dir,
      "logs",
      `cross-review-${stamp}-pid${process.pid}.ndjson`,
    );
    this.logger = pino({ level: config.log_level }, pino.destination(2));
  }

  emit(event: RuntimeEvent): void {
    const payload = { ...event, ts: event.ts ?? new Date().toISOString() };
    const redactedPayload = redactJsonValue(payload);
    const redactedPayloadText = JSON.stringify(redactedPayload);
    this.pendingAppend = this.pendingAppend
      .then(() => fs.promises.appendFile(this.file, `${redactedPayloadText}\n`, "utf8"))
      .catch((error: unknown) => {
        this.logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          "event_log_append_failed",
        );
      });
    this.logger.info(redactedPayload, redact(event.message ?? event.type));
  }

  async flush(): Promise<void> {
    await this.pendingAppend;
  }

  path(): string {
    return this.file;
  }
}
