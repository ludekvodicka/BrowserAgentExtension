import { hostName, isFileChunk, isRecord, isRequest } from "../../shared/protocol.ts";
import type { ProfileInfo, RelayRequest, RelayResponse, ToolFile } from "../../shared/protocol.ts";

export type ConnectionStatus = { state: "disconnected" | "connecting" | "connected"; error: string };

export class NativeConnection {
  private runtime: Pick<typeof chrome.runtime, "connectNative" | "lastError">;
  private alarms: Pick<typeof chrome.alarms, "create" | "onAlarm">;
  private describe: () => Promise<ProfileInfo>;
  private dispatch: (request: RelayRequest) => Promise<RelayResponse>;
  private port: chrome.runtime.Port | undefined;
  private handshake: ReturnType<typeof setTimeout> | undefined;
  private status: ConnectionStatus;

  constructor(runtime: Pick<typeof chrome.runtime, "connectNative" | "lastError">,
    alarms: Pick<typeof chrome.alarms, "create" | "onAlarm">, describe: () => Promise<ProfileInfo>,
    dispatch: (request: RelayRequest) => Promise<RelayResponse>) {
    this.runtime = runtime;
    this.alarms = alarms;
    this.describe = describe;
    this.dispatch = dispatch;
    this.status = { state: "disconnected", error: "" };
  }

  start(): void {
    void this.alarms.create("reconnect", { periodInMinutes: 1 });
    this.alarms.onAlarm.addListener(alarm => {
      if (alarm.name === "reconnect")
        this.connect();
    });
    this.connect();
  }

  getStatus(): ConnectionStatus {
    return { ...this.status };
  }

  private disconnect(port: chrome.runtime.Port, error: string): void {
    if (this.port !== port)
      return;
    clearTimeout(this.handshake);
    this.port = undefined;
    this.status = { state: "disconnected", error };
    port.disconnect();
  }

  connect(): void {
    if (this.port)
      return;
    this.status = { state: "connecting", error: "" };
    let port: chrome.runtime.Port;
    try {
      port = this.runtime.connectNative(hostName);
    } catch {
      this.status = { state: "disconnected", error: "Cannot start the native host. Run browser-agent register." };
      return;
    }
    this.port = port;
    this.handshake = setTimeout(() => this.disconnect(port, "Native host handshake timed out. Run browser-agent register and reload the extension."), 5000);
    port.onDisconnect.addListener(() => {
      const error = this.runtime.lastError?.message || "Native host disconnected. Reopen the browser profile or run browser-agent register.";
      if (this.port !== port)
        return;
      clearTimeout(this.handshake);
      this.port = undefined;
      this.status = { state: "disconnected", error };
    });
    // The host sends a request's files in ordered chunks just before the request itself.
    const files = new Map<string, ToolFile[]>();
    port.onMessage.addListener((message: unknown) => {
      if (this.port !== port)
        return;
      if (isRecord(message) && message.type === "ready") {
        clearTimeout(this.handshake);
        this.status = { state: "connected", error: "" };
      } else if (isRecord(message) && message.type === "refused")
        this.disconnect(port, typeof message.message === "string" ? message.message : "Native host refused the connection.");
      else if (this.status.state === "connected" && isFileChunk(message)) {
        const received = files.get(message.id) ?? [];
        if (message.index === received.length)
          received.push({ name: message.name, data: message.data });
        else if (message.index === received.length - 1)
          received[message.index].data += message.data;
        else return this.disconnect(port, "File chunks arrived out of order. Reload the extension.");
        files.set(message.id, received);
      } else if (this.status.state === "connected" && isRequest(message) && "id" in message && typeof message.id === "string") {
        const attached = files.get(message.id);
        files.delete(message.id);
        const request: RelayRequest = { ...message, id: message.id, ...(message.op === "call" && attached ? { files: attached } : {}) };
        void this.dispatch(request).then(response => {
          if (this.port === port)
            port.postMessage(response);
        }).catch(() => this.disconnect(port, "Request failed. Reload the extension."));
      } else this.disconnect(port, "Invalid host message. Update the extension and native host together.");
    });
    void this.describe().then(profile => {
      if (this.port === port)
        port.postMessage({ type: "hello", profile });
    }).catch(() => this.disconnect(port, "Cannot read this profile's settings. Reload the extension."));
  }
}
