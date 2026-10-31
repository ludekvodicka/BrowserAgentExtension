import { expect, it, vi } from "vitest";
import { isResponse, maxMessageBytes, protocolVersion } from "../../shared/protocol.ts";
import type { RelayRequest } from "../../shared/protocol.ts";
import { createDispatcher } from "../src/dispatcher.ts";
import { ProfileState } from "../src/profileState.ts";
import { RequestLog } from "../src/requestLog.ts";
import type { BrowserTool } from "../src/tools/browserTool.ts";

export function storageFixture() {
  const data: Record<string, unknown> = {};
  return { data, get: vi.fn(async () => structuredClone(data)), set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(data, structuredClone(values)); }) };
}

function setup() {
  const storage = storageFixture();
  const state = new ProfileState(storage);
  const log = new RequestLog(storage);
  const tool: BrowserTool = { id: "test.tool.read", section: "test", group: "tool", title: "Fixture tool", hosts: ["https://example.com/*"], sensitive: true,
    run: vi.fn(async () => ({ ok: true as const, value: "invented-fixture-value" })) };
  const permissions = { contains: vi.fn(async () => true) };
  const action = { setBadgeText: vi.fn(async () => {}) };
  const dispatch = createDispatcher(state, log, [tool], permissions, action, "0.1.0");
  const request: RelayRequest = { id: "fixture", protocolVersion, op: "call", tool: tool.id, caller: "test" };
  return { storage, state, log, tool, permissions, action, dispatch, request };
}

it("initializes one UUID even on concurrent reads and defaults to deny", async () => {
  const { state } = setup();
  const [a, b] = await Promise.all([state.read(), state.read()]);
  expect(a).toEqual(b);
  expect(await state.read()).toEqual(a);
  expect(a).toMatchObject({ label: null, agentAccess: false, enabledTools: [] });
  expect(a.instanceId).toMatch(/^[0-9a-f-]{36}$/);
});

it("describes registry metadata and current enabled flags", async () => {
  const s = setup();
  await s.state.setEnabledTools([s.tool.id]);
  const response = await s.dispatch({ id: "describe", op: "describe", protocolVersion });
  expect(response).toMatchObject({ ok: true, profile: { tools: [{ id: s.tool.id, enabled: true, sensitive: true }] } });
  expect(await s.log.read()).toEqual([]);
});

it("stops at each gate in order and records refusals without running a tool", async () => {
  const s = setup();
  expect(await s.dispatch({ ...s.request, tool: "missing" })).toMatchObject({ code: "access_off" });
  await s.state.setAgentAccess(true);
  expect(await s.dispatch({ ...s.request, tool: "missing" })).toMatchObject({ code: "tool_unknown" });
  expect(await s.dispatch(s.request)).toMatchObject({ code: "tool_denied" });
  await s.state.setEnabledTools([s.tool.id]);
  s.permissions.contains.mockResolvedValue(false);
  expect(await s.dispatch(s.request)).toMatchObject({ code: "permission_missing" });
  expect(s.tool.run).not.toHaveBeenCalled();
  expect(s.action.setBadgeText).toHaveBeenCalledTimes(4);
  expect((await s.log.read()).map(row => row.outcome)).toEqual(["access_off", "tool_unknown", "tool_denied", "permission_missing"]);
});

it("runs once and retains only the newest 20 metadata records under concurrent writes", async () => {
  const s = setup();
  await s.state.setAgentAccess(true);
  await s.state.setEnabledTools([s.tool.id]);
  expect(await s.dispatch(s.request)).toMatchObject({ ok: true, value: "invented-fixture-value" });
  expect(s.tool.run).toHaveBeenCalledTimes(1);
  expect(await s.log.read()).toEqual([{ at: expect.any(String), tool: s.tool.id, caller: "test", outcome: "ok" }]);
  await Promise.all(Array.from({ length: 25 }, (_, i) => s.log.add({ at: String(i), tool: "fixture", caller: "test", outcome: "ok" })));
  const entries = await s.log.read();
  expect(entries).toHaveLength(20);
  expect(entries[0].at).toBe("5");
  expect(entries[19].at).toBe("24");
  expect(JSON.stringify(entries)).not.toContain("invented-fixture-value");
});

it("passes files only to a tool that accepts them", async () => {
  const s = setup();
  await s.state.setAgentAccess(true);
  await s.state.setEnabledTools([s.tool.id]);
  const files = [{ name: "a.pdf", data: "QUJD" }];
  expect(await s.dispatch({ ...s.request, files })).toMatchObject({ code: "tool_args_invalid", message: expect.stringContaining("--file") });
  expect(s.tool.run).not.toHaveBeenCalled();
  Object.assign(s.tool, { acceptsFiles: true });
  expect(await s.dispatch({ ...s.request, files })).toMatchObject({ ok: true });
  expect(await s.dispatch(s.request)).toMatchObject({ ok: true });
  expect(vi.mocked(s.tool.run).mock.calls).toEqual([[undefined, files, { caller: "test" }], [undefined, [], { caller: "test" }]]);
});

