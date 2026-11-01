import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDispatcher } from "../src/dispatcher.ts";
import { debugAccessMessage } from "../src/debugAccessMessages.ts";
import { mountDebugAccess } from "../src/debugAccessPanel.ts";
import { ProfileState } from "../src/profileState.ts";
import { RequestLog } from "../src/requestLog.ts";
import { DebugAccess, debugAccess } from "../src/tools/debug/debugAccess.ts";
import { debugChrome, debugRequestAccess, debugTools } from "../src/tools/debug/debugTools.ts";
import { protocolVersion } from "../../shared/protocol.ts";

let data: Record<string, unknown>;
let badge: string;
const tabs = [{ id: 7, url: "https://meet.google.com/abc-defg-hij", title: "Meet" }];
beforeEach(() => {
  data = { instanceId: "00000000-0000-4000-8000-000000000000", agentAccess: true, enabledTools: debugTools.map(tool => tool.id) };
  badge = "";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-01T16:00:00Z"));
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn(async () => structuredClone(data)), set: vi.fn(async values => { Object.assign(data, structuredClone(values)); }) } },
    cookies: { getAll: vi.fn(async () => [{ name: "secret" }]) },
    permissions: { contains: vi.fn(async () => true) },
    action: { setBadgeText: vi.fn(async ({ text }) => { badge = text; }), getBadgeText: vi.fn(async () => badge), openPopup: vi.fn(async () => {}) },
    runtime: { getURL: (path: string) => `chrome-extension://fixture/${path}`, id: "fixture" },
    tabs: { query: vi.fn(async () => tabs), create: vi.fn(), update: vi.fn() },
    windows: { getAll: vi.fn(async () => { throw new Error("No windows."); }) },
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const request = (reason = "Find why the Meet tab is missing", retry?: boolean) =>
  debugRequestAccess.run(retry === undefined ? { reason } : { reason, retry }, [], { caller: "claude" });
async function approve(minutes: number) {
  const status = (await request()).ok && (await debugAccess.read()).request;
  await debugAccessMessage({ action: "approve", id: (status as { id: string }).id, minutes });
}

it.each([[undefined], [{}], [{ reason: " " }], [{ reason: "x".repeat(501) }], [{ reason: "ok", extra: 1 }], [{ reason: "ok", retry: "yes" }]])("refuses request args %j", async args => {
  expect(await debugRequestAccess.run(args, [], { caller: "claude" })).toMatchObject({ ok: false, code: "tool_args_invalid" });
});

it("creates one pending request with its reason, opens the approval UI once and marks the badge", async () => {
  const first = await request();
  expect(first).toMatchObject({ ok: true, value: { status: "pending_approval", expiresAt: Date.now() + 600_000 } });
  expect(await request("Another reason")).toEqual(first);
  expect(chrome.action.openPopup).toHaveBeenCalledTimes(1);
  expect((await debugAccess.read()).request).toMatchObject({ caller: "claude", reason: "Find why the Meet tab is missing" });
  expect(badge).toBe("D");
});

it("never replaces another badge with the debug mark", async () => {
  badge = "?";
  await request();
  expect(badge).toBe("?");
  await new DebugAccess().badge({ request: null, grant: null });
  expect(badge).toBe("?");
});

it("refuses debug calls before approval, after denial and after the approved time", async () => {
  expect(await debugChrome.checkAccess!({ api: "tabs.query" })).toMatchObject({ ok: false, code: "permission_missing" });
  await request();
  const { id } = (await debugAccess.read()).request!;
  await debugAccessMessage({ action: "deny", id });
  expect(await debugChrome.checkAccess!({})).toMatchObject({ code: "permission_missing" });
  expect(await request()).toMatchObject({ value: { status: "denied" } });
  expect(await request(undefined, true)).toMatchObject({ value: { status: "pending_approval" } });
  await debugAccessMessage({ action: "approve", id: (await debugAccess.read()).request!.id, minutes: 10 });
  expect(badge).toBe("");
  expect(await debugChrome.checkAccess!({})).toBeUndefined();
  vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
  expect(await debugChrome.checkAccess!({})).toMatchObject({ code: "permission_missing" });
  expect(await request()).toMatchObject({ value: { status: "pending_approval" } });
});

