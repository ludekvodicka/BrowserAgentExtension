import type { ToolFailure } from "../browserTool.ts";

export type SiteRequest = { origin: string; id: string; caller: string; requestedAt: number; expiresAt: number;
  status: "pending_approval" | "approved" | "denied" | "expired"; approving?: boolean };

export class SiteCapacityError extends Error {
  constructor() {
    super("Remove old requests or granted sites in Page control before adding more (100-site limit).");
  }
}

export function webOrigin(value: unknown): string | null {
  if (typeof value !== "string")
    return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.origin : null;
  } catch {
    return null;
  }
}

// Chrome host patterns do not distinguish ports; the stored origin gate does.
export const hostPattern = (origin: string) => {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
};

export class SiteAccess {
  private queue: Promise<unknown>;

  constructor() {
    this.queue = Promise.resolve();
  }

  private change<T>(update: (sites: SiteRequest[]) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const sites = await this.read();
      const value = await update(sites);
      await chrome.storage.local.set({ pageSites: sites });
      await this.badge(sites);
      return value;
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async read(): Promise<SiteRequest[]> {
    const { pageSites } = await chrome.storage.local.get("pageSites");
    return (Array.isArray(pageSites) ? pageSites as SiteRequest[] : []).map(site =>
      site.status === "pending_approval" && site.expiresAt <= Date.now() ? { ...site, status: "expired", approving: false } : site);
  }

  async allowed(): Promise<string[]> {
    const sites = await this.read();
    const allowed: string[] = [];
    for (const site of sites)
      if (site.status === "approved" && await chrome.permissions.contains({ origins: [hostPattern(site.origin)] }))
        allowed.push(site.origin);
    return allowed;
  }

  async check(origin: string): Promise<ToolFailure | void> {
    if (!(await this.read()).some(site => site.origin === origin && site.status === "approved"))
      return { ok: false, code: "permission_missing", message: `Page control has no grant for ${origin}. Use page.requestAccess with this URL and wait for the user to approve.` };
    if (!await chrome.permissions.contains({ origins: [hostPattern(origin)] }))
      return { ok: false, code: "permission_missing", message: `Browser permission for ${origin} is missing. Approve the site again in Page control.` };
  }

  request(origin: string, caller: string, retry: boolean): Promise<SiteRequest> {
    return this.change(async sites => {
      const existing = sites.find(site => site.origin === origin);
      if (existing && (existing.status === "pending_approval" || existing.status === "approved" && !await this.check(origin)
        || !retry && (existing.status === "denied" || existing.status === "expired")))
        return existing;
      const request: SiteRequest = { origin, caller, id: crypto.randomUUID(), requestedAt: Date.now(), expiresAt: Date.now() + 600_000, status: "pending_approval" };
      if (existing)
        sites.splice(sites.indexOf(existing), 1, request);
      else {
        if (sites.length >= 100)
          throw new SiteCapacityError();
        sites.push(request);
      }
      return request;
    });
  }

  beginApproval(origin: string, id: string | null): Promise<void> {
    return this.change(async sites => {
      let site = sites.find(item => item.origin === origin);
      if (id !== null && (!site || site.id !== id || site.status !== "pending_approval"))
        throw new Error("This request expired or was replaced. Reopen Page control.");
      if (id === null) {
        site = { origin, id: crypto.randomUUID(), caller: "user", requestedAt: Date.now(), expiresAt: Date.now() + 600_000, status: "pending_approval" };
        const index = sites.findIndex(item => item.origin === origin);
        if (index >= 0)
          sites.splice(index, 1, site);
        else {
          if (sites.length >= 100)
            throw new SiteCapacityError();
          sites.push(site);
        }
      }
      site!.approving = true;
    }).then(() => this.completeApprovals());
  }

  completeApprovals(): Promise<void> {
    return this.change(async sites => {
      for (const site of sites)
        if (site.status === "pending_approval" && site.approving && await chrome.permissions.contains({ origins: [hostPattern(site.origin)] })) {
          site.status = "approved";
          site.approving = false;
        }
    });
  }

  deny(origin: string, id: string): Promise<void> {
    return this.change(async sites => {
      const site = sites.find(item => item.origin === origin && item.id === id);
      if (site?.status === "pending_approval") {
        site.status = "denied";
        site.approving = false;
      }
    });
  }

  remove(origin: string): Promise<void> {
    return this.change(async sites => {
      const index = sites.findIndex(item => item.origin === origin);
      if (index >= 0)
        sites.splice(index, 1);
    });
  }

  async badge(sites?: SiteRequest[]): Promise<void> {
    const pending = (sites ?? await this.read()).some(site => site.status === "pending_approval");
    if (pending)
      await chrome.action.setBadgeText({ text: "?" });
    else if (await chrome.action.getBadgeText({}) === "?")
      await chrome.action.setBadgeText({ text: "" });
  }
}

export const siteAccess = new SiteAccess();

export async function openApproval(): Promise<void> {
  try {
    await chrome.action.openPopup();
  } catch {
    const url = chrome.runtime.getURL("approval.html");
    const existing = (await chrome.tabs.query({})).find(tab => tab.url === url);
    if (existing?.id !== undefined)
      await chrome.tabs.update(existing.id, { active: true });
    else await chrome.tabs.create({ url, active: true });
  }
}
