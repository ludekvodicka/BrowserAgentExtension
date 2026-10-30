import { afterEach, expect, it, vi } from "vitest";
import { protocolVersion } from "../../shared/protocol.ts";
import { createDispatcher } from "../src/dispatcher.ts";
import { ProfileState } from "../src/profileState.ts";
import { RequestLog } from "../src/requestLog.ts";
import { Grants } from "../src/grants.ts";
import { tools } from "../src/tools/toolRegistry.ts";
import { slackApi } from "../src/tools/appdata/slack/slackApi.ts";
import { slackApiPage } from "../src/tools/appdata/slack/slackApiPage.ts";
import type { SlackApiPageResult } from "../src/tools/appdata/slack/slackApiPage.ts";

afterEach(() => vi.unstubAllGlobals());
const args = { teamId: "TFIXTURE1", method: "conversations.info", params: { channel: "CFIXTURE1" } };

function setup(result: SlackApiPageResult = { kind: "response", status: 200, body: { ok: true, channel: { name: "fixture-channel" } } }) {
  const query = vi.fn(async () => [{ id: 7 }, { id: 8 }]);
  const executeScript = vi.fn(async () => [{ result }]);
  vi.stubGlobal("chrome", { tabs: { query }, scripting: { executeScript } });
  return { query, executeScript };
}

it.each([undefined, null, {}, { ...args, method: "chat.postMessage" }, { ...args, method: "../write" },
  { ...args, teamId: "t123" }, { ...args, teamId: "T" }, { ...args, teamId: "T1/evil" },
  { ...args, params: undefined }, { ...args, params: null }, { ...args, params: [] },
  { ...args, params: { channel: {} } }, { ...args, params: { limit: [] } },
  { ...args, params: { limit: NaN } }, { ...args, params: { limit: Infinity } }])("rejects invalid args before touching a tab: %j", async input => {
  const s = setup();
  expect(await slackApi.run(input)).toMatchObject({ ok: false, code: "tool_args_invalid" });
  expect(s.query).not.toHaveBeenCalled();
  expect(s.executeScript).not.toHaveBeenCalled();
});

it.each(["conversations.history", "conversations.replies", "conversations.info", "users.info", "users.conversations"])("allows one isolated call of %s in the first Slack tab", async method => {
  const s = setup();
  const input = { ...args, method, params: { channel: "CFIXTURE1", limit: 20, inclusive: true } };
  expect(await slackApi.run(input)).toEqual({ ok: true, value: { ok: true, channel: { name: "fixture-channel" } } });
  expect(s.query).toHaveBeenCalledExactlyOnceWith({ url: "https://app.slack.com/*", discarded: false });
  expect(s.executeScript).toHaveBeenCalledExactlyOnceWith({ target: { tabId: 7 }, world: "ISOLATED",
    func: slackApiPage, args: [input.teamId, method, input.params] });
});

it("requests an open Slack tab without opening one", async () => {
  const s = setup();
  s.query.mockResolvedValue([]);
  expect(await slackApi.run(args)).toMatchObject({ code: "tab_missing", message: expect.stringContaining("app.slack.com") });
  expect(s.executeScript).not.toHaveBeenCalled();
});

it("maps a missing workspace token to not_signed_in", async () => {
  setup({ kind: "not_signed_in" });
  expect(await slackApi.run(args)).toMatchObject({ ok: false, code: "not_signed_in" });
});

it("contains rejected injection errors and missing or unknown page results", async () => {
  const s = setup();
  s.executeScript.mockRejectedValueOnce(new Error("invented-private-error"));
  expect(await slackApi.run(args)).toMatchObject({ ok: false, code: "extension_error" });
  s.executeScript.mockResolvedValueOnce([]);
  expect(await slackApi.run(args)).toMatchObject({ ok: false, code: "extension_error" });
  s.executeScript.mockResolvedValueOnce([{ result: { kind: "unexpected" } as unknown as SlackApiPageResult }]);
  expect(await slackApi.run(args)).toMatchObject({ ok: false, code: "extension_error" });
  s.query.mockRejectedValueOnce(new Error("invented-private-error"));
  expect(JSON.stringify(await slackApi.run(args))).not.toContain("invented-private-error");
});

it.each([{ ok: false, error: "channel_not_found" }, { ok: false, error: "ratelimited" }])("preserves a Slack error as tool success", async body => {
  setup({ kind: "response", status: 429, retryAfter: 30, body });
  expect(await slackApi.run(args)).toEqual({ ok: true, value: { ...body, retryAfter: 30 } });
});

function pageFixture(body: unknown = { ok: true, messages: [] }, retryAfter: string | null = null) {
  const token = "invented-slack-token";
  const storage = { getItem: vi.fn(() => JSON.stringify({ teams: { TFIXTURE1: { token } } })) };
  const fetcher = vi.fn(async () => ({ status: 200, headers: new Headers(retryAfter === null ? {} : { "retry-after": retryAfter }), json: async () => body }));
  const run = new Function("localStorage", "fetch", "FormData", "location", `return (${slackApiPage.toString()});`)(storage, fetcher, FormData, { origin: "https://app.slack.com" }) as typeof slackApiPage;
  return { token, storage, fetcher, run };
}

