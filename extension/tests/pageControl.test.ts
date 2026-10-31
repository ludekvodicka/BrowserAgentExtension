import { JSDOM } from "jsdom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDispatcher } from "../src/dispatcher.ts";
import { ProfileState } from "../src/profileState.ts";
import { RequestLog } from "../src/requestLog.ts";
import { pageDocument } from "../src/tools/page/pageDocument.ts";
import type { PageCommand, PageDocumentResult } from "../src/tools/page/pageDocument.ts";
import { pageTools } from "../src/tools/page/pageTools.ts";
import { hostPattern, openApproval, SiteAccess, webOrigin } from "../src/tools/page/siteAccess.ts";
import { mountSiteAccess } from "../src/siteAccessPanel.ts";
import { siteAccessMessage } from "../src/siteAccessMessages.ts";
import { protocolVersion } from "../../shared/protocol.ts";

const windows: JSDOM[] = [];
function page(html: string, url = "https://support.example/ticket") {
  const dom = new JSDOM(html, { url, runScripts: "outside-only", pretendToBeVisual: true });
  windows.push(dom);
  const win = dom.window;
  Object.defineProperty(win.Element.prototype, "getClientRects", { value() { return [ { width: 10, height: 10 } ]; } });
  Object.defineProperty(win.HTMLElement.prototype, "isContentEditable", { get() { return this.getAttribute("contenteditable") === "true"; } });
  win.HTMLElement.prototype.scrollIntoView = vi.fn();
  win.HTMLElement.prototype.scrollBy = vi.fn();
  win.scrollBy = vi.fn();
  win.PointerEvent = win.MouseEvent as unknown as typeof win.PointerEvent;
  win.document.execCommand = vi.fn((_command, _show, value) => {
    const selection = win.getSelection()!;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(win.document.createTextNode(value ?? ""));
    return true;
  });
  const execute = win.eval(`(${pageDocument.toString()})`) as (command: PageCommand) => PageDocumentResult;
  return { dom, document: win.document, execute };
}
const command = (overrides: Partial<PageCommand> = {}): PageCommand => ({ operation: "snapshot", origins: ["https://support.example"], generation: "one", limit: 100, ...overrides });

