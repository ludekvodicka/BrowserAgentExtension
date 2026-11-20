import { afterEach, expect, it, vi } from "vitest";
import { gmailAttachments, safeFileName } from "../src/tools/appdata/gmail/gmailAttachments.ts";
import type { GmailTabInfo } from "../src/tools/appdata/gmail/gmailTabPage.ts";
import type { GmailThreadPageResult } from "../src/tools/appdata/gmail/gmailThreadPage.ts";

afterEach(() => vi.unstubAllGlobals());
const tabInfo: GmailTabInfo = { account: "a@example.com", ik: "ab12", user: "0", threadId: "thread-f:42" };
const message = (attachments: { id: string | null; name: string; size: string }[]) => ({ from: "x", date: "d", recipients: [], body: "", attachments });
const thread: GmailThreadPageResult = { kind: "thread", subject: "Fixture", messages: [
  message([{ id: "1a17336a31a58f16:0.1", name: "card.jpg", size: "292K" }, { id: null, name: "inline", size: "" }]),
  message([{ id: "1a17772c61c9a95d:0.2", name: "a/b:c?.pdf", size: "3K" }]),
] };

// Tab 3 was viewed last; tab 5 shows another conversation, opened by an agent.
const otherInfo: GmailTabInfo = { account: "a@example.com", ik: "ab12", user: "0", threadId: "thread-f:77" };
const tabUrls = new Map([[3, "https://mail.google.com/mail/u/0/#inbox/a"], [5, "https://mail.google.com/mail/u/0/#search/x/b"], [6, "https://example.com/"]]);

function setup(item: Partial<chrome.downloads.DownloadItem> = { state: "complete", fileSize: 100 }) {
  const query = vi.fn(async () => [{ id: 3, lastAccessed: 9 }, { id: 5, lastAccessed: 1 }]);
  const get = vi.fn(async (tabId: number) => ({ id: tabId, url: tabUrls.get(tabId), discarded: false }));
  const executeScript = vi.fn(async (injection: { world?: string; target: { tabId: number } }) =>
    [{ result: injection.world === "MAIN" ? injection.target.tabId === 5 ? otherInfo : tabInfo : thread }]);
  const download = vi.fn(async (_options: chrome.downloads.DownloadOptions) => download.mock.calls.length);
  const search = vi.fn(async ({ id }: { id?: number }) => [{ id, filename: `C:\\Downloads\\file${id}`, ...item }]);
  vi.stubGlobal("chrome", { tabs: { query, get }, scripting: { executeScript }, downloads: { download, search } });
  return { query, get, executeScript, download, search };
}

it.each([[{ ids: [] }], [{ ids: ["../x"] }], [{ ids: "1a17336a31a58f16:0.1" }], [{ account: "a@example.com", folder: "x" }], [[]], [{ tabId: "5" }], [{ threadId: "thread-f:9" }]])(
  "refuses args %j before touching a tab", async args => {
  const s = setup();
  expect(await gmailAttachments.run(args)).toMatchObject({ ok: false, code: "tool_args_invalid" });
  expect(s.query).not.toHaveBeenCalled();
});

it("saves every attachment of the open conversation through the browser's downloads", async () => {
  const s = setup();
  expect(await gmailAttachments.run(undefined)).toEqual({ ok: true, value: { account: "a@example.com", tabId: 3, threadId: "thread-f:42", subject: "Fixture", saved: [
    { id: "1a17336a31a58f16:0.1", name: "card.jpg", state: "complete", path: "C:\\Downloads\\file1", bytes: 100 },
    { id: "1a17772c61c9a95d:0.2", name: "a/b:c?.pdf", state: "complete", path: "C:\\Downloads\\file2", bytes: 100 },
  ] } });
  expect(s.download).toHaveBeenNthCalledWith(1, { url: "https://mail.google.com/mail/u/0/?ui=2&ik=ab12&view=att&th=1a17336a31a58f16&attid=0.1&disp=safe&zw",
    filename: "browser-agent/gmail/42/card.jpg", conflictAction: "uniquify", saveAs: false });
  expect(s.download).toHaveBeenNthCalledWith(2, expect.objectContaining({ filename: "browser-agent/gmail/42/a_b_c_.pdf" }));
});

it("saves the attachments of the tab named by tabId although another tab was viewed later", async () => {
  const s = setup();
  expect(await gmailAttachments.run({ tabId: 5, ids: ["1a17336a31a58f16:0.1"] })).toMatchObject({ ok: true, value: { tabId: 5, threadId: "thread-f:77",
    saved: [{ name: "card.jpg", state: "complete" }] } });
  expect(s.query).not.toHaveBeenCalled();
  expect(s.executeScript.mock.calls.every(([injection]) => injection.target.tabId === 5)).toBe(true);
  expect(s.download).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ filename: "browser-agent/gmail/77/card.jpg" }));
});

