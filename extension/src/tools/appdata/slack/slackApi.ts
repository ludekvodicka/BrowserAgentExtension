import { isRecord } from "../../../../../shared/protocol.ts";
import type { BrowserTool } from "../../browserTool.ts";
import { slackApiPage } from "./slackApiPage.ts";

const methods = ["conversations.history", "conversations.replies", "conversations.info", "users.info", "users.conversations"] as const;
export type SlackReadMethod = typeof methods[number];
export type SlackApiArgs = { teamId: string; method: SlackReadMethod; params: Record<string, string | number | boolean> };
export type SlackApiValue = Record<string, unknown> & { ok: boolean; error?: string; retryAfter?: number };

function validArgs(args: unknown): args is SlackApiArgs {
  return isRecord(args) && typeof args.teamId === "string" && /^T[A-Z0-9]+$/.test(args.teamId)
    && methods.some(method => method === args.method) && isRecord(args.params)
    && Object.values(args.params).every(value => typeof value === "string" || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value)));
}

export const slackApi: BrowserTool = {
  id: "appdata.slack.api",
  section: "appdata",
  group: "slack",
  title: "Slack: read workspace data (read-only)",
  hosts: ["https://*.slack.com/*"],
  sensitive: false,
  async run(args) {
    if (!validArgs(args))
      return { ok: false, code: "tool_args_invalid",
        message: "Use --args with a teamId (T followed by uppercase letters/digits), an allowed Slack read method, and flat string/number/boolean params." };
    try {
      const [tab] = await chrome.tabs.query({ url: "https://app.slack.com/*", discarded: false });
      if (tab?.id === undefined)
        return { ok: false, code: "tab_missing", message: "Open app.slack.com in this browser profile, then request the tool again." };
      const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "ISOLATED",
        func: slackApiPage, args: [args.teamId, args.method, args.params] });
      const result = injection?.result;
      if (!result)
        throw new Error("Missing Slack result.");
      switch (result.kind) {
        case "not_signed_in":
          return { ok: false, code: "not_signed_in", message: "Sign in to the requested Slack workspace at app.slack.com in this browser profile." };
        case "response":
          return { ok: true, value: { ...result.body, ...(result.retryAfter === undefined ? {} : { retryAfter: result.retryAfter }) } };
        case "extension_error":
          throw new Error("Slack request failed.");
        default: throw new Error("Unknown Slack result.");
      }
    } catch {
      return { ok: false, code: "extension_error", message: "Could not read Slack. Check the open app.slack.com tab and retry, or reload the extension." };
    }
  },
};