it("serialized page function posts one same-origin form without returning the token", async () => {
  const p = pageFixture({ ok: true, messages: [{ text: "fixture" }] }, "17");
  const result = await p.run(args.teamId, "conversations.history", { channel: "CFIXTURE1", limit: 20, inclusive: true, token: "invented-override" });
  expect(p.storage.getItem).toHaveBeenCalledExactlyOnceWith("localConfig_v2");
  expect(p.fetcher).toHaveBeenCalledExactlyOnceWith("/api/conversations.history", { method: "POST", body: expect.any(FormData), credentials: "include", redirect: "error" });
  const form = (vi.mocked(p.fetcher).mock.calls[0] as unknown as [string, RequestInit])[1].body as FormData;
  expect(Object.fromEntries(form.entries())).toEqual({ channel: "CFIXTURE1", limit: "20", inclusive: "true", token: p.token });
  expect(result).toEqual({ kind: "response", status: 200, retryAfter: 17, body: { ok: true, messages: [{ text: "fixture" }] } });
  expect(JSON.stringify(result)).not.toContain(p.token);
});

it("serialized page function does not fetch when the workspace is not signed in", async () => {
  const p = pageFixture();
  expect(await p.run("TOTHER", args.method, args.params)).toEqual({ kind: "not_signed_in" });
  expect(p.fetcher).not.toHaveBeenCalled();
});

it("refuses a tab that navigated away before injection", async () => {
  const p = pageFixture();
  const run = new Function("localStorage", "fetch", "FormData", "location", `return (${slackApiPage.toString()});`)(p.storage, p.fetcher, FormData, { origin: "https://other.slack.com" }) as typeof slackApiPage;
  expect(await run(args.teamId, args.method, args.params)).toEqual({ kind: "extension_error" });
  expect(p.storage.getItem).not.toHaveBeenCalled();
  expect(p.fetcher).not.toHaveBeenCalled();
});

it("preserves an explicit zero Retry-After", async () => {
  const p = pageFixture({ ok: false, error: "ratelimited" }, "0");
  expect(await p.run(args.teamId, args.method, args.params))
    .toEqual({ kind: "response", status: 200, body: { ok: false, error: "ratelimited" }, retryAfter: 0 });
});

it.each([null, [], { ok: "yes" }, { ok: true, nested: { echo: "prefix invented-slack-token suffix" } }])("keeps invalid or credential-bearing bodies inside the page", async body => {
  const p = pageFixture(body);
  expect(await p.run(args.teamId, args.method, args.params)).toEqual({ kind: "extension_error" });
});

it("keeps fetch and JSON exceptions inside the isolated world", async () => {
  const p = pageFixture();
  p.fetcher.mockRejectedValueOnce(new Error(p.token));
  expect(await p.run(args.teamId, args.method, args.params)).toEqual({ kind: "extension_error" });
  p.storage.getItem.mockReturnValueOnce("not json");
  expect(await p.run(args.teamId, args.method, args.params)).toEqual({ kind: "extension_error" });
});

it.each([null, "invalid", "Infinity", "-1"])("omits absent or invalid Retry-After %s", async header => {
  const p = pageFixture({ ok: false, error: "channel_not_found" }, header);
  expect(await p.run(args.teamId, args.method, args.params)).toEqual({ kind: "response", status: 200, body: { ok: false, error: "channel_not_found" } });
});

it("uses the real registry, permission gate and log while sharing the Slack host grant", async () => {
  const s = setup();
  const data: Record<string, unknown> = {};
  const storage = { get: async () => structuredClone(data), set: async (value: Record<string, unknown>) => { Object.assign(data, value); } };
  const state = new ProfileState(storage);
  const log = new RequestLog(storage);
  const permissions = { contains: vi.fn(async () => true), request: vi.fn(async () => true), remove: vi.fn(async () => true) };
  const action = { setBadgeText: vi.fn(async () => {}) };
  const dispatch = createDispatcher(state, log, tools, permissions, action, "0.1.0");
  const described = await dispatch({ id: "describe", op: "describe", protocolVersion });
  expect(described.ok).toBe(true);
  if (!described.ok)
    throw new Error("Describe failed.");
  expect(described.profile.tools.find(tool => tool.id === slackApi.id)).toEqual({ id: slackApi.id, section: "appdata", group: "slack",
    title: "Slack: read workspace data (read-only)", hosts: ["https://*.slack.com/*"], sensitive: false, enabled: false });
  const request = { id: "call", op: "call" as const, protocolVersion, tool: slackApi.id, caller: "fixture", args };
  expect(await dispatch(request)).toMatchObject({ code: "access_off" });
  await state.setAgentAccess(true);
  expect(await dispatch(request)).toMatchObject({ code: "tool_denied" });
  const grants = new Grants(state, described.profile.tools, permissions);
  await grants.setEnabled("appdata.slack.cookies", true);
  await grants.setEnabled(slackApi.id, true);
  await grants.setEnabled("appdata.slack.cookies", false);
  expect(permissions.remove).not.toHaveBeenCalled();
  permissions.contains.mockResolvedValueOnce(false);
  expect(await dispatch(request)).toMatchObject({ code: "permission_missing" });
  expect(s.query).not.toHaveBeenCalled();
  expect(await dispatch(request)).toMatchObject({ ok: true, value: { ok: true } });
  s.query.mockResolvedValueOnce([]);
  expect(await dispatch(request)).toMatchObject({ code: "tab_missing" });
  expect(action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
  expect((await log.read()).map(row => row.outcome)).toEqual(["access_off", "tool_denied", "permission_missing", "ok", "tab_missing"]);
  expect(JSON.stringify(await log.read())).not.toContain("fixture-channel");
});
