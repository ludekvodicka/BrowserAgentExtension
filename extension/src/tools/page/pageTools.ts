import { isRecord } from "../../../../shared/protocol.ts";
import type { BrowserTool, ToolFailure, ToolResult } from "../browserTool.ts";
import { formGuard } from "./formGuard.ts";
import { pageDocument } from "./pageDocument.ts";
import type { PageAction, PageCommand, PageLocator } from "./pageDocument.ts";
import { openApproval, siteAccess, SiteCapacityError, webOrigin } from "./siteAccess.ts";

const invalid = (message: string): ToolFailure => ({ ok: false, code: "tool_args_invalid", message });
const missing = (message: string): ToolFailure => ({ ok: false, code: "tab_not_ready", message });
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const snapshots = new Map<number, { generation: string; url: string; frames: { frameId: number; documentId: string; origin: string }[] }>();
const busy = new Set<number>();

export function forgetPageTab(tabId: number): void {
  snapshots.delete(tabId);
}

async function tabFor(args: unknown): Promise<{ tab: chrome.tabs.Tab; origin: string } | ToolFailure> {
  if (!isRecord(args) || !integer(args.tabId))
    return invalid("Use --args with a tabId from page.tabs.");
  const tab = await chrome.tabs.get(args.tabId as number).catch(() => null);
  if (!tab)
    return { ok: false, code: "tab_missing", message: "The requested tab is closed. Use page.tabs again." };
  const origin = webOrigin(tab.url);
  if (!origin)
    return { ok: false, code: "permission_missing", message: "This tab has no accessible web URL. Use page.requestAccess with its http(s) URL." };
  const refused = await siteAccess.check(origin);
  if (refused)
    return refused;
  if (tab.discarded || tab.status !== "complete")
    return missing("The tab is still loading or discarded. Let the user open it, then retry.");
  return { tab, origin };
}

async function checkTab(args: unknown): Promise<ToolFailure | void> {
  const result = await tabFor(args);
  if ("ok" in result)
    return result;
}

function locatorFrom(args: Record<string, unknown>): PageLocator | ToolFailure | undefined {
  const fields = [args.ref, args.selector, args.role].filter(value => value !== undefined);
  if (!fields.length)
    return args.name === undefined ? undefined : invalid("A name requires a role.");
  if (fields.length !== 1 || fields.some(value => typeof value !== "string" || !value || value.length > 1000)
    || args.role !== undefined && (typeof args.name !== "string" || args.name.length > 300)
    || args.name !== undefined && args.role === undefined)
    return invalid("Use exactly one ref, CSS selector, or role with an exact accessible name.");
  if (args.ref !== undefined)
    return { ref: args.ref as string };
  if (args.selector !== undefined)
    return { selector: args.selector as string };
  if (args.role !== undefined)
    return { role: args.role as string, name: args.name as string };
  else throw new Error("Unknown locator.");
}

function commandFrom(operation: "snapshot" | "read" | "act", args: Record<string, unknown>): PageCommand | ToolFailure {
  const allowed = ["tabId", "frameId", "ref", "selector", "role", "name", ...(operation === "snapshot" ? ["limit"]
    : operation === "read" ? ["limit", "format"] : ["action", "text", "values", "checked", "key", "x", "y"])];
  if (Object.keys(args).some(key => !allowed.includes(key)) || args.frameId !== undefined && !integer(args.frameId))
    return invalid("Unknown argument or invalid frameId. Use the page tool's documented arguments.");
  const locator = locatorFrom(args);
  if (locator && "ok" in locator)
    return locator;
  const max = operation === "snapshot" ? 300 : 100_000;
  const limit = args.limit ?? (operation === "snapshot" ? 100 : 20_000);
  if (!integer(limit) || (limit as number) < 1 || (limit as number) > max)
    return invalid(`limit must be an integer between 1 and ${max}.`);
  const command: PageCommand = { operation, origins: [], generation: "", limit: limit as number, locator };
  if (operation === "snapshot") {
    if (locator || args.frameId !== undefined)
      return invalid("Snapshot takes tabId and limit only; its refs identify their frames.");
  } else if (operation === "read") {
    if (args.format !== undefined && args.format !== "text" && args.format !== "html")
      return invalid("Read format must be text or html.");
    command.format = args.format as "text" | "html" | undefined;
  } else if (operation === "act") {
    if (!locator && args.action !== "scroll")
      return invalid("This action needs a ref, selector, or role and name.");
    command.action = args.action as PageAction;
    switch (command.action) {
      case "fill": case "type":
        if (typeof args.text !== "string" || args.text.length > 100_000)
          return invalid("fill/type requires text, at most 100,000 characters.");
        command.text = args.text;
        break;
      case "select":
        if (!Array.isArray(args.values) || args.values.length > 100 || args.values.some(value => typeof value !== "string" || value.length > 1000))
          return invalid("select requires values: an array of option values.");
        command.values = args.values;
        break;
      case "check":
        if (typeof args.checked !== "boolean")
          return invalid("check requires checked:true or checked:false.");
        command.checked = args.checked;
        break;
      case "press":
        if (typeof args.key !== "string" || !/^(?:(?:Control|Meta|Alt|Shift)\+)*(?:Enter|Tab|Escape|Backspace|Delete|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|[^+])$/.test(args.key))
          return invalid("press requires a key such as Enter, Escape, Tab or Control+a.");
        command.key = args.key;
        break;
      case "scroll":
        if (args.x === undefined && args.y === undefined || [args.x ?? 0, args.y ?? 0].some(value => typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 100_000))
          return invalid("scroll requires finite x/y offsets, at most 100,000 pixels.");
        command.x = args.x as number | undefined;
        command.y = args.y as number | undefined;
        break;
      case "click": case "hover": case "submit": break;
      default: return invalid("Unknown action. Use click, fill, type, select, check, press, scroll or hover. Submission stays with the user.");
    }
  } else throw new Error("Unknown page operation.");
  return command;
}

