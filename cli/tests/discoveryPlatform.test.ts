import { EventEmitter } from "node:events";
import { readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { beforeEach, expect, it, vi } from "vitest";
import { protocolVersion } from "../../shared/protocol.ts";
import { discoverProfiles } from "../pipeClient.ts";

vi.mock("node:fs", () => ({ readdirSync: vi.fn() }));
vi.mock("node:net", () => ({ createConnection: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

it("discovers multiple macOS profiles and separates stale and incompatible sockets", async () => {
  const ids = [1, 2, 3, 4].map(n => `00000000-0000-4000-8000-00000000000${n}`);
  vi.mocked(readdirSync).mockReturnValue([...ids.map(id => `browser-agent-${id}.sock`), "browser-agent-invalid.sock", "unrelated", `browser-agent-${ids[0]}.bak`] as never);
  const sent: unknown[] = [];
  vi.mocked(createConnection).mockImplementation((...args: unknown[]) => {
    const path = String(args[0]);
    const id = ids.find(id => path.endsWith(`${id}.sock`))!;
    const socket = Object.assign(new EventEmitter(), { destroy: vi.fn(), write: (line: string) => {
      sent.push(JSON.parse(line));
      queueMicrotask(() => socket.emit("data", Buffer.from(JSON.stringify({ ok: true, profile: {
        instanceId: id, label: id === ids[0] ? "first" : "second", agentAccess: true, extensionVersion: "0.1.0",
        protocolVersion: id === ids[2] ? 99 : protocolVersion, tools: [],
      } }) + "\n")));
    } });
    queueMicrotask(() => socket.emit(id === ids[3] ? "error" : "connect"));
    return socket as unknown as ReturnType<typeof createConnection>;
  });
  const result = await discoverProfiles("darwin", "/Users/test");
  expect(readdirSync).toHaveBeenCalledWith("/Users/test/.browser-agent/run");
  expect(createConnection).toHaveBeenCalledTimes(4);
  expect(result.profiles.map(({ profile }) => profile.instanceId)).toEqual(ids.slice(0, 2));
  expect(result.refused).toMatchObject([{ code: "protocol_mismatch" }, { code: "extension_disconnected" }]);
  expect(sent).toEqual(Array.from({ length: 3 }, () => ({ op: "describe", protocolVersion })));
});

it("treats a missing macOS run directory as no profiles, but preserves other filesystem errors", async () => {
  vi.mocked(readdirSync).mockImplementationOnce(() => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); });
  expect(await discoverProfiles("darwin", "/Users/test")).toEqual({ profiles: [], refused: [] });
  vi.mocked(readdirSync).mockImplementationOnce(() => { throw Object.assign(new Error("denied"), { code: "EACCES" }); });
  await expect(discoverProfiles("darwin", "/Users/test")).rejects.toThrow("denied");
  expect(createConnection).not.toHaveBeenCalled();
});
