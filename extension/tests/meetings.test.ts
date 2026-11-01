import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import { protocolVersion } from "../../shared/protocol.ts";
import { createDispatcher, describeProfile } from "../src/dispatcher.ts";
import { mountPopup } from "../src/popup.ts";
import { ProfileState } from "../src/profileState.ts";
import { RequestLog } from "../src/requestLog.ts";
import { groups, sections, tools } from "../src/tools/toolRegistry.ts";
import { meetingKey, meetingsFromTabs } from "../src/tools/meetings/web/meetingRules.ts";
import type { MeetingProvider } from "../src/tools/meetings/web/meetingRules.ts";

afterEach(() => vi.unstubAllGlobals());

it.each<[MeetingProvider, string, string]>([
  ["googleMeet", "https://meet.google.com/abc-defg-hij?authuser=1#ignored", "meet.google.com/abc-defg-hij"],
  ["googleMeet", "https://meet.google.com/ABC-DEFG-HIJ/extra", "meet.google.com/ABC-DEFG-HIJ/extra"],
  // Meet itself navigated a joined call to this form (Brave, November 2026).
  ["googleMeet", "https://meet.google.com/meet/qhc-mrer-hhc", "meet.google.com/meet/qhc-mrer-hhc"],
  ["zoom", "https://us02web.zoom.us/wc/123/join?pwd=fixture", "us02web.zoom.us/wc/123/join"],
  ["teams", "https://teams.microsoft.com/l/meetup-join/fixture?context=ignored", "teams.microsoft.com/l/meetup-join/fixture"],
  ["teams", "https://teams.cloud.microsoft/v2/#/meet/fixture", "teams.cloud.microsoft/v2/#/meet/fixture"],
  ["teams", "https://teams.microsoft.com/_#/CALL/fixture", "teams.microsoft.com/_#/CALL/fixture"],
])("recognizes %s meeting URL %s", (provider, url, key) => {
  expect(meetingKey(provider, url)).toBe(key);
});

it.each<[MeetingProvider, string]>([
  ["googleMeet", "https://meet.google.com/"],
  ["googleMeet", "https://meet.google.com/lookup/fixture"],
  ["googleMeet", "https://meet.google.com/home"],
  ["googleMeet", "https://meet.google.com/meet/home"],
  ["googleMeet", "https://meet.google.com/other/abc-defg-hij"],
  ["googleMeet", "https://meet.google.com/abc-defg-hijk"],
  ["googleMeet", "https://meet.google.com.evil.test/abc-defg-hij"],
  ["googleMeet", "http://meet.google.com/abc-defg-hij"],
  ["googleMeet", "not a url"],
  ["zoom", "https://us02web.zoom.us/j/123"],
  ["zoom", "https://us02web.zoom.us/WC/123"],
  ["zoom", "https://zoom.us/wc/123"],
  ["zoom", "https://evilzoom.us/wc/123"],
  ["zoom", "https://zoom.us.evil.test/wc/123"],
  ["teams", "https://teams.microsoft.com/v2/#/chat/fixture"],
  ["teams", "https://teams.microsoft.com/v2/#/meeting/fixture"],
  ["teams", "https://teams.microsoft.com/?next=/meet/fixture"],
  ["teams", "https://teams.microsoft.com.evil.test/#/call/fixture"],
])("rejects %s non-meeting URL %s", (provider, url) => {
  expect(meetingKey(provider, url)).toBeNull();
});

it("caps keys and titles and supplies stable types when optional tab metadata is absent", () => {
  const url = "https://teams.microsoft.com/#/meet/" + "a".repeat(400);
  expect(meetingsFromTabs("teams", [
    { id: 1, windowId: 2, url, title: "b".repeat(400), audible: true, lastAccessed: 123 },
    { id: 3, windowId: 2, url },
    { windowId: 2, url },
    { id: 4, windowId: 2 },
  ])).toEqual([
    { key: ("teams.microsoft.com/#/meet/" + "a".repeat(400)).slice(0, 300), title: "b".repeat(300), tabId: 1, windowId: 2, audible: true, lastAccessed: 123 },
    { key: ("teams.microsoft.com/#/meet/" + "a".repeat(400)).slice(0, 300), title: "", tabId: 3, windowId: 2, audible: false, lastAccessed: 0 },
  ]);
});

it("integrates registry, permission gate, tabs query and quiet logs for all meeting tools", async () => {
  const data: Record<string, unknown> = {};
  const storage = { get: async () => structuredClone(data), set: async (value: Record<string, unknown>) => { Object.assign(data, value); } };
  const state = new ProfileState(storage);
  const log = new RequestLog(storage);
  const permissions = { contains: vi.fn(async () => true) };
  const query = vi.fn(async () => [{ id: 7, windowId: 8, title: "Meeting fixture", audible: true, lastAccessed: 100,
    url: "https://meet.google.com/abc-defg-hij" }]);
  vi.stubGlobal("chrome", { tabs: { query } });
  const dispatch = createDispatcher(state, log, tools, permissions, { setBadgeText: vi.fn() }, "0.1.0");
  await state.setAgentAccess(true);
  const selected = tools.filter(tool => tool.section === "meetings");
  expect(selected.map(tool => tool.id)).toEqual(["meetings.web.googleMeet", "meetings.web.zoom", "meetings.web.teams"]);
  await state.setEnabledTools(selected.map(tool => tool.id));
  for (const tool of selected) {
    expect(tool.sensitive).toBe(false);
    expect(tool.pageScripts).toBeUndefined();
    expect(tool.acceptsFiles).toBeUndefined();
    const response = await dispatch({ id: tool.id, protocolVersion, op: "call", tool: tool.id, caller: "test" });
    expect(response).toMatchObject({ ok: true, value: { meetings: tool.id === "meetings.web.googleMeet"
      ? [{ key: "meet.google.com/abc-defg-hij", title: "Meeting fixture", tabId: 7, windowId: 8, audible: true, lastAccessed: 100 }] : [] } });
    expect(query).toHaveBeenLastCalledWith({ url: tool.hosts });
    expect(permissions.contains).toHaveBeenLastCalledWith({ origins: tool.hosts });
  }
  expect(query).toHaveBeenCalledTimes(3);
  expect(await log.read()).toEqual([]);
  await state.setEnabledTools([]);
  expect(await dispatch({ id: "denied", protocolVersion, op: "call", tool: selected[0].id, caller: "test" }))
    .toMatchObject({ ok: false, code: "tool_denied" });
  expect((await log.read()).map(row => row.outcome)).toEqual(["tool_denied"]);
  expect(query).toHaveBeenCalledTimes(3);

  const dom = new JSDOM(readFileSync(new URL("../popup.html", import.meta.url), "utf8"));
  try {
    const popup = { profile: describeProfile(await state.read(), tools, "0.1.0"), sections, groups,
      connection: { state: "connected", error: null }, log: await log.read() };
    await mountPopup(dom.window.document, { sendMessage: vi.fn(async () => popup) }, storage,
      { contains: permissions.contains, request: vi.fn(), remove: vi.fn() }, "register", { siteAccess: async () => {}, debugAccess: async () => {} });
    expect(dom.window.document.querySelector('[data-tab="group-meetings-web"]')?.textContent).toBe("Meetings");
    expect(dom.window.document.querySelectorAll('#tab-group-meetings-web [data-tool]')).toHaveLength(3);
  } finally {
    dom.window.close();
  }
  const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  expect(manifest.permissions).not.toContain("tabs");
  for (const tool of selected)
    expect(manifest.optional_host_permissions).toEqual(expect.arrayContaining(tool.hosts));
});
