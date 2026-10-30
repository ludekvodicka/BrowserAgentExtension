import type { BrowserTool } from "../../browserTool.ts";
import { accountArgs, fillCompose, openConversationTab } from "./gmailTabs.ts";

const allowedKeys = new Set(["account", "body", "replyAll"]);

// Opens Gmail's own reply below the open conversation, types the body and attaches the files; Gmail saves the draft. The user sends it.
export const gmailReply: BrowserTool = {
  id: "appdata.gmail.reply",
  section: "appdata",
  group: "gmail",
  title: "Gmail: draft a reply to the open conversation (never sends)",
  hosts: ["https://mail.google.com/*"],
  sensitive: false,
  acceptsFiles: true,
  async run(args = {}, files = []) {
    const account = accountArgs(args);
    const fields = args as Record<string, unknown>;
    if (account === null || Object.keys(fields).some(key => !allowedKeys.has(key))
      || !(fields.body === undefined || typeof fields.body === "string" && fields.body.length <= 100_000)
      || !(fields.replyAll === undefined || typeof fields.replyAll === "boolean"))
      return { ok: false, code: "tool_args_invalid", message: "Use --args with optional account, body (plain text) and replyAll (true for reply to all); attach files with --file." };
    try {
      const tab = await openConversationTab(account);
      if ("ok" in tab)
        return tab;
      const attached = await fillCompose(tab.tabId, fields.replyAll ? "replyAll" : "reply", (fields.body as string | undefined) || null, files);
      if ("ok" in attached)
        return attached;
      return { ok: true, value: { account: tab.info.account, threadId: tab.info.threadId, replyAll: fields.replyAll === true,
        bodyLength: (fields.body as string | undefined)?.length ?? 0, attached } };
    } catch {
      return { ok: false, code: "extension_error", message: "Could not prepare the Gmail reply. Check the open Gmail tab and retry, or reload the extension." };
    }
  },
};