async function runDocument(operation: "snapshot" | "read" | "act", args: unknown): Promise<ToolResult> {
  if (!isRecord(args))
    return invalid("Use an argument object.");
  const command = commandFrom(operation, args);
  if ("ok" in command)
    return command;
  const selected = await tabFor(args);
  if ("ok" in selected)
    return selected;
  const { tab, origin } = selected;
  const tabId = tab.id!;
  if (busy.has(tabId))
    return missing("Another page operation is running in this tab. Wait for its result before retrying.");
  busy.add(tabId);
  try {
    if (operation === "snapshot") {
      command.generation = crypto.randomUUID();
      command.origins = await siteAccess.allowed();
      snapshots.delete(tabId);
      const results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pageDocument, args: [command] });
      if (!results.some(result => result.frameId === 0 && result.result?.ok))
        return missing("The main page changed or could not be read. Take another snapshot.");
      const frames: { frameId: number; documentId: string; origin: string }[] = [];
      const elements = [];
      let truncated = false;
      for (const injection of results.sort((a, b) => a.frameId - b.frameId)) {
        const result = injection.result;
        if (!result?.ok)
          continue;
        frames.push({ frameId: injection.frameId, documentId: injection.documentId, origin: result.origin! });
        for (const element of result.elements ?? [])
          if (elements.length < command.limit)
            elements.push({ ...element, ref: `${command.generation}.${injection.frameId}.${element.ref}`, frameId: injection.frameId });
          else truncated = true;
        truncated ||= result.truncated === true;
      }
      snapshots.set(tabId, { generation: command.generation, url: tab.url!, frames });
      return { ok: true, value: { status: "snapshot", tabId, url: tab.url!.slice(0, 2000), title: (tab.title ?? "").slice(0, 300),
        generation: command.generation, frames: frames.map(({ frameId, origin }) => ({ frameId, origin })), elements, truncated } };
    }
    const snapshot = snapshots.get(tabId);
    let frameId = (args.frameId as number | undefined) ?? 0;
    if (command.locator?.ref) {
      const parts = /^([a-f0-9-]{36})\.(\d+)\.(e\d+)$/.exec(command.locator.ref);
      if (!parts || !snapshot || snapshot.generation !== parts[1] || snapshot.url !== tab.url)
        return missing("Stale element ref. Take a new page.snapshot.");
      if (args.frameId !== undefined && frameId !== Number(parts[2]))
        return invalid("frameId disagrees with the ref's frame.");
      frameId = Number(parts[2]);
      command.generation = parts[1];
      command.locator = { ref: parts[3] };
    }
    const frame = snapshot?.frames.find(frame => frame.frameId === frameId);
    if (frameId !== 0 && !frame)
      return missing("Take a snapshot to select a granted frame first.");
    const frameOrigin = frameId === 0 ? origin : frame!.origin;
    const denied = await siteAccess.check(frameOrigin);
    if (denied)
      return denied;
    command.origins = [frameOrigin];
    const target = frame && (command.locator?.ref || frameId !== 0) ? { tabId, documentIds: [frame.documentId] } : { tabId, frameIds: [0] };
    const guardId = crypto.randomUUID();
    if (operation === "act") {
      const [guard] = await chrome.scripting.executeScript({ target, world: "MAIN", func: formGuard, args: ["start", guardId, frameOrigin] });
      if (!guard?.result)
        return missing("Could not install the form submission guard; no action ran.");
    }
    let result;
    let blocked = false;
    try {
      [result] = await chrome.scripting.executeScript({ target, func: pageDocument, args: [command] });
    } finally {
      if (operation === "act") {
        const [guard] = await chrome.scripting.executeScript({ target, world: "MAIN", func: formGuard, args: ["finish", guardId, frameOrigin] }).catch(() => []);
        blocked = guard?.result === true;
      }
    }
    if (blocked)
      return { ok: false, code: "tool_denied", message: "The page tried to submit a form. Submission was blocked and outlined; the user must submit." };
    if (!result?.result)
      return missing("The document changed during the operation. Inspect it before trying again.");
    if (!result.result.ok)
      return result.result;
    return { ok: true, value: { ...result.result, tabId, frameId } };
  } catch {
    return missing("The page or its permission changed, or scripting is unavailable. Inspect the page before retrying an action.");
  } finally {
    busy.delete(tabId);
  }
}

