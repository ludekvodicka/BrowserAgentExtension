import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import { outlookMail, outlookMailPath } from "../src/tools/appdata/outlook/outlookMail.ts";
import { outlookMailPage } from "../src/tools/appdata/outlook/outlookMailPage.ts";
import type { OutlookMailPageResult } from "../src/tools/appdata/outlook/outlookMailPage.ts";

afterEach(() => vi.unstubAllGlobals());
const list = { method: "messages.list", params: { folder: "inbox", since: "2026-10-28T08:00:00Z", top: 10, unreadOnly: true } };

function setup(...results: OutlookMailPageResult[]) {
  const query = vi.fn(async () => [{ id: 7 }]);
  const executeScript = vi.fn(async () => [{ result: results.shift() ?? { kind: "response", status: 200, body: { value: [] } } }]);
  vi.stubGlobal("chrome", { tabs: { query }, scripting: { executeScript } });
  return { query, executeScript };
}

it("builds only read paths with an encoded id, a filter and the selected fields", () => {
  expect(outlookMailPath("folders.list", {})).toMatch(/^\/api\/v2\.0\/me\/mailfolders\?\$top=100&\$select=/);
  expect(outlookMailPath("folders.list", { parent: "AAMk=" })).toMatch(/^\/api\/v2\.0\/me\/mailfolders\/AAMk%3D\/childfolders\?/);
  const path = outlookMailPath(list.method, list.params)!;
  expect(path).toMatch(/^\/api\/v2\.0\/me\/mailfolders\/inbox\/messages\?\$top=10&\$orderby=/);
  expect(decodeURIComponent(path)).toContain("$filter=ReceivedDateTime ge 2026-10-28T08:00:00.000Z and IsRead eq false");
  expect(outlookMailPath("messages.get", { id: "AAMk-_1=" })).toMatch(/^\/api\/v2\.0\/me\/messages\/AAMk-_1%3D\?\$select=.*Body/);
});

it.each([["messages.send", {}], ["messages.list", {}], ["messages.list", { folder: "inbox/../x" }], ["messages.list", { folder: "inbox", top: 101 }],
  ["messages.list", { folder: "inbox", top: 1.5 }], ["messages.list", { folder: "inbox", since: "not a date" }], ["messages.list", { folder: "inbox", since: 5 }],
  ["messages.list", { folder: "inbox", unreadOnly: "yes" }], ["messages.get", { id: "a/b" }], ["messages.get", {}], ["folders.list", { parent: "../" }]])(
  "refuses %s %j before touching a tab", async (method, params) => {
  const s = setup();
  expect(await outlookMail.run({ method, params })).toMatchObject({ ok: false, code: "tool_args_invalid" });
  expect(s.query).not.toHaveBeenCalled();
});

it("reads through the first Outlook tab in the main world and returns status and body", async () => {
  const s = setup({ kind: "response", status: 200, body: { value: [{ Subject: "fixture" }] } });
  expect(await outlookMail.run(list)).toEqual({ ok: true, value: { status: 200, body: { value: [{ Subject: "fixture" }] } } });
  expect(s.query).toHaveBeenCalledExactlyOnceWith({ url: "https://outlook.cloud.microsoft/*", discarded: false });
  expect(s.executeScript).toHaveBeenCalledExactlyOnceWith({ target: { tabId: 7 }, world: "MAIN", func: outlookMailPage,
    args: [outlookMailPath(list.method, list.params)] });
});

it("asks for an open Outlook tab without opening one", async () => {
  const s = setup();
  s.query.mockResolvedValue([]);
  expect(await outlookMail.run(list)).toMatchObject({ ok: false, code: "tab_missing", message: expect.stringContaining("outlook.cloud.microsoft") });
  expect(s.executeScript).not.toHaveBeenCalled();
});

it("injects the hook into a tab opened before the tool and reports it not ready", async () => {
  const s = setup({ kind: "hook_missing" });
  expect(await outlookMail.run(list)).toMatchObject({ ok: false, code: "tab_not_ready" });
  expect(s.executeScript).toHaveBeenLastCalledWith({ target: { tabId: 7 }, world: "MAIN", files: ["hooks/outlookHook.js"] });
  setup({ kind: "not_ready" });
  expect(await outlookMail.run(list)).toMatchObject({ ok: false, code: "tab_not_ready" });
});

