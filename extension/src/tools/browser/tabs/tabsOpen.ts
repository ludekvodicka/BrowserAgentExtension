import type { BrowserTool } from "../../browserTool.ts";

const webUrl = (value: unknown) => {
  if (typeof value !== "string")
    return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
};

export const tabsOpen: BrowserTool = {
  id: "browser.tabs.open",
  section: "browser",
  group: "tabs",
  title: "Open a web page in a new tab",
  hosts: [],
  sensitive: false,
  async run(args) {
    const fields = typeof args === "object" && args !== null && !Array.isArray(args) ? args as Record<string, unknown> : null;
    const url = webUrl(fields?.url);
    if (!fields || !url || Object.keys(fields).some(key => key !== "url" && key !== "windowId")
      || !(fields.windowId === undefined || Number.isSafeInteger(fields.windowId) && (fields.windowId as number) >= 0))
      return { ok: false, code: "tool_args_invalid", message: "Use --args with url (http or https) and optional windowId from an earlier browser.tabs.open value." };
    const windowId = fields.windowId as number | undefined;
    try {
      if (windowId !== undefined && (await chrome.windows.get(windowId).catch(() => null))?.type !== "normal")
        return { ok: false, code: "tool_args_invalid", message: `This browser profile has no window ${windowId}; omit windowId to use the window the user used last.` };
      const tab = await chrome.tabs.create({ url, active: true, ...(windowId === undefined ? {} : { windowId }) });
      return { ok: true, value: { tabId: tab.id, windowId: tab.windowId, url } };
    } catch {
      return { ok: false, code: "extension_error", message: "Could not open the tab. Retry, or reload the extension." };
    }
  },
};
