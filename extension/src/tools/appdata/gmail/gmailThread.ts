import type { BrowserTool } from "../../browserTool.ts";
import { accountArgs, openConversationTab, readThread } from "./gmailTabs.ts";

export const gmailThread: BrowserTool = {
  id: "appdata.gmail.thread",
  section: "appdata",
  group: "gmail",
  title: "Gmail: read the open conversation (read-only)",
  hosts: ["https://mail.google.com/*"],
  sensitive: false,
  async run(args = {}) {
    const account = accountArgs(args);
    if (account === null || Object.keys(args as object).some(key => key !== "account"))
      return { ok: false, code: "tool_args_invalid", message: "Use no --args, or --args with account (the Gmail address whose open conversation to read)." };
    try {
      const tab = await openConversationTab(account);
      return "ok" in tab ? tab : { ok: true, value: await readThread(tab) };
    } catch {
      return { ok: false, code: "extension_error", message: "Could not read Gmail. Check the open Gmail tab and retry, or reload the extension." };
    }
  },
};
