import type { BrowserTool } from "../../browserTool.ts";

export type PlaywrightCookie = { name: string; value: string; domain: string; path: string; expires: number; secure: boolean; httpOnly: boolean; sameSite: "Strict" | "Lax" | "None" };

function sameSite(value: chrome.cookies.Cookie["sameSite"]): PlaywrightCookie["sameSite"] {
  switch (value) {
    case "no_restriction": return "None";
    case "lax": return "Lax";
    case "strict": return "Strict";
    case "unspecified": return "Lax";
    default: throw new Error("Unknown cookie SameSite status.");
  }
}

export const slackCookies: BrowserTool = {
  id: "appdata.slack.cookies",
  section: "appdata",
  group: "slack",
  title: "Slack: session cookies",
  hosts: ["https://*.slack.com/*"],
  sensitive: true,
  async run() {
    const cookies = await chrome.cookies.getAll({ domain: "slack.com" });
    if (!cookies.some(cookie => cookie.name === "d"))
      return { ok: false, code: "not_signed_in", message: "Sign in to Slack in this browser profile, then request the tool again." };
    const value: PlaywrightCookie[] = cookies.map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain,
      path: cookie.path, expires: cookie.session ? -1 : cookie.expirationDate ?? -1, secure: cookie.secure,
      httpOnly: cookie.httpOnly, sameSite: sameSite(cookie.sameSite) }));
    return { ok: true, value };
  },
};
