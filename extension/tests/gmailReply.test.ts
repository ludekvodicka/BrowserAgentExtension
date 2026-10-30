import { afterEach, expect, it, vi } from "vitest";
import { gmailReply } from "../src/tools/appdata/gmail/gmailReply.ts";
import type { GmailComposeResult } from "../src/tools/appdata/gmail/gmailComposePage.ts";
import type { GmailTabInfo } from "../src/tools/appdata/gmail/gmailTabPage.ts";

afterEach(() => vi.unstubAllGlobals());
const tabInfo: GmailTabInfo = { account: "a@example.com", ik: "ab12", user: "0", threadId: "thread-f:42" };
const files = [{ name: "smlouva.pdf", data: "QUJD" }];

function setup(compose: GmailComposeResult = { kind: "filled", attached: [{ name: "smlouva.pdf", shown: true }] }) {
  const query = vi.fn(async () => [{ id: 3, windowId: 1, index: 0, lastAccessed: 1 }]);
  const executeScript = vi.fn(async (injection: { world?: string; args?: unknown[] }) => [{ result: injection.world === "MAIN" ? tabInfo : compose }]);
  vi.stubGlobal("chrome", { tabs: { query }, scripting: { executeScript } });
  return { query, executeScript };
}

it.each([[{ body: 1 }], [{ replyAll: "yes" }], [{ to: ["x@y.cz"] }], [{ account: "nope" }], [[]]])("refuses args %j before touching a tab", async args => {
  const s = setup();
  expect(await gmailReply.run(args, [])).toMatchObject({ ok: false, code: "tool_args_invalid" });
  expect(s.query).not.toHaveBeenCalled();
});

it("opens the reply in the open conversation's tab with the body and files", async () => {
  const s = setup();
  expect(await gmailReply.run({ body: "Dobrý den,\nposílám.", replyAll: true }, files)).toEqual({ ok: true, value: { account: "a@example.com",
    threadId: "thread-f:42", replyAll: true, bodyLength: 19, attached: [{ name: "smlouva.pdf", shown: true }] } });
  const compose = s.executeScript.mock.calls.map(([injection]) => injection).find(injection => injection.world !== "MAIN");
  expect(compose).toMatchObject({ target: { tabId: 3 }, args: ["replyAll", "Dobrý den,\nposílám.", files] });
});

it("defaults to a plain reply without body or files", async () => {
  const s = setup({ kind: "filled", attached: [] });
  expect(await gmailReply.run(undefined)).toMatchObject({ ok: true, value: { replyAll: false, bodyLength: 0, attached: [] } });
  expect(s.executeScript.mock.calls.at(-1)![0]).toMatchObject({ args: ["reply", null, []] });
});

it.each([
  [{ kind: "no_reply_link" }, "tab_not_ready"],
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
