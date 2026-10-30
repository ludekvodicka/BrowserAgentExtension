import { afterEach, expect, it, vi } from "vitest";
import { NativeConnection } from "../src/connection.ts";
import { protocolVersion } from "../../shared/protocol.ts";
import type { ProfileInfo } from "../../shared/protocol.ts";

afterEach(() => vi.useRealTimers());
function event() {
  const listeners: ((value?: any) => void)[] = [];
  return { addListener: (listener: (value?: any) => void) => listeners.push(listener), emit: (value?: unknown) => listeners.forEach(listener => listener(value)) };
}
function setup() {
  vi.useFakeTimers();
  const ports: ReturnType<typeof makePort>[] = [];
  const makePort = () => ({ onMessage: event(), onDisconnect: event(), postMessage: vi.fn(), disconnect: vi.fn() });
  const runtime = { lastError: undefined as chrome.runtime.LastError | undefined, connectNative: vi.fn(() => {
    const port = makePort();
    ports.push(port);
    return port as unknown as chrome.runtime.Port;
  }) };
  const alarms = { create: vi.fn(async () => {}), onAlarm: event() };
  const profile: ProfileInfo = { instanceId: "00000000-0000-4000-8000-000000000000", label: null, agentAccess: false, extensionVersion: "0.1.0", protocolVersion, tools: [] };
  const dispatch = vi.fn(async (request) => ({ id: request.id, ok: true as const, profile }));
  const connection = new NativeConnection(runtime, alarms as unknown as Pick<typeof chrome.alarms, "create" | "onAlarm">, async () => profile, dispatch);
  return { connection, runtime, alarms, ports, profile, dispatch };
}

it("connects once, sends hello, waits for ready and reconnects on an alarm", async () => {
  const s = setup();
  s.connection.start();
  await Promise.resolve();
  expect(s.ports[0].postMessage).toHaveBeenCalledExactlyOnceWith({ type: "hello", profile: s.profile });
  expect(s.connection.getStatus().state).toBe("connecting");
  s.ports[0].onMessage.emit({ type: "ready", pipe: "fixture" });
  expect(s.connection.getStatus().state).toBe("connected");
  s.alarms.onAlarm.emit({ name: "reconnect" });
  expect(s.ports).toHaveLength(1);
  s.runtime.lastError = { message: "Specified native messaging host not found." };
  s.ports[0].onDisconnect.emit();
  expect(s.connection.getStatus()).toEqual({ state: "disconnected", error: s.runtime.lastError.message });
  s.alarms.onAlarm.emit({ name: "reconnect" });
  await Promise.resolve();
  expect(s.ports).toHaveLength(2);
  expect(s.ports[1].postMessage).toHaveBeenCalledExactlyOnceWith({ type: "hello", profile: s.profile });
  s.ports[0].onDisconnect.emit();
  expect(s.connection.getStatus().state).toBe("connecting");
  s.ports[1].onMessage.emit({ type: "ready", pipe: "fixture" });
  s.ports[1].onMessage.emit({ id: "request", op: "describe", protocolVersion });
  await Promise.resolve();
  expect(s.dispatch).toHaveBeenCalledTimes(1);
  expect(s.ports[1].postMessage).toHaveBeenLastCalledWith({ id: "request", ok: true, profile: s.profile });
});

it("joins a call's file chunks and passes them with the call; chunks out of order close the port", async () => {
  const s = setup();
  s.connection.start();
  await Promise.resolve();
  s.ports[0].onMessage.emit({ type: "ready", pipe: "fixture" });
  for (const [index, name, data] of [[0, "a.pdf", "QUJD"], [0, "a.pdf", "REVG"], [1, "b.txt", ""]] as const)
    s.ports[0].onMessage.emit({ type: "fileChunk", id: "call", index, name, data });
  s.ports[0].onMessage.emit({ id: "call", op: "call", protocolVersion, tool: "fixture", caller: "test" });
  s.ports[0].onMessage.emit({ id: "plain", op: "call", protocolVersion, tool: "fixture", caller: "test" });
  expect(s.dispatch.mock.calls.map(([request]) => request)).toEqual([
    { id: "call", op: "call", protocolVersion, tool: "fixture", caller: "test", files: [{ name: "a.pdf", data: "QUJDREVG" }, { name: "b.txt", data: "" }] },
    { id: "plain", op: "call", protocolVersion, tool: "fixture", caller: "test" },
  ]);
  s.ports[0].onMessage.emit({ type: "fileChunk", id: "next", index: 2, name: "c.txt", data: "" });
  expect(s.ports[0].disconnect).toHaveBeenCalledTimes(1);
});

it("handshake timeout and refusal close the old port, allowing a fresh connection", async () => {
  const s = setup();
  s.connection.start();
  await Promise.resolve();
  vi.advanceTimersByTime(5000);
  expect(s.ports[0].disconnect).toHaveBeenCalledTimes(1);
  expect(s.connection.getStatus().state).toBe("disconnected");
  s.connection.connect();
  s.ports[1].onMessage.emit({ type: "refused", code: "protocol_mismatch", message: "Update both components." });
  expect(s.connection.getStatus()).toEqual({ state: "disconnected", error: "Update both components." });
});