it("keeps quiet successes out of the log but records refusals including oversized successes", async () => {
  const s = setup();
  Object.assign(s.tool, { quiet: true });
  expect(await s.dispatch(s.request)).toMatchObject({ code: "access_off" });
  await s.state.setAgentAccess(true);
  await s.state.setEnabledTools([s.tool.id]);
  expect(await s.dispatch(s.request)).toMatchObject({ ok: true });
  vi.mocked(s.tool.run).mockResolvedValueOnce({ ok: false, code: "tab_missing", message: "No fixture tab" });
  expect(await s.dispatch(s.request)).toMatchObject({ code: "tab_missing" });
  vi.mocked(s.tool.run).mockResolvedValueOnce({ ok: true, value: "x".repeat(900_001) });
  expect(await s.dispatch(s.request)).toMatchObject({ code: "result_too_large" });
  expect((await s.log.read()).map(row => row.outcome)).toEqual(["access_off", "tab_missing", "result_too_large"]);
});

it("honors master revocation before run but returns a tool already running", async () => {
  const s = setup();
  await s.state.setEnabledTools([s.tool.id]);
  await s.state.setAgentAccess(true);
  s.permissions.contains.mockImplementationOnce(async () => { await s.state.setAgentAccess(false); return true; });
  expect(await s.dispatch(s.request)).toMatchObject({ code: "access_off" });
  expect(s.tool.run).not.toHaveBeenCalled();
  await s.state.setAgentAccess(true);
  vi.mocked(s.tool.run).mockImplementationOnce(async () => { await s.state.setAgentAccess(false); return { ok: true, value: "fixture" }; });
  expect(await s.dispatch(s.request)).toMatchObject({ ok: true });
  expect(await s.dispatch(s.request)).toMatchObject({ code: "access_off" });
  expect((await s.state.read()).enabledTools).toEqual([s.tool.id]);
});

it("sanitizes thrown errors and rejects version mismatch before the tool", async () => {
  const s = setup();
  await s.state.setAgentAccess(true);
  await s.state.setEnabledTools([s.tool.id]);
  expect(await s.dispatch({ ...s.request, protocolVersion: 99 })).toMatchObject({ code: "protocol_mismatch" });
  expect(s.tool.run).not.toHaveBeenCalled();
  vi.mocked(s.tool.run).mockRejectedValueOnce(new Error("invented-private-value"));
  const response = await s.dispatch(s.request);
  expect(response).toMatchObject({ code: "extension_error" });
  expect(JSON.stringify(response)).not.toContain("invented-private-value");
  await expect(s.dispatch({ ...s.request, op: "unknown" } as unknown as RelayRequest)).rejects.toThrow("Unknown operation");
});

it("rejects protocol v1 before checking permissions or running a tool", async () => {
  const s = setup();
  expect(await s.dispatch({ ...s.request, protocolVersion: 1 })).toMatchObject({ code: "protocol_mismatch" });
  expect(s.permissions.contains).not.toHaveBeenCalled();
  expect(s.tool.run).not.toHaveBeenCalled();
});

it.each(["x".repeat(900_001), "😀".repeat(300_000)])("refuses oversized results before logging without disconnecting", async value => {
  const s = setup();
  await s.state.setAgentAccess(true);
  await s.state.setEnabledTools([s.tool.id]);
  vi.mocked(s.tool.run).mockResolvedValueOnce({ ok: true, value });
  const response = await s.dispatch(s.request);
  expect(response).toMatchObject({ ok: false, code: "result_too_large" });
  expect(response).not.toHaveProperty("value");
  expect(new TextEncoder().encode(JSON.stringify(response)).length).toBeLessThan(maxMessageBytes);
  expect(await s.log.read()).toEqual([{ at: expect.any(String), tool: s.tool.id, caller: "test", outcome: "result_too_large" }]);
  expect(s.action.setBadgeText).toHaveBeenCalledWith({ text: "!" });
  expect(await s.dispatch(s.request)).toMatchObject({ ok: true });
});

it("guards describe and refusal responses even when profile metadata is oversized", async () => {
  const s = setup();
  await s.state.setLabel("x".repeat(900_001));
  for (const request of [{ id: "describe", op: "describe" as const, protocolVersion }, s.request]) {
    const response = await s.dispatch(request);
    expect(response).toMatchObject({ ok: false, code: "result_too_large" });
    expect(JSON.stringify(response).length).toBeLessThan(1000);
  }
});

it.each(["tab_missing", "tab_not_ready", "tool_args_invalid", "result_too_large"] as const)("accepts the v3 refusal %s", code => {
  expect(isResponse({ ok: false, code, message: "fixture" })).toBe(true);
});
