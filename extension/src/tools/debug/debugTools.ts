import { isRecord } from "../../../../shared/protocol.ts";
import type { BrowserTool, ToolFailure } from "../browserTool.ts";
import { openApproval } from "../page/siteAccess.ts";
import { debugAccess } from "./debugAccess.ts";

const invalid = (message: string): ToolFailure => ({ ok: false, code: "tool_args_invalid", message });
// Cookies hold credentials; storage holds the extension's own grants, which the agent must never rewrite.
const blockedNamespaces = ["cookies", "storage"];
const metadata = { section: "debug", group: "console", hosts: [], sensitive: false };

export const debugRequestAccess: BrowserTool = {
  ...metadata, id: "debug.requestAccess", title: "Ask for time-limited debug access",
  async run(args, _files, context) {
    if (!isRecord(args) || Object.keys(args).some(key => !["reason", "retry"].includes(key))
      || typeof args.reason !== "string" || !args.reason.trim() || args.reason.length > 500
      || args.retry !== undefined && typeof args.retry !== "boolean")
      return invalid("Supply reason (1 to 500 characters) that tells the user why debug access is needed; optional retry:true after a denial or expiry.");
    const { status, created } = await debugAccess.request(context?.caller ?? "agent", args.reason.trim(), args.retry === true);
    if (created)
      void openApproval().catch(() => {});
    return { ok: true, value: status };
  },
};

export const debugChrome: BrowserTool = {
  ...metadata, id: "debug.chrome", title: "Call extension APIs (chrome.*) while debug access is approved",
  checkAccess: () => debugAccess.check(),
  async run(args) {
    if (!isRecord(args) || Object.keys(args).some(key => !["api", "args"].includes(key)) || typeof args.api !== "string"
      || !/^[a-z][A-Za-z0-9]*(\.[a-z][A-Za-z0-9]*)+$/.test(args.api) || args.args !== undefined && (!Array.isArray(args.args) || args.args.length > 10))
      return invalid("Supply api such as \"tabs.query\" and optional args, an array of at most 10 JSON arguments.");
    const path = args.api.split(".");
    if (blockedNamespaces.includes(path[0]))
      return invalid(`chrome.${path[0]} is not available to debug calls.`);
    let owner: unknown = chrome;
    for (const name of path.slice(0, -1))
      owner = isRecord(owner) || typeof owner === "function" ? (owner as Record<string, unknown>)[name] : undefined;
    const method = isRecord(owner) ? owner[path.at(-1)!] : undefined;
    if (typeof method !== "function")
      return invalid(`chrome.${args.api} is not a function in this profile's extension.`);
    let result: unknown;
    try {
      result = await method.apply(owner, args.args ?? []);
    } catch (error) {
      return invalid(`chrome.${args.api} failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
    }
    try {
      return { ok: true, value: { api: args.api, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) } };
    } catch {
      return invalid(`chrome.${args.api} returned a value that is not JSON.`);
    }
  },
};

export const debugTools = [debugRequestAccess, debugChrome];
