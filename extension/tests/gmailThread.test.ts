import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import { gmailThread } from "../src/tools/appdata/gmail/gmailThread.ts";
import { gmailTabPage } from "../src/tools/appdata/gmail/gmailTabPage.ts";
import type { GmailTabInfo } from "../src/tools/appdata/gmail/gmailTabPage.ts";
import { gmailThreadPage } from "../src/tools/appdata/gmail/gmailThreadPage.ts";
import type { GmailThreadPageResult } from "../src/tools/appdata/gmail/gmailThreadPage.ts";

afterEach(() => vi.unstubAllGlobals());
const thread: GmailThreadPageResult = { kind: "thread", subject: "Fixture subject", messages: [] };
const info = (account: string | null, threadId: string | null): GmailTabInfo => ({ account, ik: "ab12", user: "0", threadId });

function setup(tabs: { id: number; lastAccessed: number; info: GmailTabInfo }[], page: GmailThreadPageResult = thread) {
  const query = vi.fn(async () => tabs.map(({ id, lastAccessed }) => ({ id, lastAccessed })));
  const executeScript = vi.fn(async (injection: { target: { tabId: number }; world?: string }) =>
    [{ result: injection.world === "MAIN" ? tabs.find(tab => tab.id === injection.target.tabId)!.info : page }]);
  vi.stubGlobal("chrome", { tabs: { query }, scripting: { executeScript } });
  return { query, executeScript };
}

it.each([[[]], ["x"], [{ account: "no-address" }], [{ account: 5 }], [{ account: "a@b.cz", folder: "inbox" }]])("refuses args %j before touching a tab", async args => {
  const s = setup([]);
  expect(await gmailThread.run(args)).toMatchObject({ ok: false, code: "tool_args_invalid" });
  expect(s.query).not.toHaveBeenCalled();
});

it("reads the most recently viewed open conversation in an isolated script", async () => {
  const s = setup([{ id: 1, lastAccessed: 50, info: info("a@example.com", "thread-f:1") }, { id: 2, lastAccessed: 90, info: info("b@gmail.com", "thread-f:2") },
    { id: 3, lastAccessed: 99, info: info("a@example.com", null) }]);
  expect(await gmailThread.run({})).toEqual({ ok: true, value: { account: "b@gmail.com", threadId: "thread-f:2", subject: "Fixture subject", messages: [] } });
  expect(s.query).toHaveBeenCalledExactlyOnceWith({ url: "https://mail.google.com/mail/*", discarded: false });
  expect(s.executeScript).toHaveBeenLastCalledWith({ target: { tabId: 2 }, func: gmailThreadPage, args: ["0", "ab12", "thread-f:2"] });
});

it("selects the account without regard to letter case", async () => {
  setup([{ id: 1, lastAccessed: 50, info: info("a@example.com", "thread-f:1") }, { id: 2, lastAccessed: 90, info: info("b@gmail.com", "thread-f:2") }]);
  expect(await gmailThread.run({ account: "A@Example.com" })).toMatchObject({ ok: true, value: { account: "a@example.com", threadId: "thread-f:1" } });
});

it("names the open accounts when the requested one has no tab, and asks for a tab without opening one", async () => {
  setup([{ id: 1, lastAccessed: 50, info: info("a@example.com", "thread-f:1") }, { id: 2, lastAccessed: 60, info: info(null, null) }]);
  expect(await gmailThread.run({ account: "c@gmail.com" })).toMatchObject({ ok: false, code: "tab_missing", message: expect.stringContaining("open accounts: a@example.com)") });
  const s = setup([]);
  expect(await gmailThread.run(undefined)).toMatchObject({ ok: false, code: "tab_missing", message: expect.stringContaining("mail.google.com") });
  expect(s.executeScript).not.toHaveBeenCalled();
});

it("asks for an open conversation when the account's tabs show none", async () => {
  setup([{ id: 1, lastAccessed: 50, info: info("a@example.com", null) }]);
  expect(await gmailThread.run({})).toMatchObject({ ok: false, code: "tab_not_ready", message: expect.stringContaining("a@example.com") });
});

it("contains page failures and unknown results", async () => {
  const tabs = [{ id: 1, lastAccessed: 50, info: info("a@example.com", "thread-f:1") }];
  setup(tabs, { kind: "extension_error" });
  expect(await gmailThread.run({})).toMatchObject({ ok: false, code: "extension_error" });
  setup(tabs, { kind: "unexpected" } as unknown as GmailThreadPageResult);
  expect(await gmailThread.run({})).toMatchObject({ ok: false, code: "extension_error" });
});

it("tab page reads the account, request key, user index and only the visible conversation", () => {
  const dom = new JSDOM(`<h2 data-thread-perm-id="thread-f:1" hidden>Old</h2><h2 data-thread-perm-id="thread-f:2">Open</h2>`,
    { url: "https://mail.google.com/mail/u/1/#inbox/FMfcg" });
  const window = Object.assign(dom.window, { GLOBALS: Object.assign(new Array(11), { 9: "ab12", 10: "a@example.com" }) });
  window.Element.prototype.checkVisibility = function (this: Element) { return !this.hasAttribute("hidden"); };
  const run = new Function("window", "document", "location", `return (${gmailTabPage.toString()});`)(window, window.document, window.location) as typeof gmailTabPage;
  expect(run()).toEqual({ account: "a@example.com", ik: "ab12", user: "1", threadId: "thread-f:2" });
});

