export type MeetingProvider = "googleMeet" | "zoom" | "teams";
export type Meeting = { key: string; title: string; tabId: number; windowId: number; audible: boolean; lastAccessed: number };

export function meetingKey(provider: MeetingProvider, address: string): string | null {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "https:")
    return null;
  let matches: boolean;
  let route = url.pathname;
  if (provider === "googleMeet")
    matches = url.hostname === "meet.google.com" && /^\/(meet\/)?[a-z]{3}-[a-z]{4}-[a-z]{3}(\/|$)/i.test(route);
  else if (provider === "zoom")
    matches = url.hostname.endsWith(".zoom.us") && route.startsWith("/wc/");
  else if (provider === "teams") {
    route += url.hash;
    matches = ["teams.microsoft.com", "teams.cloud.microsoft"].includes(url.hostname) && /\/(meetup-join|meet|call)\b/i.test(route);
  } else throw new Error("Unknown meeting provider.");
  return matches ? (url.host + route).slice(0, 300) : null;
}

export function meetingsFromTabs(provider: MeetingProvider,
  tabs: (Pick<chrome.tabs.Tab, "windowId"> & Partial<Pick<chrome.tabs.Tab, "url" | "title" | "id" | "audible" | "lastAccessed">>)[]): Meeting[] {
  return tabs.flatMap(tab => {
    const key = meetingKey(provider, tab.url ?? "");
    return key !== null && tab.id !== undefined ? [{ key, title: (tab.title ?? "").slice(0, 300),
      tabId: tab.id, windowId: tab.windowId, audible: tab.audible ?? false, lastAccessed: tab.lastAccessed ?? 0 }] : [];
  });
}