it("contains injection failures and unknown page results", async () => {
  const s = setup({ kind: "extension_error" });
  expect(await outlookMail.run(list)).toMatchObject({ ok: false, code: "extension_error" });
  s.executeScript.mockRejectedValueOnce(new Error("invented-private-error"));
  expect(JSON.stringify(await outlookMail.run(list))).not.toContain("invented-private-error");
  s.executeScript.mockResolvedValueOnce([{ result: { kind: "unexpected" } as unknown as OutlookMailPageResult }]);
  expect(await outlookMail.run(list)).toMatchObject({ ok: false, code: "extension_error" });
});

const authorization = "Bearer invented.outlook-token.signature";
function page(hook: unknown, response: { status: number; text: string } = { status: 200, text: '{"value":[]}' }, origin = "https://outlook.cloud.microsoft") {
  const fetcher = vi.fn(async () => ({ status: response.status, text: async () => response.text }));
  const scope = hook === undefined ? {} : { [Symbol.for("browserAgent.outlook")]: hook };
  const run = new Function("window", "fetch", "location", `return (${outlookMailPage.toString()});`)(scope, fetcher, { origin }) as typeof outlookMailPage;
  return { fetcher, run };
}
const path = "/api/v2.0/me/messages/AAMk?$select=Id";

it("serialized page function sends one GET with the captured authorization and returns no credential", async () => {
  const p = page({ authorization: () => authorization });
  const result = await p.run(path);
  expect(result).toEqual({ kind: "response", status: 200, body: { value: [] } });
  expect(p.fetcher).toHaveBeenCalledExactlyOnceWith(path, { method: "GET", redirect: "error",
    headers: { Authorization: authorization, Prefer: 'outlook.body-content-type="text"' } });
  expect(JSON.stringify(result)).not.toContain("invented");
});

it("serialized page function refuses foreign origins and paths, a missing hook or token, an expired token and an echo", async () => {
  expect(await page({ authorization: () => authorization }, undefined, "https://evil.example").run(path)).toEqual({ kind: "extension_error" });
  expect(await page({ authorization: () => authorization }).run("/api/v2.0/me/sendmail")).toEqual({ kind: "extension_error" });
  expect(await page(undefined).run(path)).toEqual({ kind: "hook_missing" });
  expect(await page({ authorization: () => null }).run(path)).toEqual({ kind: "not_ready" });
  expect(await page({ authorization: () => authorization }, { status: 401, text: "" }).run(path)).toEqual({ kind: "not_ready" });
  expect(await page({ authorization: () => authorization }, { status: 200, text: `{"x":"${authorization.slice(7)}"}` }).run(path)).toEqual({ kind: "extension_error" });
});

function jwt(aud: string) {
  return `Bearer h.${Buffer.from(JSON.stringify({ aud })).toString("base64url")}.s`;
}

it("hook remembers only the Outlook API authorization from fetch and XHR and keeps page calls working", async () => {
  const dom = new JSDOM("", { runScripts: "outside-only", url: "https://outlook.cloud.microsoft/mail/" });
  const pageFetch = vi.fn(async () => "page-response");
  Object.assign(dom.window, { fetch: pageFetch, Headers });
  const code = transformSync(readFileSync(new URL("../src/tools/appdata/outlook/outlookHook.ts", import.meta.url), "utf8"), { loader: "ts" }).code;
  dom.window.eval(code);
  dom.window.eval(code);
  const hook = (dom.window as unknown as Record<symbol, { authorization(): string | null }>)[Symbol.for("browserAgent.outlook")];
  expect(hook.authorization()).toBeNull();
  expect(await dom.window.fetch("/x", { headers: { Authorization: jwt("https://graph.microsoft.com") } })).toBe("page-response");
  expect(hook.authorization()).toBeNull();
  await dom.window.fetch("/x", { headers: { Authorization: jwt("https://outlook.office.com") } });
  expect(hook.authorization()).toBe(jwt("https://outlook.office.com"));
  expect(pageFetch).toHaveBeenCalledTimes(2);
  const xhr = new dom.window.XMLHttpRequest();
  xhr.open("GET", "/y");
  xhr.setRequestHeader("authorization", jwt("https://outlook.office.com") + "x");
  expect(hook.authorization()).toBe(jwt("https://outlook.office.com") + "x");
  dom.window.close();
});