let data: Record<string, unknown>;
let permitted: Set<string>;
let badge: string;
beforeEach(() => {
  data = { instanceId: "00000000-0000-4000-8000-000000000000", agentAccess: true, enabledTools: pageTools.map(tool => tool.id) };
  permitted = new Set();
  badge = "";
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn(async () => structuredClone(data)), set: vi.fn(async values => { Object.assign(data, structuredClone(values)); }) } },
    permissions: { contains: vi.fn(async ({ origins }) => origins.every((origin: string) => permitted.has(origin))),
      request: vi.fn(async ({ origins }) => { origins.forEach((origin: string) => permitted.add(origin)); return true; }) },
    action: { setBadgeText: vi.fn(async ({ text }) => { badge = text; }), getBadgeText: vi.fn(async () => badge), openPopup: vi.fn(async () => {}) },
    runtime: { getURL: (path: string) => `chrome-extension://fixture/${path}` },
    tabs: { get: vi.fn(async () => ({ id: 7, windowId: 1, url: "https://support.example/ticket", title: "Ticket", active: true, status: "complete" })),
      query: vi.fn(async () => []), create: vi.fn(async () => ({ id: 8 })), update: vi.fn(async () => ({})) },
    scripting: { executeScript: vi.fn() },
  });
});
afterEach(() => { windows.splice(0).forEach(dom => dom.window.close()); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("normalizes exact origins including IDNs and ports, but rejects credentials and non-web schemes", () => {
  expect(webOrigin("https://bücher.example:8443/path?q=1")).toBe("https://xn--bcher-kva.example:8443");
  expect(hostPattern("https://support.example:8443")).toBe("https://support.example/*");
  for (const input of ["javascript:alert(1)", "file:///tmp/x", "https://user:pass@example.test", "bad"])
    expect(webOrigin(input)).toBeNull();
});

it("keeps one pending request per origin, records caller, denies and expires after ten minutes", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  const access = new SiteAccess();
  const [first, duplicate] = await Promise.all([access.request("https://support.example", "first", false), access.request("https://support.example", "second", false)]);
  expect(first).toEqual(duplicate);
  expect(first).toMatchObject({ status: "pending_approval", caller: "first", expiresAt: Date.now() + 600_000 });
  expect(await access.read()).toHaveLength(1);
  expect(badge).toBe("?");
  await access.deny(first.origin, first.id);
  expect(await access.request(first.origin, "again", false)).toMatchObject({ status: "denied" });
  expect(badge).toBe("");
  const next = await access.request(first.origin, "again", true);
  expect(next.id).not.toBe(first.id);
  vi.advanceTimersByTime(600_000);
  expect(await access.read()).toMatchObject([{ status: "expired" }]);
  await expect(access.beginApproval(first.origin, next.id)).rejects.toThrow("expired");
  await access.badge();
  expect(badge).toBe("");
});

it("browser host permission alone is not an approval; revocation and ports are checked separately", async () => {
  const access = new SiteAccess();
  const origin = "https://support.example:8443";
  permitted.add(hostPattern(origin));
  await access.request(origin, "agent", false);
  await access.completeApprovals();
  expect(await access.check(origin)).toMatchObject({ code: "permission_missing" });
  const site = (await access.read())[0];
  await access.beginApproval(origin, site.id);
  expect(await access.check(origin)).toBeUndefined();
  expect(await access.check("https://support.example")).toMatchObject({ code: "permission_missing" });
  permitted.clear();
  expect(await access.check(origin)).toMatchObject({ code: "permission_missing", message: expect.stringContaining("Browser permission") });
  permitted.add(hostPattern(origin));
  await access.remove(origin);
  expect(await access.check(origin)).toMatchObject({ code: "permission_missing" });
});

it("opens the fallback approval page when openPopup is unavailable", async () => {
  vi.mocked(chrome.action.openPopup).mockRejectedValue(new Error("Unavailable"));
  await openApproval();
  expect(chrome.tabs.create).toHaveBeenCalledWith({ url: "chrome-extension://fixture/approval.html", active: true });
});

it("requestAccess returns immediately with caller and polling reports denial without requesting permission", async () => {
  const request = pageTools.find(tool => tool.id === "page.requestAccess")!;
  const status = pageTools.find(tool => tool.id === "page.accessStatus")!;
  const args = { url: "https://support.example/ticket" };
  const result = await request.run(args, [], { caller: "test-agent" });
  expect(result).toMatchObject({ ok: true, value: { status: "pending_approval", caller: "test-agent", origin: "https://support.example" } });
  expect(chrome.permissions.request).not.toHaveBeenCalled();
  const access = new SiteAccess();
  const site = (await access.read())[0];
  await access.deny(site.origin, site.id);
  expect(await status.run(args)).toMatchObject({ ok: true, value: { status: "denied" } });
  expect(await request.run({ ...args, approve: true })).toMatchObject({ code: "tool_args_invalid" });
});

it("screenshots require an active, granted tab and are sensitive, bounded, and discarded after a tab switch", async () => {
  const access = new SiteAccess();
  permitted.add("https://support.example/*");
  await access.beginApproval("https://support.example", null);
  const tool = pageTools.find(tool => tool.id === "page.screenshot")!;
  expect(tool.sensitive).toBe(true);
  const tab = await chrome.tabs.get(7);
  const query = vi.fn(async () => [tab]);
  chrome.tabs.query = query;
  const capture = vi.fn(async () => "data:image/jpeg;base64,fixture");
  chrome.tabs.captureVisibleTab = capture;
  expect(await tool.run({ tabId: 7 })).toMatchObject({ ok: true, value: { status: "captured", mimeType: "image/jpeg" } });
  capture.mockResolvedValueOnce("x".repeat(800_001));
  expect(await tool.run({ tabId: 7 })).toMatchObject({ code: "result_too_large" });
  query.mockResolvedValueOnce([tab]).mockResolvedValueOnce([{ ...tab, id: 8 }]);
  expect(await tool.run({ tabId: 7 })).toMatchObject({ code: "tab_not_ready" });
  query.mockResolvedValueOnce([{ ...tab, id: 8 }]);
  expect(await tool.run({ tabId: 7 })).toMatchObject({ code: "tab_not_ready" });
  await access.remove("https://support.example");
  expect(await tool.run({ tabId: 7 })).toMatchObject({ code: "permission_missing" });
});

it("Approve requests permission synchronously in the click handler, then stores the grant", async () => {
  const access = new SiteAccess();
  const site = await access.request("https://support.example", "agent", false);
  const { document, dom } = page('<div id="panel"></div><p id="message"></p>');
  const runtime = { sendMessage: vi.fn(siteAccessMessage) } as unknown as Pick<typeof chrome.runtime, "sendMessage">;
  await mountSiteAccess(document, document.getElementById("panel")!, runtime, chrome.permissions);
  expect(document.getElementById("panel")!.textContent).toContain(site.origin);
  [...document.querySelectorAll("button")].find(button => button.textContent === "Approve")!.click();
  expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ["https://support.example/*"] });
  await vi.waitFor(async () => expect(await access.check(site.origin)).toBeUndefined());
  expect((await access.read())[0].status).toBe("approved");
  dom.window.dispatchEvent(new dom.window.Event("pagehide"));
});

