import type { BrowserTool, ToolGroup, ToolSection } from "./browserTool.ts";
import { slackCookies } from "./appdata/slack/slackCookies.ts";
import { slackApi } from "./appdata/slack/slackApi.ts";
import { outlookMail } from "./appdata/outlook/outlookMail.ts";
import { gmailThread } from "./appdata/gmail/gmailThread.ts";
import { gmailAttachments } from "./appdata/gmail/gmailAttachments.ts";
import { gmailDraft } from "./appdata/gmail/gmailDraft.ts";
import { gmailReply } from "./appdata/gmail/gmailReply.ts";
import { tabsOpen } from "./browser/tabs/tabsOpen.ts";
import { googleMeet, zoom, teams } from "./meetings/web/meetingTools.ts";
import { pageTools } from "./page/pageTools.ts";

export const sections: ToolSection[] = [{ id: "appdata", title: "App data" }, { id: "browser", title: "Browser" }, { id: "meetings", title: "Meetings" }, { id: "page", title: "Page control" }];
export const groups: ToolGroup[] = [{ section: "appdata", id: "slack", title: "Slack" }, { section: "appdata", id: "outlook", title: "Outlook" },
  { section: "appdata", id: "gmail", title: "Gmail" }, { section: "browser", id: "tabs", title: "Tabs" }, { section: "meetings", id: "web", title: "Meetings" },
  { section: "page", id: "control", title: "Page control", panel: "siteAccess", permissionNote: "Only on the approved sites above." }];
export const tools: BrowserTool[] = [slackCookies, slackApi, outlookMail, gmailThread, gmailAttachments, gmailDraft, gmailReply, tabsOpen, googleMeet, zoom, teams, ...pageTools];
