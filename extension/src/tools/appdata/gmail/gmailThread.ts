import type { BrowserTool } from "../../browserTool.ts";
import { conversationArgs, conversationTab, readThread } from "./gmailTabs.ts";

export const gmailThread: BrowserTool = {
  id: "appdata.gmail.thread",
  section: "appdata",
  group: "gmail",
  title: "Gmail: read the open conversation (read-only)",
  hosts: ["https://mail.google.com/*"],
  sensitive: false,
  async run(args = {}) {
    const selection = conversationArgs(args);
    if (selection === null || Object.keys(args as object).some(key => key !== "account" && key !== "tabId" && key !== "threadId"))
      return { ok: false, code: "tool_args_invalid", message: "Use no --args, or --args with account (the Gmail address whose open conversation to read), tabId (a Gmail tab from page.tabs) and threadId (from appdata.gmail.search, beside account or tabId)." };
    try {
      const tab = await conversationTab(selection);
      if ("ok" in tab)
        return tab;
      const thread = await readThread(tab);
      return "ok" in thread ? thread : { ok: true, value: thread };
    } catch {
      return { ok: false, code: "extension_error", message: "Could not read Gmail. Check the open Gmail tab and retry, or reload the extension." };
    }
  },
};