it("snapshots visible controls with names, values, states and open shadow roots, with bounded results", () => {
  const p = page('<label for="body">Reply</label><textarea id="body">draft</textarea><input type="checkbox" aria-label="Notify" checked><input type="password" value="fixture"><button hidden>Hidden</button><div id="shadow"></div>');
  p.document.getElementById("shadow")!.attachShadow({ mode: "open" }).innerHTML = '<button aria-label="Comment">+</button>';
  const result = p.execute(command());
  expect(result).toMatchObject({ ok: true, elements: [
    { ref: "e1", role: "textbox", name: "Reply", value: "draft" },
    { ref: "e2", role: "checkbox", name: "Notify", checked: true },
    { ref: "e3", value: "[redacted]" }, { ref: "e4", role: "button", name: "Comment" },
  ] });
  expect(p.execute(command({ limit: 1 }))).toMatchObject({ ok: true, elements: [expect.any(Object)], truncated: true });
});

it("refuses stale or detached refs, ambiguous locators, hidden elements and ungranted frames", () => {
  const p = page('<button>Comment</button><button>Comment</button>');
  p.execute(command());
  p.execute(command({ generation: "two" }));
  expect(p.execute(command({ operation: "act", locator: { ref: "e1" }, action: "click" }))).toMatchObject({ code: "tab_not_ready", message: expect.stringContaining("Stale") });
  expect(p.execute(command({ operation: "act", locator: { role: "button", name: "Comment" }, action: "click" }))).toMatchObject({ code: "tab_not_ready", message: expect.stringContaining("2") });
  p.document.querySelector("button")!.remove();
  expect(p.execute(command({ operation: "act", generation: "two", locator: { ref: "e1" }, action: "click" }))).toMatchObject({ code: "tab_not_ready" });
  expect(p.execute(command({ origins: ["https://different.example"] }))).toMatchObject({ code: "permission_missing" });
});

it.each(['<button type="submit">comment</button>', '<button>comment</button>', '<input type="submit" value="comment">'])
  ("clicks control buttons of submit type, such as a comment toggle that the page handles itself: %s", html => {
    const p = page(`<form>${html}</form><textarea hidden></textarea>`);
    p.document.querySelector("button,input")!.addEventListener("click", event => {
      event.preventDefault();
      p.document.querySelector("textarea")!.hidden = false;
    });
    expect(p.execute(command({ operation: "act", action: "click", locator: { selector: "button,input" } }))).toMatchObject({ ok: true, status: "acted" });
    expect(p.document.querySelector("textarea")!.hidden).toBe(false);
  });

it("has no submit action: the agent clicks controls and leaves the final send to the user", async () => {
  const act = pageTools.find(tool => tool.id === "page.act")!;
  expect(await act.run({ tabId: 7, action: "submit", selector: "form" })).toMatchObject({ code: "tool_args_invalid" });
});

