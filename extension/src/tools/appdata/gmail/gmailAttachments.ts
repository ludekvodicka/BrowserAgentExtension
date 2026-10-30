import type { BrowserTool } from "../../browserTool.ts";
import { accountArgs, openConversationTab, readThread } from "./gmailTabs.ts";

const idPattern = /^[0-9a-f]{8,24}:[0-9.]{1,20}$/;
// The native host fails a request after 15 seconds; a download still running then is reported as such.
const waitMs = 12_000;

type Saved = { id: string; name: string; state: "complete" | "in_progress" | "interrupted"; path: string | null; bytes: number | null; error?: string };

// Gmail names come from the sender; keep them a plain file name inside the download folder.
export const safeFileName = (name: string) => name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 150) || "attachment";

async function save(url: string, filename: string, deadline: number): Promise<Omit<Saved, "id" | "name">> {
  const id = await chrome.downloads.download({ url, filename, conflictAction: "uniquify", saveAs: false });
  for (;;) {
    const [item] = await chrome.downloads.search({ id });
    if (!item)
      return { state: "interrupted", path: null, bytes: null, error: "removed" };
    else if (item.state === "complete" || item.state === "interrupted" || Date.now() >= deadline)
      return { state: item.state, path: item.filename || null, bytes: item.state === "complete" ? item.fileSize : null, ...(item.error ? { error: item.error } : {}) };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
}

export const gmailAttachments: BrowserTool = {
  id: "appdata.gmail.attachments",
  section: "appdata",
  group: "gmail",
  title: "Gmail: save attachments of the open conversation",
  hosts: ["https://mail.google.com/*"],
  sensitive: false,
  async run(args = {}) {
    const account = accountArgs(args);
    const ids = account === null ? null : (args as Record<string, unknown>).ids;
    if (account === null || Object.keys(args as object).some(key => key !== "account" && key !== "ids")
      || !(ids === undefined || Array.isArray(ids) && ids.length > 0 && ids.length <= 50 && ids.every(id => typeof id === "string" && idPattern.test(id))))
      return { ok: false, code: "tool_args_invalid", message: "Use no --args, or --args with account and ids (attachment ids from appdata.gmail.thread)." };
    try {
      const tab = await openConversationTab(account);
      if ("ok" in tab)
        return tab;
      const thread = await readThread(tab);
      const listed = thread.messages.flatMap(message => message.attachments).filter(attachment => attachment.id !== null);
      const wanted = ids === undefined ? listed : listed.filter(attachment => (ids as string[]).includes(attachment.id!));
      const missing = ids === undefined ? [] : (ids as string[]).filter(id => !listed.some(attachment => attachment.id === id));
      if (missing.length)
        return { ok: false, code: "tool_args_invalid", message: `The open conversation has no attachment ${missing.join(", ")}; read appdata.gmail.thread for its ids.` };
      const folder = `browser-agent/gmail/${thread.threadId.replace("thread-f:", "")}`;
      const deadline = Date.now() + waitMs;
      const saved: Saved[] = [];
      for (const attachment of wanted) {
        const [th, attid] = attachment.id!.split(":");
        const url = `https://mail.google.com/mail/u/${tab.info.user}/?ui=2&ik=${tab.info.ik}&view=att&th=${th}&attid=${attid}&disp=safe&zw`;
        saved.push({ id: attachment.id!, name: attachment.name, ...await save(url, `${folder}/${safeFileName(attachment.name)}`, deadline) });
      }
      return { ok: true, value: { account: thread.account, threadId: thread.threadId, subject: thread.subject, saved } };
    } catch {
      return { ok: false, code: "extension_error", message: "Could not save the Gmail attachments. Check the open Gmail tab and retry, or reload the extension." };
    }
  },
};
