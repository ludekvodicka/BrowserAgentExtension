import type { ErrorCode } from "../../shared/protocol.ts";

export type RequestLogEntry = { at: string; tool: string; caller: string; outcome: "ok" | ErrorCode };

export class RequestLog {
  private storage: Pick<typeof chrome.storage.local, "get" | "set">;
  private writing: Promise<void>;

  constructor(storage: Pick<typeof chrome.storage.local, "get" | "set">) {
    this.storage = storage;
    this.writing = Promise.resolve();
  }

  async read(): Promise<RequestLogEntry[]> {
    const { requestLog } = await this.storage.get("requestLog");
    return Array.isArray(requestLog) ? requestLog : [];
  }

  add(entry: RequestLogEntry): Promise<void> {
    this.writing = this.writing.catch(() => {}).then(async () => {
      const entries = await this.read();
      await this.storage.set({ requestLog: [...entries, { at: entry.at, tool: entry.tool, caller: entry.caller, outcome: entry.outcome }].slice(-20) });
    });
    return this.writing;
  }
}
