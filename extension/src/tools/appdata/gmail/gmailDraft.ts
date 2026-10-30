import type { BrowserTool } from "../../browserTool.ts";
import { accountArgs, accountTabs, addressPattern, fillCompose } from "./gmailTabs.ts";

const recipientFields = ["to", "cc", "bcc"] as const;
const allowedKeys = new Set<string>(["account", ...recipientFields, "subject", "body"]);
// Gmail reads the compose fields from the URL; a longer one fails on Google's side.
const maxUrlLength = 8_000;

const isRecipients = (value: unknown) => value === undefined || Array.isArray(value) && value.length <= 50
  && value.every(address => typeof address === "string" && addressPattern.test(address));

const loaded = async (tabId: number) => {
  for (const end = Date.now() + 8000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 200)))
    if ((await chrome.tabs.get(tabId)).status === "complete")
      return true;
  return false;
};

// Opens Gmail's own compose page with the fields filled in; Gmail saves it as a draft. Files go through the compose
// window's file input; nothing here presses a key or the send button.
export const gmailDraft: BrowserTool = {
  id: "appdata.gmail.draft",
  section: "appdata",
  group: "gmail",
  title: "Gmail: open a new draft (never sends)",
  hosts: ["https://mail.google.com/*"],
  sensitive: false,
  acceptsFiles: true,
  async run(args = {}, files = []) {
    const account = accountArgs(args);
    const fields = args as Record<string, unknown>;
    if (account === null || Object.keys(fields).some(key => !allowedKeys.has(key)) || !recipientFields.every(field => isRecipients(fields[field]))
      || !(fields.subject === undefined || typeof fields.subject === "string" && fields.subject.length <= 500 && !/[\r\n]/.test(fields.subject))
      || !(fields.body === undefined || typeof fields.body === "string"))
      return { ok: false, code: "tool_args_invalid", message: "Use --args with optional account, to, cc, bcc (arrays of addresses), subject (one line) and body (plain text)." };
    try {
      const tabs = await accountTabs(account);
      if ("ok" in tabs)
        return tabs;
      const [tab] = tabs;
      const query = new URLSearchParams({ view: "cm", fs: "1" });
      for (const field of recipientFields)
        if ((fields[field] as string[] | undefined)?.length)
          query.set(field, (fields[field] as string[]).join(","));
      if (fields.subject)
        query.set("su", fields.subject as string);
      if (fields.body)
        query.set("body", fields.body as string);
      const url = `https://mail.google.com/mail/u/${tab.info.user}/?${query.toString().replaceAll("+", "%20")}`;
      if (url.length > maxUrlLength)
        return { ok: false, code: "tool_args_invalid", message: `The draft is too long for Gmail's compose link (${url.length} of ${maxUrlLength} URL characters); shorten the body.` };
      const compose = await chrome.tabs.create({ windowId: tab.windowId, index: tab.index + 1, url, active: true });
      let attached: { name: string; shown: boolean }[] = [];
      if (files.length) {
        if (compose.id === undefined || !await loaded(compose.id))
          return { ok: false, code: "extension_error", message: "The draft tab did not finish loading; attach the files by hand." };
        const result = await fillCompose(compose.id, null, null, files);
        if ("ok" in result)
          return result;
        attached = result;
      }
      return { ok: true, value: { account: tab.info.account, to: fields.to ?? [], cc: fields.cc ?? [], bcc: fields.bcc ?? [], subject: fields.subject ?? "",
        bodyLength: (fields.body as string | undefined)?.length ?? 0, attached } };
    } catch {
      return { ok: false, code: "extension_error", message: "Could not open the Gmail draft. Check the open Gmail tab and retry, or reload the extension." };
    }
  },
};