it("refuses a named tab that is not Gmail, of another account, or without an open conversation, before any download", async () => {
  const s = setup();
  expect(await gmailAttachments.run({ tabId: 6 })).toMatchObject({ ok: false, code: "tab_missing" });
  expect(await gmailAttachments.run({ tabId: 5, account: "b@gmail.com" })).toMatchObject({ ok: false, code: "tool_args_invalid" });
  otherInfo.threadId = null;
  try {
    expect(await gmailAttachments.run({ tabId: 5 })).toMatchObject({ ok: false, code: "tab_not_ready" });
  } finally {
    otherInfo.threadId = "thread-f:77";
  }
  expect(s.download).not.toHaveBeenCalled();
});

it("saves the attachments of a conversation named by threadId without a tab that shows it", async () => {
  const s = setup();
  tabInfo.threadId = null;
  try {
    expect(await gmailAttachments.run({ account: "a@example.com", threadId: "thread-f:99", ids: ["1a17336a31a58f16:0.1"] })).toMatchObject({ ok: true,
      value: { tabId: 3, threadId: "thread-f:99", saved: [{ name: "card.jpg" }] } });
    expect(s.download).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ filename: "browser-agent/gmail/99/card.jpg" }));
  } finally {
    tabInfo.threadId = "thread-f:42";
  }
});

it("starts every download before it waits for any", async () => {
  const s = setup();
  await gmailAttachments.run(undefined);
  expect(Math.max(...s.download.mock.invocationCallOrder)).toBeLessThan(Math.min(...s.search.mock.invocationCallOrder));
});

it("reports downloads still running at the deadline as in progress", async () => {
  const s = setup({ state: "in_progress", filename: "C:\\Downloads\\big.zip" });
  vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(12_000);
  try {
    expect(await gmailAttachments.run(undefined)).toMatchObject({ ok: true, value: { saved: [
      { state: "in_progress", path: "C:\\Downloads\\big.zip", bytes: null }, { state: "in_progress", bytes: null }] } });
    expect(s.search).toHaveBeenCalledTimes(2);
  } finally {
    vi.restoreAllMocks();
  }
});

it("saves only the named attachments and refuses an id the conversation does not have", async () => {
  const s = setup();
  expect(await gmailAttachments.run({ ids: ["1a17772c61c9a95d:0.2"] })).toMatchObject({ ok: true, value: { saved: [{ name: "a/b:c?.pdf" }] } });
  expect(s.download).toHaveBeenCalledTimes(1);
  expect(await gmailAttachments.run({ ids: ["1a17772c61c9a95d:0.9"] })).toMatchObject({ ok: false, code: "tool_args_invalid", message: expect.stringContaining("0.9") });
});

it("reports an interrupted download with its reason", async () => {
  setup({ state: "interrupted", error: "SERVER_FORBIDDEN" });
  expect(await gmailAttachments.run({ ids: ["1a17336a31a58f16:0.1"] })).toMatchObject({ ok: true, value: { saved: [
    { state: "interrupted", bytes: null, error: "SERVER_FORBIDDEN" }] } });
});

it("contains a failing downloads call", async () => {
  const s = setup();
  s.download.mockRejectedValueOnce(new Error("invented-private-error"));
  const result = await gmailAttachments.run({});
  expect(result).toMatchObject({ ok: false, code: "extension_error" });
  expect(JSON.stringify(result)).not.toContain("invented-private-error");
});

it("keeps a sender's file name a plain name", () => {
  expect(safeFileName("..\\..\\evil.exe")).toBe("_.._evil.exe");
  expect(safeFileName(" report: Q3?.pdf ")).toBe("report_ Q3_.pdf");
  expect(safeFileName("...")).toBe("attachment");
});

it("names the folder of a conversation the user's own sent message started without the id prefix", async () => {
  const s = setup();
  tabInfo.threadId = "thread-a:r-83792";
  try {
    expect(await gmailAttachments.run({ ids: ["1a17336a31a58f16:0.1"] })).toMatchObject({ ok: true, value: { threadId: "thread-a:r-83792" } });
    expect(s.download).toHaveBeenCalledWith(expect.objectContaining({ filename: "browser-agent/gmail/r-83792/card.jpg" }));
  } finally {
    tabInfo.threadId = "thread-f:42";
  }
});
