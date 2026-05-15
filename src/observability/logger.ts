import fs from "node:fs";
import path from "node:path";
import pino from "pino";
import type { AppConfig, RuntimeEvent } from "../core/types.js";

export class EventLog {
  private readonly file: string;
  private readonly logger;

  constructor(private readonly config: AppConfig) {
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
    const payload = { ts: new Date().toISOString(), ...event };
    fs.appendFileSync(this.file, `${JSON.stringify(payload)}\n`, "utf8");
    this.logger.info(payload, event.message ?? event.type);
  }

  path(): string {
    return this.file;
  }
}
