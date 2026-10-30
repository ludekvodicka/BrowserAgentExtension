import { expect, it, vi } from "vitest";
import { Grants } from "../src/grants.ts";
import { ProfileState } from "../src/profileState.ts";
import type { ToolInfo } from "../../shared/protocol.ts";

function setup() {
  const data: Record<string, unknown> = {};
  const storage = { get: vi.fn(async () => structuredClone(data)), set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(data, value); }) };
  const state = new ProfileState(storage);
  const tools: ToolInfo[] = ["one", "two"].map(id => ({ id, section: "test", group: "test", title: id, hosts: ["https://example.com/*"], sensitive: true, enabled: false }));
  const permissions = { request: vi.fn(async () => true), remove: vi.fn(async () => true), contains: vi.fn(async () => true) };
  return { state, tools, storage, permissions, grants: new Grants(state, tools, permissions) };
}

it("requests permission during the user gesture and leaves a refused tool disabled", async () => {
  const s = setup();
  s.permissions.request.mockResolvedValue(false);
  const pending = s.grants.setEnabled("one", true);
  expect(s.permissions.request).toHaveBeenCalledExactlyOnceWith({ origins: ["https://example.com/*"] });
  expect(s.storage.get).not.toHaveBeenCalled();
  expect(await pending).toBe(false);
  expect((await s.state.read()).enabledTools).toEqual([]);
});

it("keeps shared origins until the last enabled tool is disabled", async () => {
  const s = setup();
  await s.grants.setEnabled("one", true);
  await s.grants.setEnabled("two", true);
  await s.grants.setEnabled("one", false);
  expect(s.permissions.remove).not.toHaveBeenCalled();
  expect((await s.state.read()).enabledTools).toEqual(["two"]);
  await s.grants.setEnabled("two", false);
  expect(s.permissions.remove).toHaveBeenCalledExactlyOnceWith({ origins: ["https://example.com/*"] });
  expect((await s.state.read()).enabledTools).toEqual([]);
});

it("trims labels, stores empty as null and keeps tool choices on master off", async () => {
  const s = setup();
  await s.state.setLabel("  work  ");
  expect((await s.state.read()).label).toBe("work");
  await s.state.setLabel("  ");
  expect((await s.state.read()).label).toBeNull();
  await s.grants.setEnabled("one", true);
  await s.state.setAgentAccess(true);
  await s.state.setAgentAccess(false);
  expect(await s.state.read()).toMatchObject({ agentAccess: false, enabledTools: ["one"] });
});

it("finishes an enable in the background when the popup closed during the permission prompt", async () => {
  const s = setup();
  s.permissions.request.mockReturnValue(new Promise(() => {}));
  void s.grants.setEnabled("one", true);
  await vi.waitFor(async () => expect((await s.state.read()).pendingTool).toBe("one"));
  expect((await s.state.read()).enabledTools).toEqual([]);
  await new Grants(s.state, s.tools, s.permissions).completePending();
  expect(await s.state.read()).toMatchObject({ enabledTools: ["one"], pendingTool: null });
});

it("keeps a pending tool disabled while its site permission is missing", async () => {
  const s = setup();
  await s.state.setPendingTool("one");
  s.permissions.contains.mockResolvedValue(false);
  await s.grants.completePending();
  expect(await s.state.read()).toMatchObject({ enabledTools: [], pendingTool: "one" });
});

it("clears the pending mark when the permission is declined", async () => {
  const s = setup();
  s.permissions.request.mockResolvedValue(false);
  expect(await s.grants.setEnabled("one", true)).toBe(false);
  expect((await s.state.read()).pendingTool).toBeNull();
});