it("fills native fields and rich text, selects options, checks boxes, types and dispatches pointer/key events", () => {
  const p = page('<input aria-label="Title"><textarea></textarea><div contenteditable="true">old</div><select><option value="a">A</option><option value="b">B</option></select><input type="checkbox">');
  const input = p.document.querySelector("input")!;
  const changed = vi.fn();
  input.addEventListener("input", changed);
  const act = (selector: string, action: PageCommand["action"], rest: Partial<PageCommand> = {}) => p.execute(command({ operation: "act", locator: { selector }, action, ...rest }));
  expect(act("input[aria-label]", "fill", { text: "draft" })).toMatchObject({ ok: true });
  expect(input.value).toBe("draft");
  expect(changed).toHaveBeenCalledOnce();
  expect(act("textarea", "fill", { text: "body" })).toMatchObject({ ok: true });
  expect(act("textarea", "type", { text: "!" })).toMatchObject({ ok: true });
  expect(p.document.querySelector("textarea")!.value).toBe("body!");
  expect(act("div", "fill", { text: "new" })).toMatchObject({ ok: true });
  expect(p.document.querySelector("div")!.textContent).toBe("new");
  expect(act("select", "select", { values: ["b"] })).toMatchObject({ ok: true });
  expect(p.document.querySelector("select")!.value).toBe("b");
  expect(act("input[type=checkbox]", "check", { checked: true })).toMatchObject({ ok: true });
  expect(p.document.querySelector<HTMLInputElement>("input[type=checkbox]")!.checked).toBe(true);
  expect(act("textarea", "press", { key: "Enter" })).toMatchObject({ ok: true });
  expect(p.document.querySelector("textarea")!.value).toBe("body!\n");
  const hover = vi.fn();
  input.addEventListener("mouseover", hover);
  expect(act("input[aria-label]", "hover")).toMatchObject({ ok: true });
  expect(hover).toHaveBeenCalledOnce();
  expect(p.execute(command({ operation: "act", action: "scroll", y: 200 }))).toMatchObject({ ok: true });
  expect(p.dom.window.scrollBy).toHaveBeenCalledWith({ left: 0, top: 200, behavior: "instant" });
});

it("reads bounded text and sanitized HTML without script or hidden-field content", () => {
  const p = page('<main>Ticket <b>status</b><span hidden>hidden</span><script>untrusted_code()</script><input type="hidden" value="hidden-data"></main>');
  expect(p.execute(command({ operation: "read", format: "text", limit: 6 }))).toMatchObject({ ok: true, content: "Ticket", truncated: true });
  const html = p.execute(command({ operation: "read", format: "html", limit: 1000 }));
  expect(html).toMatchObject({ ok: true });
  if (html.ok)
    expect(html.content).not.toMatch(/untrusted_code|hidden-data|<script/);
});

it("preserves the caret for repeated middle-of-field insertion and deletion", () => {
  const p = page('<textarea>abcde</textarea>');
  const field = p.document.querySelector("textarea")!;
  field.setSelectionRange(2, 2);
  const press = () => p.execute(command({ operation: "act", action: "press", key: "Backspace", locator: { selector: "textarea" } }));
  press();
  press();
  expect(field.value).toBe("cde");
  field.setSelectionRange(1, 1);
  p.execute(command({ operation: "act", action: "type", text: "X", locator: { selector: "textarea" } }));
  p.execute(command({ operation: "act", action: "type", text: "Y", locator: { selector: "textarea" } }));
  expect(field.value).toBe("cXYde");
});

it("flags incomplete DOM scans and refuses locators whose uniqueness cannot be proved", () => {
  const p = page('<button>Action</button>' + '<i></i>'.repeat(10_001) + '<button>Action</button>');
  expect(p.execute(command())).toMatchObject({ ok: true, truncated: true });
  expect(p.execute(command({ operation: "act", action: "click", locator: { role: "button", name: "Action" } })))
    .toMatchObject({ code: "tab_not_ready" });
});

it("uses inherited document origins for blank editor frames while refusing opaque origins", () => {
  const p = page('<iframe></iframe>');
  const frame = p.document.querySelector("iframe")!.contentWindow! as unknown as JSDOM["window"];
  frame.document.body.innerHTML = '<textarea aria-label="Editor"></textarea>';
  Object.defineProperty(frame.Element.prototype, "getClientRects", { value() { return [{ width: 10, height: 10 }]; } });
  const execute = frame.eval(`(${pageDocument.toString()})`) as typeof pageDocument;
  expect(frame.location.origin).toBe("null");
  expect(frame.origin).toBe("https://support.example");
  expect(execute(command())).toMatchObject({ ok: true, origin: "https://support.example", elements: [{ name: "Editor" }] });
  Object.defineProperty(frame, "origin", { value: "null" });
  expect(execute(command())).toMatchObject({ code: "permission_missing" });
});

