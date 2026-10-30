import { afterEach, expect, it, vi } from "vitest";
import { gmailDraft } from "../src/tools/appdata/gmail/gmailDraft.ts";
import type { GmailTabInfo } from "../src/tools/appdata/gmail/gmailTabPage.ts";

afterEach(() => vi.unstubAllGlobals());
const info = (account: string, user: string): GmailTabInfo => ({ account, ik: "ab12", user, threadId: null });

function setup() {
  const query = vi.fn(async () => [{ id: 3, windowId: 7, index: 2, lastAccessed: 5 }, { id: 4, windowId: 8, index: 0, lastAccessed: 9 }]);
  const executeScript = vi.fn(async ({ target }: { target: { tabId: number } }) => [{ result: target.tabId === 3 ? info("a@example.com", "0") : info("b@gmail.com", "1") }]);
  const create = vi.fn(async (_properties: chrome.tabs.CreateProperties) => ({}));
  vi.stubGlobal("chrome", { tabs: { query, create }, scripting: { executeScript } });
  return { query, create };
}

it.each([[{ to: "x@y.cz" }], [{ to: ["x@y.cz, z@y.cz"] }], [{ bcc: ["Name <x@y.cz>"] }], [{ subject: "a\nb" }], [{ body: 3 }], [{ send: true }], [[]]])(
  "refuses args %j before touching a tab", async args => {
    const s = setup();
    expect(await gmailDraft.run(args)).toMatchObject({ ok: false, code: "tool_args_invalid" });
    expect(s.query).not.toHaveBeenCalled();
  });

it("opens a filled compose page of the named account next to its Gmail tab", async () => {
  const s = setup();
  const args = { account: "A@example.com", to: ["x@y.cz", "z@y.cz"], bcc: ["h@y.cz"], subject: "Příloha + termín", body: "Dobrý den,\nposílám 50% & víc." };
  expect(await gmailDraft.run(args)).toEqual({ ok: true, value: { account: "a@example.com", to: ["x@y.cz", "z@y.cz"], cc: [], bcc: ["h@y.cz"],
    subject: "Příloha + termín", bodyLength: 29, attached: [] } });
  const { url, windowId, index, active } = s.create.mock.calls[0][0];
  expect({ windowId, index, active }).toEqual({ windowId: 7, index: 3, active: true });
  expect(url).toMatch(/^https:\/\/mail\.google\.com\/mail\/u\/0\/\?view=cm&fs=1&/);
  expect(url).not.toContain("+");
  const query = new URL(url!).searchParams;
  expect(Object.fromEntries(query)).toEqual({ view: "cm", fs: "1", to: "x@y.cz,z@y.cz", bcc: "h@y.cz", su: args.subject, body: args.body });
});

it("without an account takes the Gmail tab viewed last", async () => {
  const s = setup();
  expect(await gmailDraft.run({ to: ["x@y.cz"] })).toMatchObject({ ok: true, value: { account: "b@gmail.com" } });
  expect(s.create.mock.calls[0][0]).toMatchObject({ windowId: 8, index: 1, url: expect.stringContaining("/mail/u/1/") });
});

it("refuses a draft longer than the compose link allows and an account without a tab", async () => {
  const s = setup();
  expect(await gmailDraft.run({ body: "č".repeat(2000) })).toMatchObject({ ok: false, code: "tool_args_invalid", message: expect.stringContaining("shorten") });
  expect(await gmailDraft.run({ account: "c@y.cz" })).toMatchObject({ ok: false, code: "tab_missing", message: expect.stringContaining("a@example.com, b@gmail.com") });
  expect(s.create).not.toHaveBeenCalled();
});
