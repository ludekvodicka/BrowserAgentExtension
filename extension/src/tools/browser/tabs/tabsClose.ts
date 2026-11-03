import type { BrowserTool } from "../../browserTool.ts";
import { agentTabs } from "./agentTabs.ts";

export const tabsClose: BrowserTool = {
  id: "browser.tabs.close",
  section: "browser",
  group: "tabs",
  title: "Close a tab the agent opened",
  hosts: [],
  sensitive: false,
  async run(args) {
    const fields = typeof args === "object" && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : null;
    if (!fields || Object.keys(fields).some(key => key !== "tabId") || !Number.isSafeInteger(fields.tabId) || (fields.tabId as number) < 0)
      return { ok: false, code: "tool_args_invalid", message: "Use --args with tabId from an earlier browser.tabs.open value or a page.act newTabId." };
    const tabId = fields.tabId as number;
    try {
      if (!await agentTabs.owns(tabId))
        return { ok: false, code: "tool_denied", message: `Tab ${tabId} was not opened by an agent tool in this browser session; only such tabs can be closed.` };
      if (!await chrome.tabs.get(tabId).catch(() => null)) {
        await agentTabs.forget(tabId);
        return { ok: false, code: "tab_missing", message: `Tab ${tabId} is already closed.` };
      }
      await chrome.tabs.remove(tabId);
      await agentTabs.forget(tabId);
      return { ok: true, value: { tabId, closed: true } };
    } catch {
      return { ok: false, code: "extension_error", message: "Could not close the tab. Retry, or reload the extension." };
    }
  },
};
