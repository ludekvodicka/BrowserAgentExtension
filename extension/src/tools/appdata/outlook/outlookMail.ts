import { isRecord } from "../../../../../shared/protocol.ts";
import type { BrowserTool } from "../../browserTool.ts";
import { outlookMailPage } from "./outlookMailPage.ts";

const hookFile = "hooks/outlookHook.js";
const listFields = "Id,ConversationId,ReceivedDateTime,From,ToRecipients,Subject,BodyPreview,IsRead,HasAttachments,Importance";
const messageFields = "Id,ConversationId,ReceivedDateTime,SentDateTime,From,ToRecipients,CcRecipients,ReplyTo,Subject,Body,IsRead,HasAttachments,Importance,WebLink";
const folderFields = "Id,DisplayName,ParentFolderId,ChildFolderCount,UnreadItemCount,TotalItemCount";
const idPattern = /^[A-Za-z0-9_=+-]{1,600}$/;

type Params = Record<string, unknown>;
const optional = (value: unknown, check: (value: unknown) => boolean) => value === undefined || check(value);
const isId = (value: unknown) => typeof value === "string" && idPattern.test(value);
const isCount = (max: number) => (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

function query(entries: Record<string, string | undefined>): string {
  return Object.entries(entries).filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(value!)}`).join("&");
}

// Builds the only Outlook REST paths the tool reads; anything else is refused before a tab is touched.
export function outlookMailPath(method: unknown, params: Params): string | null {
  if (method === "folders.list") {
    if (!optional(params.parent, isId))
      return null;
    const base = params.parent ? `/api/v2.0/me/mailfolders/${encodeURIComponent(params.parent as string)}/childfolders` : "/api/v2.0/me/mailfolders";
    return `${base}?${query({ $top: "100", $select: folderFields })}`;
  } else if (method === "messages.list") {
    const since = params.since === undefined ? undefined : typeof params.since === "string" ? new Date(params.since) : null;
    if (!isId(params.folder) || since === null || (since && Number.isNaN(since.getTime())) || !optional(params.top, isCount(100))
      || !optional(params.skip, isCount(100_000)) || !optional(params.unreadOnly, value => typeof value === "boolean"))
      return null;
    const filter = [since && `ReceivedDateTime ge ${since.toISOString()}`, params.unreadOnly && "IsRead eq false"].filter(Boolean).join(" and ");
    return `/api/v2.0/me/mailfolders/${encodeURIComponent(params.folder as string)}/messages?${query({
      $top: String(params.top || 25), $skip: params.skip ? String(params.skip) : undefined,
      $orderby: "ReceivedDateTime desc", $select: listFields, $filter: filter || undefined })}`;
  } else if (method === "messages.get") {
    return isId(params.id) ? `/api/v2.0/me/messages/${encodeURIComponent(params.id as string)}?${query({ $select: messageFields })}` : null;
  } else return null;
}

export const outlookMail: BrowserTool = {
  id: "appdata.outlook.mail",
  section: "appdata",
  group: "outlook",
  title: "Outlook: read mail (read-only)",
  hosts: ["https://outlook.cloud.microsoft/*"],
  sensitive: false,
  pageScripts: [{ id: "outlook-hook", file: hookFile, matches: ["https://outlook.cloud.microsoft/*"] }],
  async run(args) {
    const path = isRecord(args) && isRecord(args.params ?? {}) ? outlookMailPath(args.method, (args.params ?? {}) as Params) : null;
    if (!path)
      return { ok: false, code: "tool_args_invalid",
        message: "Use --args with method folders.list (optional parent), messages.list (folder, optional since, top up to 100, skip, unreadOnly) or messages.get (id)." };
    try {
      const [tab] = await chrome.tabs.query({ url: "https://outlook.cloud.microsoft/*", discarded: false });
      if (tab?.id === undefined)
        return { ok: false, code: "tab_missing", message: "Open Outlook mail at outlook.cloud.microsoft in this browser profile, then request the tool again." };
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: outlookMailPage, args: [path] });
      const result = injection?.result;
      if (!result)
        throw new Error("Missing Outlook result.");
      switch (result.kind) {
        case "hook_missing":
          // The tab was open before the tool was enabled; from now on it sees the page's next request.
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", files: [hookFile] });
          return { ok: false, code: "tab_not_ready", message: "Open any message in the Outlook tab (or reload it), then request the tool again." };
        case "not_ready":
          return { ok: false, code: "tab_not_ready", message: "Open any message in the Outlook tab so Outlook renews its session, then request the tool again." };
        case "response":
          return { ok: true, value: { status: result.status, body: result.body } };
        case "extension_error":
          throw new Error("Outlook request failed.");
        default: throw new Error("Unknown Outlook result.");
      }
    } catch {
      return { ok: false, code: "extension_error", message: "Could not read Outlook. Check the open Outlook tab and retry, or reload the extension." };
    }
  },
};