it("approves only 10 or 60 minutes of a current request, and stop ends access at once", async () => {
  await request();
  const { id } = (await debugAccess.read()).request!;
  await expect(debugAccessMessage({ action: "approve", id, minutes: 5 })).rejects.toThrow("10 minutes or 1 hour");
  await expect(debugAccessMessage({ action: "approve", id: "other", minutes: 10 })).rejects.toThrow("expired");
  expect(await debugAccessMessage({ action: "approve", id, minutes: 60 })).toMatchObject({ request: null, grant: { caller: "claude", until: Date.now() + 3_600_000 } });
  expect(await request()).toMatchObject({ value: { status: "approved", until: Date.now() + 3_600_000 } });
  expect(await debugAccessMessage({ action: "revoke" })).toMatchObject({ grant: null });
  expect(await debugChrome.checkAccess!({})).toMatchObject({ code: "permission_missing" });
});

it("expires an unanswered request after ten minutes", async () => {
  await request();
  vi.setSystemTime(Date.now() + 600_000);
  expect(await request()).toMatchObject({ value: { status: "expired" } });
  await expect(debugAccessMessage({ action: "approve", id: (await debugAccess.read()).request!.id, minutes: 10 })).rejects.toThrow("expired");
});

it("calls a chrome API with JSON arguments and returns its JSON result", async () => {
  await approve(10);
  expect(await debugChrome.run({ api: "tabs.query", args: [{ url: ["https://meet.google.com/*"] }] }))
    .toEqual({ ok: true, value: { api: "tabs.query", result: tabs } });
  expect(chrome.tabs.query).toHaveBeenCalledWith({ url: ["https://meet.google.com/*"] });
  expect(await debugChrome.run({ api: "windows.getAll" })).toMatchObject({ ok: false, code: "tool_args_invalid", message: "chrome.windows.getAll failed: No windows." });
});

it.each([[{}], [{ api: "tabs" }], [{ api: "tabs.query()" }], [{ api: "tabs.query", args: {} }], [{ api: "tabs.query", args: Array(11).fill(0) }],
  [{ api: "tabs.query", extra: 1 }], [{ api: "cookies.getAll" }], [{ api: "storage.local.set", args: [{ debugAccess: {} }] }], [{ api: "tabs.missing" }], [{ api: "nothing.here" }]])("refuses debug call %j", async args => {
  expect(await debugChrome.run(args)).toMatchObject({ ok: false, code: "tool_args_invalid" });
  expect(chrome.cookies.getAll).not.toHaveBeenCalled();
  expect(chrome.storage.local.set).not.toHaveBeenCalled();
});

it("refuses debug calls through the dispatcher until the user approves", async () => {
  const dispatch = createDispatcher(new ProfileState(chrome.storage.local), new RequestLog(chrome.storage.local), debugTools, chrome.permissions, chrome.action, "0.2.0");
  const call = () => dispatch({ id: "1", protocolVersion, op: "call", tool: "debug.chrome", caller: "claude", args: { api: "tabs.query", args: [{}] } });
  expect(await call()).toMatchObject({ ok: false, code: "permission_missing" });
  await approve(10);
  expect(await call()).toMatchObject({ ok: true, value: { result: tabs } });
});

it("shows the reason with time-limited approval buttons, then the active grant with Stop now", async () => {
  const dom = new JSDOM(`<nav><button data-tab="group-debug-console"></button></nav><div id="panel"></div><p id="message"></p>`);
  const send = vi.fn(async (message: Record<string, unknown>) => debugAccessMessage(message));
  const runtime = { sendMessage: send } as unknown as typeof chrome.runtime;
  const selected = vi.fn();
  dom.window.document.querySelector("button")!.addEventListener("click", selected);
  await request();
  const panel = dom.window.document.getElementById("panel")!;
  await mountDebugAccess(dom.window.document, panel, runtime);
  expect(panel.textContent).toContain("claude wants to debug this extension");
  expect(panel.textContent).toContain("Reason: Find why the Meet tab is missing");
  expect(selected).toHaveBeenCalled();
  const buttons = [...panel.querySelectorAll("button")].map(button => button.textContent);
  expect(buttons).toEqual(["Approve for 10 minutes", "Approve for 1 hour", "Deny"]);
  panel.querySelector("button")!.click();
  await vi.waitFor(() => expect(panel.textContent).toContain("Debug access is on until"));
  expect(send).toHaveBeenCalledWith(expect.objectContaining({ op: "debug-access", action: "approve", minutes: 10 }));
  panel.querySelector("button")!.click();
  await vi.waitFor(() => expect(panel.textContent).toContain("Debug access is off."));
  dom.window.close();
});