it("lets the user remove terminal requests at capacity and gives an actionable refusal", async () => {
  data.pageSites = Array.from({ length: 100 }, (_, index) => ({ origin: `https://site${index}.example`, id: String(index), caller: "agent",
    requestedAt: 0, expiresAt: 0, status: index % 2 ? "denied" : "expired" }));
  const tool = pageTools.find(tool => tool.id === "page.requestAccess")!;
  expect(await tool.run({ url: "https://new.example" })).toMatchObject({ code: "tool_denied", message: expect.stringContaining("Remove") });
  const p = page('<div id="panel"></div><p id="message"></p>');
  const runtime = { sendMessage: vi.fn(siteAccessMessage) } as unknown as Pick<typeof chrome.runtime, "sendMessage">;
  await mountSiteAccess(p.document, p.document.getElementById("panel")!, runtime, chrome.permissions);
  const remove = [...p.document.querySelectorAll("button")].find(button => button.textContent === "Remove");
  expect(remove).toBeDefined();
  remove!.click();
  await vi.waitFor(() => expect(data.pageSites).toHaveLength(99));
  expect(await tool.run({ url: "https://new.example" })).toMatchObject({ ok: true, value: { status: "pending_approval" } });
});

it("dispatches the real registry tools through site gates and frame-bound refs, logging metadata only", async () => {
  const p = page('<button type="button">Comment</button><textarea></textarea>');
  const child = page('<button type="button">Frame action</button>', "https://frame.example/editor");
  const access = new SiteAccess();
  const storage = chrome.storage.local;
  const log = new RequestLog(storage);
  const dispatch = createDispatcher(new ProfileState(storage), log, pageTools, chrome.permissions, chrome.action, "0.2.0");
  const call = (tool: string, args: unknown) => dispatch({ id: "test", protocolVersion, op: "call", caller: "tester", tool, args });
  expect(await call("page.snapshot", { tabId: 7 })).toMatchObject({ code: "permission_missing" });
  expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
  for (const origin of ["https://support.example", "https://frame.example"]) {
    permitted.add(hostPattern(origin));
    await access.beginApproval(origin, null);
  }
  vi.mocked(chrome.scripting.executeScript).mockImplementation((async (injection: { func: Function; args: unknown[]; target: { allFrames?: boolean; documentIds?: string[] } }) => {
    const frames = injection.target.allFrames ? [0, 1] : [injection.target.documentIds?.[0] === "doc1" ? 1 : 0];
    return frames.map(frameId => {
      const frame = frameId === 0 ? p : child;
      return { frameId, documentId: `doc${frameId}`, result: (frame.execute as Function)(...injection.args) };
    });
  }) as typeof chrome.scripting.executeScript);
  const snapshot = await call("page.snapshot", { tabId: 7, limit: 10 });
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok || !("value" in snapshot))
    throw new Error("Missing snapshot");
  const value = snapshot.value as { elements: { ref: string; name: string }[] };
  expect(value.elements.map(element => element.name)).toEqual(["Comment", "", "Frame action"]);
  expect(await call("page.act", { tabId: 7, ref: value.elements[1].ref, action: "fill", text: "Private draft" })).toMatchObject({ ok: true });
  expect(p.document.querySelector("textarea")!.value).toBe("Private draft");
  expect(await call("page.act", { tabId: 7, ref: value.elements[2].ref, action: "click" })).toMatchObject({ ok: true });
  await call("page.snapshot", { tabId: 7 });
  expect(await call("page.act", { tabId: 7, ref: value.elements[0].ref, action: "click" })).toMatchObject({ code: "tab_not_ready" });
  data.agentAccess = false;
  expect(await call("page.read", { tabId: 7 })).toMatchObject({ code: "access_off" });
  expect(JSON.stringify(await log.read())).not.toContain("Private draft");
});
