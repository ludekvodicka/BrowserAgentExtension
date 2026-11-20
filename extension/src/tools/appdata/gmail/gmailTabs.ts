import type { ToolFile } from "../../../../../shared/protocol.ts";
import type { ToolResult } from "../../browserTool.ts";
import { gmailComposePage } from "./gmailComposePage.ts";
import { gmailTabPage } from "./gmailTabPage.ts";
import type { GmailTabInfo } from "./gmailTabPage.ts";
import { gmailThreadPage } from "./gmailThreadPage.ts";
import type { GmailMessage } from "./gmailThreadPage.ts";

type SignedInInfo = GmailTabInfo & { account: string; ik: string; user: string };
export type GmailAccountTab = { tabId: number; windowId: number; index: number; info: SignedInInfo };
export type GmailTab = { tabId: number; info: SignedInInfo & { threadId: string } };
export type GmailThread = { account: string; tabId: number; threadId: string; subject: string; messages: GmailMessage[] };
export type ConversationArgs = { account: string | undefined; tabId: number | undefined; threadId: string | undefined };

export const addressPattern = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;
// The same rule as gmailThreadPage, which repeats it because a page function cannot import.
const threadIdPattern = /^thread-(f:|a:r-?)\d{1,30}$/;

export const isTabId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export const accountArgs = (args: unknown): string | undefined | null => {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return null;
  const account = (args as Record<string, unknown>).account;
  return account === undefined || typeof account === "string" && addressPattern.test(account) ? account : null;
};

// The account, tab and thread of the conversation tools; null when one is malformed, or a threadId has neither account nor tabId to
// name its account.
export const conversationArgs = (args: unknown): ConversationArgs | null => {
  const account = accountArgs(args);
  if (account === null)
    return null;
  const { tabId, threadId } = args as Record<string, unknown>;
  if (!(tabId === undefined || isTabId(tabId)))
    return null;
  if (!(threadId === undefined || typeof threadId === "string" && threadIdPattern.test(threadId) && (account !== undefined || tabId !== undefined)))
    return null;
  return { account, tabId, threadId };
};

async function signedInInfo(tabId: number): Promise<SignedInInfo | null> {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: gmailTabPage }).catch(() => []);
  const info = injection?.result;
  return info?.account && info.ik && info.user ? { ...info, account: info.account, ik: info.ik, user: info.user } : null;
}

// The signed-in Gmail tabs of the given account when one is named, the one the user viewed last first.
export async function accountTabs(account: string | undefined): Promise<GmailAccountTab[] | ToolResult> {
  const tabs = await chrome.tabs.query({ url: "https://mail.google.com/mail/*", discarded: false });
  const read = await Promise.all(tabs.map(async ({ id, windowId, index, lastAccessed }) => {
    if (id === undefined)
      return null;
    const info = await signedInInfo(id);
    return info ? { tabId: id, windowId, index, lastAccessed: lastAccessed ?? 0, info } : null;
  }));
  const signedIn = read.filter(tab => tab !== null);
  const ofAccount = signedIn.filter(tab => account === undefined || tab.info.account.toLowerCase() === account.toLowerCase());
  if (!ofAccount.length)
    return { ok: false, code: "tab_missing", message: account === undefined ? "Open Gmail at mail.google.com in this browser profile, then request the tool again."
      : `No Gmail tab of ${account} is open in this browser profile (open accounts: ${[...new Set(signedIn.map(tab => tab.info.account))].join(", ") || "none"}).` };
  return ofAccount.sort((a, b) => b.lastAccessed - a.lastAccessed).map(({ tabId, windowId, index, info }) => ({ tabId, windowId, index, info }));
}

// With threadId: that conversation, read through the session of the named tab or of the account's last viewed tab; no tab needs to
// show it. Otherwise the named tab when tabId is given (account then only checks it), else the Gmail tab whose open conversation
// the user looked at last, of the given account when one is named. An agent's navigation inside a tab does not change lastAccessed.
export async function conversationTab({ account, tabId, threadId }: ConversationArgs): Promise<GmailTab | ToolResult> {
  if (threadId === undefined)
    return tabId === undefined ? lastConversationTab(account) : namedConversationTab(tabId, account);
  const tab = tabId === undefined ? await accountTabs(account).then(tabs => "ok" in tabs ? tabs : tabs[0]) : await namedTab(tabId, account);
  return "ok" in tab ? tab : { tabId: tab.tabId, info: { ...tab.info, threadId } };
}

