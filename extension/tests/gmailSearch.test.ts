import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import { gmailSearch } from "../src/tools/appdata/gmail/gmailSearch.ts";
import { gmailSearchPage } from "../src/tools/appdata/gmail/gmailSearchPage.ts";
import type { GmailSearchPageResult } from "../src/tools/appdata/gmail/gmailSearchPage.ts";
import type { GmailTabInfo } from "../src/tools/appdata/gmail/gmailTabPage.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const tabInfo: GmailTabInfo = { account: "a@example.com", ik: "ab12", user: "0", threadId: null };
const found: GmailSearchPageResult = { kind: "results", range: "1–2 z 2", truncated: false, threads: [
  { threadId: "thread-f:11", subject: "Faktura", from: ["E.ON <e-bill@eon.cz>"], date: "pá 6. 11. 2026 18:06", snippet: "Vyúčtování", unread: false, hasAttachment: true }] };

function setup(page: GmailSearchPageResult = found, url = "https://mail.google.com/mail/u/0/#inbox") {
  const get = vi.fn(async (tabId: number) => ({ id: tabId, url, discarded: false }));
  const executeScript = vi.fn(async (injection: { world?: string; args?: unknown[] }) => [{ result: injection.world === "MAIN" ? tabInfo : page }]);
  vi.stubGlobal("chrome", { tabs: { get }, scripting: { executeScript } });
  return { get, executeScript };
}

it.each([[{}], [{ query: "x" }], [{ tabId: 5 }], [{ tabId: 5, query: " " }], [{ tabId: 5, query: "a\nb" }], [{ tabId: 5, query: "x".repeat(501) }],
  [{ tabId: 5, query: "x", limit: 0 }], [{ tabId: 5, query: "x", limit: 101 }], [{ tabId: 5, query: "x", folder: "inbox" }], [{ tabId: 5, query: "x", account: "nope" }], [[]]])(
  "refuses args %j before touching a tab", async args => {
    const s = setup();
    expect(await gmailSearch.run(args)).toMatchObject({ ok: false, code: "tool_args_invalid" });
    expect(s.get).not.toHaveBeenCalled();
  });

it("searches in the named tab and returns the conversations with the account and tab", async () => {
  const s = setup();
  expect(await gmailSearch.run({ tabId: 5, query: " from:eon.cz faktura ", account: "A@example.com" })).toEqual({ ok: true, value: { account: "a@example.com", tabId: 5,
    query: "from:eon.cz faktura", range: "1–2 z 2", truncated: false, threads: found.threads } });
  expect(s.executeScript).toHaveBeenLastCalledWith({ target: { tabId: 5 }, func: gmailSearchPage, args: ["from:eon.cz faktura", 50] });
  await gmailSearch.run({ tabId: 5, query: "x", limit: 3 });
  expect(s.executeScript).toHaveBeenLastCalledWith(expect.objectContaining({ args: ["x", 3] }));
});

it("refuses a tab that is not Gmail or of another account before it searches", async () => {
  let s = setup(found, "https://example.com/");
  expect(await gmailSearch.run({ tabId: 5, query: "x" })).toMatchObject({ ok: false, code: "tab_missing" });
  expect(s.executeScript).not.toHaveBeenCalled();
  s = setup();
  expect(await gmailSearch.run({ tabId: 5, query: "x", account: "b@gmail.com" })).toMatchObject({ ok: false, code: "tool_args_invalid" });
  expect(s.executeScript.mock.calls.every(([injection]) => injection.world === "MAIN")).toBe(true);
});

it("maps a page timeout to tab_not_ready and contains unknown results", async () => {
  setup({ kind: "timeout" });
  expect(await gmailSearch.run({ tabId: 5, query: "x" })).toMatchObject({ ok: false, code: "tab_not_ready", message: expect.stringContaining("tab 5") });
  setup({ kind: "unexpected" } as unknown as GmailSearchPageResult);
  expect(await gmailSearch.run({ tabId: 5, query: "x" })).toMatchObject({ ok: false, code: "extension_error" });
});

