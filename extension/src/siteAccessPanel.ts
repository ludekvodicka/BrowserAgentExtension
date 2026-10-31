import { hostPattern } from "./tools/page/siteAccess.ts";
import type { SiteRequest } from "./tools/page/siteAccess.ts";

export async function mountSiteAccess(document: Document, container: HTMLElement,
  runtime: Pick<typeof chrome.runtime, "sendMessage">, permissions: Pick<typeof chrome.permissions, "request">): Promise<void> {
  let busy = false;
  let renderedData = "";
  const message = document.getElementById("message")!;
  async function send(action: string, fields: Record<string, unknown> = {}) {
    const result = await runtime.sendMessage({ op: "site-access", action, ...fields });
    if (!result || result.error)
      throw new Error(result?.error || "Cannot read site access.");
    return result as { sites: SiteRequest[]; currentOrigin: string | null };
  }
  function button(text: string, action: () => Promise<unknown>): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "action";
    node.textContent = text;
    node.addEventListener("click", () => {
      if (busy)
        return;
      busy = true;
      // Invoke before the first await to retain the browser's permission-request gesture.
      void action().then(() => { message.textContent = "Site access saved."; }).catch(error => {
        message.textContent = error instanceof Error ? error.message : "Could not update site access.";
      }).finally(() => { busy = false; void refresh(); });
    });
    return node;
  }
  async function approve(origin: string, id: string | null): Promise<void> {
    const requested = permissions.request({ origins: [hostPattern(origin)] });
    const started = send("approve-start", { origin, id });
    const granted = await requested;
    const result = await started;
    if (granted)
      await send("approve-finish");
    else {
      const site = result.sites.find(site => site.origin === origin);
      if (site)
        await send("deny", { origin, id: site.id });
      throw new Error("Browser site permission was declined.");
    }
  }
  async function refresh(): Promise<void> {
    if (busy)
      return;
    const data = await send("read");
    if (busy)
      return;
    const serialized = JSON.stringify(data);
    if (serialized === renderedData)
      return;
    const historyOpen = container.querySelector("details")?.open ?? false;
    renderedData = serialized;
    container.replaceChildren();
    const info = document.createElement("p");
    info.className = "muted";
    info.textContent = "The switches below choose what the agent may do, and it may do it only on the approved sites listed here. It can press buttons that open or switch things; the final Send stays with you.";
    container.append(info);
    for (const site of data.sites.filter(site => site.status === "pending_approval")) {
      const row = document.createElement("div");
      row.className = "tool site-request";
      const origin = document.createElement("strong");
      origin.textContent = site.origin;
      const caller = document.createElement("p");
      caller.className = "muted";
      caller.textContent = `Requested by ${site.caller}. Expires ${new Date(site.expiresAt).toLocaleTimeString()}.`;
      row.append(origin, caller, button("Approve", () => approve(site.origin, site.id)), " ", button("Deny", () => send("deny", { origin: site.origin, id: site.id })));
      container.append(row);
    }
    const heading = document.createElement("h2");
    heading.textContent = "Granted sites";
    container.append(heading);
    const approved = data.sites.filter(site => site.status === "approved");
    if (!approved.length) {
      const empty = document.createElement("p");
      empty.textContent = "No sites approved.";
      container.append(empty);
    }
    for (const site of approved) {
      const row = document.createElement("div");
      row.className = "tool";
      const origin = document.createElement("p");
      origin.textContent = site.origin;
      row.append(origin, button("Remove", () => send("remove", { origin: site.origin })));
      container.append(row);
    }
    const previous = data.sites.filter(site => site.status === "denied" || site.status === "expired");
    if (previous.length) {
      const history = document.createElement("details");
      history.open = historyOpen;
      const summary = document.createElement("summary");
      summary.textContent = `Previous requests (${previous.length})`;
      history.append(summary);
      for (const site of previous) {
        const row = document.createElement("div");
        row.className = "tool";
        const text = document.createElement("p");
        text.textContent = `${site.origin}: ${site.status}`;
        row.append(text, button("Remove", () => send("remove", { origin: site.origin })));
        history.append(row);
      }
      container.append(history);
    }
    const current = document.createElement("p");
    current.className = "muted";
    current.textContent = data.currentOrigin ?? "Open the extension on a web page, or let the agent request its URL.";
    container.append(current);
    if (data.currentOrigin)
      container.append(button("Allow this site", () => approve(data.currentOrigin!, null)));
  }
  await refresh();
  if (container.querySelector(".site-request"))
    document.querySelector<HTMLButtonElement>('[data-tab="group-page-control"]')?.click();
  const timer = document.defaultView?.setInterval(() => void refresh().catch(() => {}), 1000);
  document.defaultView?.addEventListener("pagehide", () => document.defaultView?.clearInterval(timer), { once: true });
}