// The signed-in Gmail tab named by tabId, of the given account when one is named.
export async function namedTab(tabId: number, account: string | undefined): Promise<{ tabId: number; info: SignedInInfo } | ToolResult> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url?.startsWith("https://mail.google.com/mail/") || tab.discarded)
    return { ok: false, code: "tab_missing", message: `Tab ${tabId} is not an open Gmail tab (mail.google.com/mail/) in this browser profile; take the tabId from page.tabs.` };
  const info = await signedInInfo(tabId);
  if (!info)
    return { ok: false, code: "not_signed_in", message: `Gmail in tab ${tabId} shows no signed-in account. Sign in or reload that tab, then retry.` };
  if (account !== undefined && info.account.toLowerCase() !== account.toLowerCase())
    return { ok: false, code: "tool_args_invalid", message: `Tab ${tabId} shows Gmail of ${info.account}, not ${account}. Leave out account or name a tab of ${account}.` };
  return { tabId, info };
}

async function namedConversationTab(tabId: number, account: string | undefined): Promise<GmailTab | ToolResult> {
  const named = await namedTab(tabId, account);
  if ("ok" in named)
    return named;
  const { info } = named;
  if (!info.threadId)
    return { ok: false, code: "tab_not_ready", message: `Tab ${tabId} shows no open conversation (${info.account}). Open the conversation in that tab, then retry.` };
  return { tabId, info: { ...info, threadId: info.threadId } };
}

async function lastConversationTab(account: string | undefined): Promise<GmailTab | ToolResult> {
  const tabs = await accountTabs(account);
  if ("ok" in tabs)
    return tabs;
  const chosen = tabs.find(tab => tab.info.threadId);
  if (!chosen)
    return { ok: false, code: "tab_not_ready", message: `Open the conversation in Gmail (${tabs[0].info.account}), then request the tool again.` };
  return { tabId: chosen.tabId, info: { ...chosen.info, threadId: chosen.info.threadId! } };
}

// Opens a reply (or takes the tab's only compose window), types the body and attaches the files; returns the attach outcome
// and how many earlier drafts it discarded.
export async function fillCompose(tabId: number, reply: "reply" | "replyAll" | null, body: string | null, files: ToolFile[], from: string | null = null,
  replaceDraft = false): Promise<{ attached: { name: string; shown: boolean }[]; discarded: number } | ToolResult> {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: gmailComposePage, args: [reply, body, files, from, replaceDraft] });
  const result = injection?.result;
  switch (result?.kind) {
    case "filled":
      return { attached: result.attached, discarded: result.discarded };
    case "no_reply_link":
      return { ok: false, code: "tab_not_ready", message: "Gmail shows no reply link below the open conversation. Scroll to its end or open it again, then retry." };
    case "no_message":
      return { ok: false, code: "tab_not_ready", message: `The open conversation shows no message from ${from}. Check the address or expand the conversation's messages, then retry.` };
    case "no_message_reply":
      return { ok: false, code: "extension_error", message: `Gmail showed no reply button on the message from ${from}. Expand that message, then retry.` };
    case "no_discard":
      return { ok: false, code: "extension_error", message: `An open draft to ${from} did not close on Gmail's discard button. Nothing was typed; discard it by hand, then retry.` };
    case "other_recipient":
      return { ok: false, code: "extension_error", message: `A reply opened, but its recipients do not show ${from}. Nothing was typed; discard the empty reply.` };
    case "no_compose":
      return { ok: false, code: "extension_error", message: "Gmail opened no compose window. Check the Gmail tab and retry." };
    case "no_attach_button":
    case "no_file_input":
      return { ok: false, code: "extension_error", message: `The draft is open with its text, but Gmail's attach control was not found (${result.kind}). Attach the files by hand.` };
    default: throw new Error("Unknown Gmail compose result.");
  }
}

export async function readThread(tab: GmailTab): Promise<GmailThread | ToolResult> {
  const { account, user, ik, threadId } = tab.info;
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.tabId }, func: gmailThreadPage, args: [user, ik, threadId] });
  const result = injection?.result;
  switch (result?.kind) {
    case "thread":
      return result.messages.length ? { account, tabId: tab.tabId, threadId, subject: result.subject, messages: result.messages }
        : { ok: false, code: "tool_args_invalid", message: `Gmail of ${account} shows no message in conversation ${threadId}. A threadId belongs to one account; check both.` };
    // Gmail also answers an unknown or foreign threadId with a failed print view.
    case "extension_error":
      return { ok: false, code: "extension_error", message: `Gmail of ${account} did not return conversation ${threadId}. Check the threadId and account, or the Gmail tab, then retry.` };
    default: throw new Error("Unknown Gmail result.");
  }
}