const metadata = { section: "page", group: "control", hosts: [], sensitive: false };

export const pageTools: BrowserTool[] = [
  { ...metadata, id: "page.tabs", title: "List tabs on approved sites", async run(args) {
    if (args !== undefined && (!isRecord(args) || Object.keys(args).length))
      return invalid("page.tabs takes no arguments.");
    const origins = await siteAccess.allowed();
    const tabs = (await chrome.tabs.query({})).filter(tab => tab.id !== undefined && origins.includes(webOrigin(tab.url) ?? ""));
    return { ok: true, value: { tabs: tabs.map(tab => ({ tabId: tab.id, windowId: tab.windowId, url: tab.url!.slice(0, 2000), title: (tab.title ?? "").slice(0, 300), active: tab.active })) } };
  } },
  ...(["requestAccess", "accessStatus"] as const).map((operation): BrowserTool => ({ ...metadata, id: `page.${operation}`,
    title: operation === "requestAccess" ? "Request access to a site" : "Check site approval status", async run(args, _files, context) {
      if (!isRecord(args) || Object.keys(args).some(key => !["url", "tabId", ...(operation === "requestAccess" ? ["retry"] : [])].includes(key))
        || (args.url === undefined) === (args.tabId === undefined) || args.tabId !== undefined && !integer(args.tabId)
        || args.retry !== undefined && typeof args.retry !== "boolean")
        return invalid("Supply exactly one http(s) url or tabId; requestAccess also accepts retry:true after a denial or expiry.");
      const url = args.tabId === undefined ? args.url : (await chrome.tabs.get(args.tabId as number).catch(() => null))?.url;
      const origin = webOrigin(url);
      if (!origin)
        return invalid("The tab URL is unavailable. Supply its explicit http(s) URL without credentials.");
      if (operation === "accessStatus") {
        const site = (await siteAccess.read()).find(site => site.origin === origin);
        await siteAccess.badge();
        if (site?.status === "approved" && await siteAccess.check(origin))
          return { ok: true, value: { origin, status: "permission_missing" } };
        return { ok: true, value: site ?? { origin, status: "not_requested" } };
      } else if (operation === "requestAccess") {
        const site = await siteAccess.request(origin, context?.caller ?? "agent", args.retry === true).catch(error => {
          if (error instanceof SiteCapacityError)
            return { ok: false, code: "tool_denied", message: error.message } as const;
          throw error;
        });
        if ("ok" in site)
          return site;
        if (site.status === "pending_approval")
          void openApproval().catch(() => {});
        return { ok: true, value: site };
      } else throw new Error("Unknown access operation.");
    } })),
  ...(["snapshot", "read", "act"] as const).map((operation): BrowserTool => ({ ...metadata, id: `page.${operation}`,
    title: { snapshot: "Inspect page elements", read: "Read page text or HTML", act: "Prepare work on the page" }[operation],
    checkAccess: checkTab, run: args => runDocument(operation, args) })),
  { ...metadata, id: "page.screenshot", title: "Capture the visible page (file only)", sensitive: true, checkAccess: checkTab, async run(args) {
    if (!isRecord(args) || Object.keys(args).some(key => key !== "tabId" && key !== "quality")
      || args.quality !== undefined && (!integer(args.quality) || (args.quality as number) < 1 || (args.quality as number) > 100))
      return invalid("Screenshot takes tabId and optional JPEG quality from 1 to 100. Use CLI --out <file>.");
    const selected = await tabFor(args);
    if ("ok" in selected)
      return selected;
    const { tab } = selected;
    const current = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
    if (!tab.active || current?.id !== tab.id)
      return missing("The requested tab must be active in its window. Ask the user to select it.");
    let dataUrl: string;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: (args.quality as number | undefined) ?? 60 });
    } catch {
      return { ok: false, code: "permission_missing", message: "Chrome needs an activeTab grant to capture this page. Click the extension icon on this tab, then retry." };
    }
    const after = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
    if (after?.id !== tab.id || after.url !== tab.url || await siteAccess.check(selected.origin))
      return missing("The active page or its grant changed during capture. The image was discarded.");
    if (dataUrl.length > 800_000)
      return { ok: false, code: "result_too_large", message: "The screenshot exceeds the response cap. Retry with a lower quality." };
    return { ok: true, value: { status: "captured", tabId: tab.id, mimeType: "image/jpeg", dataUrl } };
  } },
];
