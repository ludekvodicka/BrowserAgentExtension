import { afterEach, expect, it, vi } from "vitest";
import { gmailReply } from "../src/tools/appdata/gmail/gmailReply.ts";
import type { GmailComposeResult } from "../src/tools/appdata/gmail/gmailComposePage.ts";
import type { GmailTabInfo } from "../src/tools/appdata/gmail/gmailTabPage.ts";

afterEach(() => vi.unstubAllGlobals());
const tabInfo: GmailTabInfo = { account: "a@example.com", ik: "ab12", user: "0", threadId: "thread-f:42" };
const files = [{ name: "smlouva.pdf", data: "QUJD" }];

// Tab 3 was viewed last; tab 5 shows another conversation, opened by an agent.
const otherInfo: GmailTabInfo = { account: "a@example.com", ik: "ab12", user: "0", threadId: "thread-f:77" };
const tabUrls = new Map([[3, "https://mail.google.com/mail/u/0/#inbox/a"], [5, "https://mail.google.com/mail/u/0/#search/x/b"], [6, "https://example.com/"]]);

function setup(compose: GmailComposeResult = { kind: "filled", attached: [{ name: "smlouva.pdf", shown: true }], discarded: 0 }) {
  const query = vi.fn(async () => [{ id: 3, windowId: 1, index: 0, lastAccessed: 9 }, { id: 5, windowId: 1, index: 1, lastAccessed: 1 }]);
  const get = vi.fn(async (tabId: number) => ({ id: tabId, url: tabUrls.get(tabId), discarded: false }));
  const executeScript = vi.fn(async (injection: { world?: string; target: { tabId: number }; args?: unknown[] }) =>
    [{ result: injection.world === "MAIN" ? injection.target.tabId === 5 ? otherInfo : tabInfo : compose }]);
  vi.stubGlobal("chrome", { tabs: { query, get }, scripting: { executeScript } });
  return { query, get, executeScript };
}

it.each([[{ body: 1 }], [{ replyAll: "yes" }], [{ to: ["x@y.cz"] }], [{ account: "nope" }], [{ from: "nope" }], [{ from: "a@b.cz", replyAll: true }], [{ replaceDraft: true }],
  [{ from: "a@b.cz", replaceDraft: "yes" }], [[]], [{ tabId: null }]])("refuses args %j before touching a tab", async args => {
  const s = setup();
  expect(await gmailReply.run(args, [])).toMatchObject({ ok: false, code: "tool_args_invalid" });
  expect(s.query).not.toHaveBeenCalled();
});

it("opens the reply in the open conversation's tab with the body and files", async () => {
  const s = setup();
  expect(await gmailReply.run({ body: "Dobrý den,\nposílám.", replyAll: true }, files)).toEqual({ ok: true, value: { account: "a@example.com", tabId: 3,
    threadId: "thread-f:42", replyAll: true, bodyLength: 19, attached: [{ name: "smlouva.pdf", shown: true }] } });
  const compose = s.executeScript.mock.calls.map(([injection]) => injection).find(injection => injection.world !== "MAIN");
  expect(compose).toMatchObject({ target: { tabId: 3 }, args: ["replyAll", "Dobrý den,\nposílám.", files, null, false] });
});

it("replies in the tab named by tabId although another tab was viewed later", async () => {
  const s = setup();
  expect(await gmailReply.run({ tabId: 5, body: "x" }, files)).toMatchObject({ ok: true, value: { tabId: 5, threadId: "thread-f:77" } });
  expect(s.query).not.toHaveBeenCalled();
  expect(s.executeScript.mock.calls.at(-1)![0]).toMatchObject({ target: { tabId: 5 }, args: ["reply", "x", files, null, false] });
});

it("refuses a named tab that is not Gmail, of another account, or without an open conversation, before it opens a reply", async () => {
  const s = setup();
  expect(await gmailReply.run({ tabId: 6, body: "x" })).toMatchObject({ ok: false, code: "tab_missing" });
  expect(await gmailReply.run({ tabId: 5, account: "b@gmail.com", body: "x" })).toMatchObject({ ok: false, code: "tool_args_invalid" });
  otherInfo.threadId = null;
  try {
    expect(await gmailReply.run({ tabId: 5, body: "x" })).toMatchObject({ ok: false, code: "tab_not_ready" });
  } finally {
    otherInfo.threadId = "thread-f:77";
  }
  expect(s.executeScript.mock.calls.every(([injection]) => injection.world === "MAIN")).toBe(true);
});

it("defaults to a plain reply without body or files", async () => {
  const s = setup({ kind: "filled", attached: [], discarded: 0 });
  expect(await gmailReply.run(undefined)).toMatchObject({ ok: true, value: { replyAll: false, bodyLength: 0, attached: [] } });
  expect(s.executeScript.mock.calls.at(-1)![0]).toMatchObject({ args: ["reply", null, [], null, false] });
});

it("replies to the message of the sender named by from", async () => {
  const s = setup({ kind: "filled", attached: [], discarded: 0 });
  const result = await gmailReply.run({ body: "x", from: "jana@example.com" });
  expect(result).toMatchObject({ ok: true, value: { from: "jana@example.com", replyAll: false } });
  expect(result).not.toHaveProperty("value.discarded");
  expect(s.executeScript.mock.calls.at(-1)![0]).toMatchObject({ args: ["reply", "x", [], "jana@example.com", false] });
});

it("reports how many drafts to the sender it discarded first", async () => {
  const s = setup({ kind: "filled", attached: [], discarded: 1 });
  expect(await gmailReply.run({ body: "x", from: "jana@example.com", replaceDraft: true })).toMatchObject({ ok: true, value: { from: "jana@example.com", discarded: 1 } });
  expect(s.executeScript.mock.calls.at(-1)![0]).toMatchObject({ args: ["reply", "x", [], "jana@example.com", true] });
});

it.each([
  [{ kind: "no_reply_link" }, "tab_not_ready"],
  [{ kind: "no_message" }, "tab_not_ready"],
  [{ kind: "no_message_reply" }, "extension_error"],
  [{ kind: "other_recipient" }, "extension_error"],
  [{ kind: "no_discard" }, "extension_error"],
  [{ kind: "no_compose" }, "extension_error"],
  [{ kind: "no_attach_button" }, "extension_error"],
  [{ kind: "no_file_input" }, "extension_error"],
] as const)("maps the page outcome %j to %s", async (compose, code) => {
  setup(compose);
  expect(await gmailReply.run({ body: "x" }, files)).toMatchObject({ ok: false, code });
});

it("needs an open conversation", async () => {
  const s = setup();
  s.executeScript.mockImplementation(async () => [{ result: { ...tabInfo, threadId: null } }]);
  expect(await gmailReply.run({ body: "x" })).toMatchObject({ ok: false, code: "tab_not_ready" });
});
