import type { BrowserTool } from "../../browserTool.ts";
import { accountArgs, isTabId, namedTab } from "./gmailTabs.ts";
import { gmailSearchPage } from "./gmailSearchPage.ts";

const allowedKeys = new Set(["account", "tabId", "query", "limit"]);

// Shows a Gmail search in the tab the caller names and returns the conversations of its first result page, so a caller can read them
// with appdata.gmail.thread or save their files with appdata.gmail.attachments by threadId, without opening each one.
export const gmailSearch: BrowserTool = {
  id: "appdata.gmail.search",
  section: "appdata",
  group: "gmail",
  title: "Gmail: search conversations in a named tab (read-only)",
  hosts: ["https://mail.google.com/*"],
  sensitive: false,
  async run(args = {}) {
    const account = accountArgs(args);
    const fields = args as Record<string, unknown>;
    if (account === null || Object.keys(fields).some(key => !allowedKeys.has(key)) || !isTabId(fields.tabId)
      || typeof fields.query !== "string" || !fields.query.trim() || fields.query.length > 500 || /[\u0000-\u001f]/.test(fields.query)
      || !(fields.limit === undefined || Number.isSafeInteger(fields.limit) && (fields.limit as number) >= 1 && (fields.limit as number) <= 100))
      return { ok: false, code: "tool_args_invalid", message: "Use --args with tabId (a Gmail tab from page.tabs; the search replaces what it shows), query (Gmail search syntax, one line, up to 500 characters), and optional account and limit (1 to 100, default 50)." };
    const query = fields.query.trim();
    try {
      const tab = await namedTab(fields.tabId, account);
      if ("ok" in tab)
        return tab;
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.tabId }, func: gmailSearchPage, args: [query, (fields.limit as number | undefined) ?? 50] });
      const result = injection?.result;
      switch (result?.kind) {
        case "results":
          return { ok: true, value: { account: tab.info.account, tabId: tab.tabId, query, range: result.range, truncated: result.truncated, threads: result.threads } };
        case "timeout":
          return { ok: false, code: "tab_not_ready", message: `Gmail in tab ${tab.tabId} did not show the search results within 10 seconds. Check that tab, then retry.` };
        default: throw new Error("Unknown Gmail search result.");
      }
    } catch {
      return { ok: false, code: "extension_error", message: "Could not search Gmail. Check the Gmail tab and retry, or reload the extension." };
    }
  },
};
