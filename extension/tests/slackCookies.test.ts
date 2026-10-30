import { afterEach, expect, it, vi } from "vitest";
import { protocolVersion } from "../../shared/protocol.ts";
import { slackCookies } from "../src/tools/appdata/slack/slackCookies.ts";
import { tools } from "../src/tools/toolRegistry.ts";
import { createDispatcher } from "../src/dispatcher.ts";
import { ProfileState } from "../src/profileState.ts";
import { RequestLog } from "../src/requestLog.ts";

afterEach(() => vi.unstubAllGlobals());
const cookie = (sameSite: chrome.cookies.Cookie["sameSite"], session: boolean, name = "d"): chrome.cookies.Cookie => ({ name, value: "made-up-fixture",
  domain: ".slack.com", path: "/", secure: true, httpOnly: true, hostOnly: false, sameSite, session, expirationDate: 1234567890, storeId: "0" });

it("reads only Slack and maps all SameSite values and session expiry to Playwright", async () => {
  const getAll = vi.fn(async () => [cookie("no_restriction", true), cookie("lax", false, "fixture1"), cookie("strict", false, "fixture2"), cookie("unspecified", false, "fixture3")]);
  vi.stubGlobal("chrome", { cookies: { getAll } });
  const result = await slackCookies.run(undefined);
  expect(getAll).toHaveBeenCalledExactlyOnceWith({ domain: "slack.com" });
  expect(result).toEqual({ ok: true, value: [
    { name: "d", value: "made-up-fixture", domain: ".slack.com", path: "/", expires: -1, secure: true, httpOnly: true, sameSite: "None" },
    ...["Lax", "Strict", "Lax"].map((sameSite, i) => ({ name: `fixture${i + 1}`, value: "made-up-fixture", domain: ".slack.com", path: "/", expires: 1234567890, secure: true, httpOnly: true, sameSite })),
  ] });
});

it("missing d cookie gives a sign-in instruction and no value", async () => {
  vi.stubGlobal("chrome", { cookies: { getAll: async () => [cookie("lax", false, "fixture")] } });
  expect(await slackCookies.run(undefined)).toEqual({ ok: false, code: "not_signed_in", message: "Sign in to Slack in this browser profile, then request the tool again." });
});

it("real registry is described, denied before reading cookies, then allowed without logging values", async () => {
  const getAll = vi.fn(async () => [cookie("lax", true)]);
  vi.stubGlobal("chrome", { cookies: { getAll } });
  const data: Record<string, unknown> = {};
  const storage = { get: async () => structuredClone(data), set: async (value: Record<string, unknown>) => { Object.assign(data, value); } };
  const state = new ProfileState(storage);
  const log = new RequestLog(storage);
  const dispatch = createDispatcher(state, log, tools, { contains: async () => true }, { setBadgeText: async () => {} }, "0.1.0");
  const info = await dispatch({ id: "describe", op: "describe", protocolVersion });
  expect(info).toMatchObject({ ok: true, profile: { tools: [
    { id: "appdata.slack.cookies", section: "appdata", group: "slack", sensitive: true, enabled: false },
    { id: "appdata.slack.api", section: "appdata", group: "slack", sensitive: false, enabled: false },
    { id: "appdata.outlook.mail", section: "appdata", group: "outlook", sensitive: false, enabled: false },
    { id: "appdata.gmail.thread", section: "appdata", group: "gmail", sensitive: false, enabled: false },
    { id: "appdata.gmail.attachments", section: "appdata", group: "gmail", sensitive: false, enabled: false },
    { id: "appdata.gmail.draft", section: "appdata", group: "gmail", sensitive: false, enabled: false },
    { id: "appdata.gmail.reply", section: "appdata", group: "gmail", sensitive: false, enabled: false },
    { id: "browser.tabs.open", section: "browser", group: "tabs", sensitive: false, enabled: false },
    { id: "meetings.web.googleMeet", section: "meetings", group: "web", sensitive: false, enabled: false },
    { id: "meetings.web.zoom", section: "meetings", group: "web", sensitive: false, enabled: false },
    { id: "meetings.web.teams", section: "meetings", group: "web", sensitive: false, enabled: false },
  ] } });
  await state.setAgentAccess(true);
  const request = { id: "call", op: "call" as const, protocolVersion, tool: slackCookies.id, caller: "fixture" };
  expect(await dispatch(request)).toMatchObject({ code: "tool_denied" });
  expect(getAll).not.toHaveBeenCalled();
  await state.setEnabledTools([slackCookies.id]);
  expect(await dispatch(request)).toMatchObject({ ok: true });
  expect(getAll).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(await log.read())).not.toContain("made-up-fixture");
});
