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
export type GmailThread = { account: string; threadId: string; subject: string; messages: GmailMessage[] };

export const addressPattern = /^[^\s@<>,;"]+@[^\s@<>,;"]+$/;

export const accountArgs = (args: unknown): string | undefined | null => {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return null;
  const account = (args as Record<string, unknown>).account;
  return account === undefined || typeof account === "string" && addressPattern.test(account) ? account : null;
};

// The signed-in Gmail tabs of the given account when one is named, the one the user viewed last first.
export async function accountTabs(account: string | undefined): Promise<GmailAccountTab[] | ToolResult> {
  const tabs = await chrome.tabs.query({ url: "https://mail.google.com/mail/*", discarded: false });
  const read = await Promise.all(tabs.map(async ({ id, windowId, index, lastAccessed }) => {
    if (id === undefined)
      return null;
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: id }, world: "MAIN", func: gmailTabPage }).catch(() => []);
    const info = injection?.result;
    return info?.account && info.ik && info.user
      ? { tabId: id, windowId, index, lastAccessed: lastAccessed ?? 0, info: { ...info, account: info.account, ik: info.ik, user: info.user } } : null;
  }));
  const signedIn = read.filter(tab => tab !== null);
  const ofAccount = signedIn.filter(tab => account === undefined || tab.info.account.toLowerCase() === account.toLowerCase());
  if (!ofAccount.length)
    return { ok: false, code: "tab_missing", message: account === undefined ? "Open Gmail at mail.google.com in this browser profile, then request the tool again."
      : `No Gmail tab of ${account} is open in this browser profile (open accounts: ${[...new Set(signedIn.map(tab => tab.info.account))].join(", ") || "none"}).` };
  return ofAccount.sort((a, b) => b.lastAccessed - a.lastAccessed).map(({ tabId, windowId, index, info }) => ({ tabId, windowId, index, info }));
}

// Picks the Gmail tab whose open conversation the user looked at last, of the given account when one is named.
export async function openConversationTab(account: string | undefined): Promise<GmailTab | ToolResult> {
  const tabs = await accountTabs(account);
  if ("ok" in tabs)
    return tabs;
  const chosen = tabs.find(tab => tab.info.threadId);
  if (!chosen)
    return { ok: false, code: "tab_not_ready", message: `Open the conversation in Gmail (${tabs[0].info.account}), then request the tool again.` };
  return { tabId: chosen.tabId, info: { ...chosen.info, threadId: chosen.info.threadId! } };
}

// Opens a reply (or takes the tab's only compose window), types the body and attaches the files; returns the attach outcome.
export async function fillCompose(tabId: number, reply: "reply" | "replyAll" | null, body: string | null, files: ToolFile[])
  : Promise<{ name: string; shown: boolean }[] | ToolResult> {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, func: gmailComposePage, args: [reply, body, files] });
  const result = injection?.result;
  switch (result?.kind) {
    case "filled":
      return result.attached;
    case "no_reply_link":
      return { ok: false, code: "tab_not_ready", message: "Gmail shows no reply link below the open conversation. Scroll to its end or open it again, then retry." };
    case "no_compose":
      return { ok: false, code: "extension_error", message: "Gmail opened no compose window. Check the Gmail tab and retry." };
    case "no_attach_button":
    case "no_file_input":
      return { ok: false, code: "extension_error", message: `The draft is open with its text, but Gmail's attach control was not found (${result.kind}). Attach the files by hand.` };
    default: throw new Error("Unknown Gmail compose result.");
  }
}

export async function readThread(tab: GmailTab): Promise<GmailThread> {
  const { account, user, ik, threadId } = tab.info;
  const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.tabId }, func: gmailThreadPage, args: [user, ik, threadId] });
  const result = injection?.result;
  switch (result?.kind) {
    case "thread":
      return { account, threadId, subject: result.subject, messages: result.messages };
    case "extension_error":
      throw new Error("Gmail request failed.");
    default: throw new Error("Unknown Gmail result.");
  }
}