const printView = `<html><head><title>Mail - Fixture</title><style>p{}</style></head><body><div class="maincontent">
<table><tr><td><font size=+1><b>Fixture subject</b></font><br><font size=-1>2 messages</font></td></tr></table><hr>
<table width=100% class="message"><tr><td><font size=-1><b>Ann Sender </b>&lt;ann@example.com&gt;</font></td><td align=right><font size=-1>25. října 2026 v 14:18</font>
<tr><td colspan=2><font size=-1 class="recipient"><div>Komu: Bob &lt;bob@example.com&gt;</div><div>Kopie: carl@example.com</div></font>
<tr><td colspan=2><table cellpadding=12><tr><td><div style="overflow: hidden;"><font size=-1><div dir="ltr">Hello Bob,<br><br>see <a href="https://example.com/doc">the doc</a>.<ul><li>one</li><li>two</li></ul></div><style>.x{}</style></font></div>
<table><tr><td><a href="?ui=2&amp;ik=ab12&amp;view=att&amp;th=1&amp;attid=0.1"><img></a></td><td><b>offer.pdf</b><br/>120K </td></tr></table></td></tr></table></table><hr>
<table width=100% class="message"><tr><td><font size=-1><b>Bob </b>&lt;bob@example.com&gt;</font></td><td align=right><font size=-1>26. října 2026 v 9:00</font>
<tr><td colspan=2><font size=-1 class="recipient"><div>Komu: ann@example.com</div></font>
<tr><td colspan=2><table cellpadding=12><tr><td><div style="overflow: hidden;"><font size=-1>Thanks.<div>[Quoted text hidden]</div></font></div></table></table></div></body></html>`;

function page(response: { ok: boolean; text: string }, origin = "https://mail.google.com") {
  const fetcher = vi.fn(async () => ({ ok: response.ok, text: async () => response.text }));
  const run = new Function("fetch", "location", "DOMParser", `return (${gmailThreadPage.toString()});`)(fetcher, { origin }, new JSDOM("").window.DOMParser) as typeof gmailThreadPage;
  return { fetcher, run };
}

it("thread page reads the print view into sender, date, recipients, plain-text body and attachments", async () => {
  const p = page({ ok: true, text: printView });
  expect(await p.run("0", "ab12", "thread-f:2")).toEqual({ kind: "thread", subject: "Fixture subject", messages: [
    { from: "Ann Sender <ann@example.com>", date: "25. října 2026 v 14:18", recipients: ["Komu: Bob <bob@example.com>", "Kopie: carl@example.com"],
      body: "Hello Bob,\n\nsee the doc <https://example.com/doc>.\n\n- one\n\n- two", attachments: [{ id: "1:0.1", name: "offer.pdf", size: "120K" }] },
    { from: "Bob <bob@example.com>", date: "26. října 2026 v 9:00", recipients: ["Komu: ann@example.com"], body: "Thanks.\n[Quoted text hidden]", attachments: [] },
  ] });
  expect(p.fetcher).toHaveBeenCalledExactlyOnceWith("/mail/u/0/?ik=ab12&view=pt&search=all&permthid=thread-f%3A2", { redirect: "error" });
});

it("thread page lists an attachment that Gmail shows in two rows once", async () => {
  const row = `<table><tr><td><a href="?ui=2&amp;ik=ab12&amp;view=att&amp;th=1&amp;attid=0.1"><img></a></td><td><b>offer.pdf</b><br/>120K </td></tr></table>`;
  const result = await page({ ok: true, text: printView.replace(row, row + row) }).run("0", "ab12", "thread-f:2");
  expect(result).toMatchObject({ kind: "thread", messages: [{ attachments: [{ id: "1:0.1", name: "offer.pdf", size: "120K" }] }, { attachments: [] }] });
  expect(printView).toContain(row);
});

it("thread page reads a conversation that the user's own sent message started", async () => {
  for (const threadId of ["thread-a:r-8379218361718728381", "thread-a:r8379218361718728381"]) {
    const p = page({ ok: true, text: printView });
    expect(await p.run("0", "ab12", threadId)).toMatchObject({ kind: "thread", subject: "Fixture subject" });
    expect(p.fetcher).toHaveBeenCalledExactlyOnceWith(`/mail/u/0/?ik=ab12&view=pt&search=all&permthid=${encodeURIComponent(threadId)}`, { redirect: "error" });
  }
});

it("thread page refuses a foreign origin, malformed ids and a failed response", async () => {
  expect(await page({ ok: true, text: printView }, "https://evil.example").run("0", "ab12", "thread-f:2")).toEqual({ kind: "extension_error" });
  for (const [user, ik, threadId] of [["0/x", "ab12", "thread-f:2"], ["0", "ab&x", "thread-f:2"], ["0", "ab12", "msg-f:2"], ["0", "ab12", "thread-a:2"]]) {
    const p = page({ ok: true, text: printView });
    expect(await p.run(user, ik, threadId)).toEqual({ kind: "extension_error" });
    expect(p.fetcher).not.toHaveBeenCalled();
  }
  expect(await page({ ok: false, text: "" }).run("0", "ab12", "thread-f:2")).toEqual({ kind: "extension_error" });
});