type Row = { id: string; subject: string; unread?: boolean; attachment?: boolean; senders?: [string, string][] };
const row = ({ id, subject, unread = false, attachment = false, senders = [["Ann", "ann@example.com"]] }: Row) => `<tr class="zA ${unread ? "zE" : "yO"}">
<td class="yX"><div class="afn"><span data-thread-id="#${id}">${subject}</span></div><div class="yW">${senders.map(([name, email]) =>
  `<span class="bA4"><span email="${email}" name="${name}">${name}</span></span>`).join(", ")}</div></td>
<td class="a4W"><div class="y6"><span class="bog"><span data-thread-id="#${id}">${subject}</span></span></div><span class="y2"><span class="Zt">&nbsp;-&nbsp;</span>Text of ${subject}</span></td>
<td class="yf">${attachment ? `<img title="Má přílohu">` : "&nbsp;"}</td><td class="xW"><span title="pá 6. 11. 2026 18:06"><span>6. 11.</span></span></td></tr>`;
const list = (rows: Row[], range: string) => `<div class="list"><div class="Dj">${range}</div><table><tbody>${rows.map(row).join("")}</tbody></table></div>`;
const inbox = list([{ id: "thread-f:1", subject: "Inbox one" }, { id: "thread-f:2", subject: "Inbox two" }], "1–2 z 2");

// A Gmail page whose hash change hides the shown list and shows the given result list, as Gmail keeps earlier lists hidden.
function gmail(onSearch: string | null, hash = "#inbox") {
  const dom = new JSDOM(`<div role="main">${inbox}</div>`, { url: `https://mail.google.com/mail/u/0/${hash}` });
  const window = dom.window;
  window.Element.prototype.checkVisibility = function (this: Element) { return !this.closest("[hidden]"); };
  window.addEventListener("hashchange", () => {
    if (onSearch === null)
      return;
    const main = window.document.querySelector("[role=main]")!;
    for (const shown of main.querySelectorAll(".list"))
      shown.setAttribute("hidden", "");
    main.insertAdjacentHTML("beforeend", onSearch);
  });
  const run = new Function("document", "location", `return (${gmailSearchPage.toString()});`)(window.document, window.location) as typeof gmailSearchPage;
  return { window, run };
}

it("search page shows the search in the tab, waits for the new list and reads only its visible rows", async () => {
  const g = gmail(list([
    { id: "thread-f:11", subject: "Faktura 1", attachment: true, senders: [["E.ON", "e-bill@eon.cz"], ["E.ON", "e-bill@eon.cz"], ["bob@example.com", "bob@example.com"]] },
    { id: "thread-a:r-12", subject: "Faktura 2", unread: true }, { id: "thread-f:13", subject: "Faktura 3" }], "1–3 z 3"));
  const result = await g.run("from:eon.cz faktura", 2);
  expect(g.window.location.hash).toBe(`#search/${encodeURIComponent("from:eon.cz faktura")}`);
  expect(result).toEqual({ kind: "results", range: "1–3 z 3", truncated: true, threads: [
    { threadId: "thread-f:11", subject: "Faktura 1", from: ["E.ON <e-bill@eon.cz>", "bob@example.com"], date: "pá 6. 11. 2026 18:06", snippet: "Text of Faktura 1",
      unread: false, hasAttachment: true },
    { threadId: "thread-a:r-12", subject: "Faktura 2", from: ["Ann <ann@example.com>"], date: "pá 6. 11. 2026 18:06", snippet: "Text of Faktura 2",
      unread: true, hasAttachment: false },
  ] });
});

it("search page returns no conversations when Gmail shows its empty result cell", async () => {
  const g = gmail(`<div class="list"><table><tbody><tr><td class="TC">No messages matched your search.</td></tr></tbody></table></div>`);
  expect(await g.run("nothing", 50)).toEqual({ kind: "results", range: null, truncated: false, threads: [] });
});

it("search page reads the shown list when the tab already shows that search", async () => {
  const g = gmail(null, `#search/${encodeURIComponent("a b").replace(/%20/g, "+")}`);
  expect(await g.run("a b", 50)).toMatchObject({ kind: "results", threads: [{ threadId: "thread-f:1" }, { threadId: "thread-f:2" }] });
  expect(g.window.location.hash).toBe("#search/a+b");
});

it("search page gives up when Gmail does not replace the list within 10 seconds", async () => {
  vi.useFakeTimers();
  const g = gmail(null);
  const result = g.run("x", 50);
  await vi.advanceTimersByTimeAsync(10_500);
  expect(await result).toEqual({ kind: "timeout" });
});
