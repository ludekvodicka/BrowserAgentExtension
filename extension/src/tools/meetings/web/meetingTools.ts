import type { BrowserTool, ToolResult } from "../../browserTool.ts";
import { meetingsFromTabs } from "./meetingRules.ts";
import type { MeetingProvider } from "./meetingRules.ts";

async function readMeetings(provider: MeetingProvider, hosts: string[]): Promise<ToolResult> {
  return { ok: true, value: { meetings: meetingsFromTabs(provider, await chrome.tabs.query({ url: hosts })) } };
}

export const googleMeet: BrowserTool = {
  id: "meetings.web.googleMeet", section: "meetings", group: "web", title: "Google Meet: list meeting tabs",
  hosts: ["https://meet.google.com/*"], sensitive: false, quiet: true,
  run: () => readMeetings("googleMeet", googleMeet.hosts),
};

export const zoom: BrowserTool = {
  id: "meetings.web.zoom", section: "meetings", group: "web", title: "Zoom: list web meeting tabs",
  hosts: ["https://*.zoom.us/*"], sensitive: false, quiet: true,
  run: () => readMeetings("zoom", zoom.hosts),
};

export const teams: BrowserTool = {
  id: "meetings.web.teams", section: "meetings", group: "web", title: "Teams: list web meeting tabs",
  hosts: ["https://teams.microsoft.com/*", "https://teams.cloud.microsoft/*"], sensitive: false, quiet: true,
  run: () => readMeetings("teams", teams.hosts),
};
