import type { DebugState } from "./tools/debug/debugAccess.ts";

export async function mountDebugAccess(document: Document, container: HTMLElement, runtime: Pick<typeof chrome.runtime, "sendMessage">): Promise<void> {
  let busy = false;
  let renderedData = "";
  const message = document.getElementById("message")!;
  async function send(action: string, fields: Record<string, unknown> = {}): Promise<DebugState> {
    const result = await runtime.sendMessage({ op: "debug-access", action, ...fields });
    if (!result || result.error)
      throw new Error(result?.error || "Cannot read debug access.");
    return result as DebugState;
  }
  function button(text: string, action: () => Promise<unknown>, done: string): HTMLButtonElement {
    const node = document.createElement("button");
    node.type = "button";
    node.className = "action";
    node.textContent = text;
    node.addEventListener("click", () => {
      if (busy)
        return;
      busy = true;
      void action().then(() => { message.textContent = done; }).catch(error => {
        message.textContent = error instanceof Error ? error.message : "Could not update debug access.";
      }).finally(() => { busy = false; void refresh(); });
    });
    return node;
  }
  function paragraph(text: string, className = ""): HTMLParagraphElement {
    const node = document.createElement("p");
    node.className = className;
    node.textContent = text;
    return node;
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
    renderedData = serialized;
    container.replaceChildren(paragraph("Debug access lets the agent call this profile's extension APIs (chrome.*), "
      + "except cookies and storage: it can list, open and close tabs and windows and read their URLs. "
      + "Approve only when you asked for debugging. Access ends by itself.", "muted"));
    const request = data.request;
    if (request?.status === "pending_approval") {
      const row = document.createElement("div");
      row.className = "tool debug-request";
      const who = document.createElement("strong");
      who.textContent = `${request.caller} wants to debug this extension`;
      row.append(who, paragraph(`Reason: ${request.reason}`),
        paragraph(`The request expires at ${new Date(request.expiresAt).toLocaleTimeString()}.`, "muted"),
        button("Approve for 10 minutes", () => send("approve", { id: request.id, minutes: 10 }), "Debug access approved for 10 minutes."), " ",
        button("Approve for 1 hour", () => send("approve", { id: request.id, minutes: 60 }), "Debug access approved for 1 hour."), " ",
        button("Deny", () => send("deny", { id: request.id }), "Debug request denied."));
      container.append(row);
    }
    if (data.grant) {
      const row = document.createElement("div");
      row.className = "tool debug-grant";
      const state = document.createElement("strong");
      state.className = "ok";
      state.textContent = `Debug access is on until ${new Date(data.grant.until).toLocaleTimeString()}.`;
      row.append(state, paragraph(`${data.grant.caller}: ${data.grant.reason}`, "muted"),
        button("Stop now", () => send("revoke"), "Debug access stopped."));
      container.append(row);
    } else if (request?.status !== "pending_approval")
      container.append(paragraph(request ? `Debug access is off. Last request: ${request.status}.` : "Debug access is off."));
  }
  await refresh();
  if (container.querySelector(".debug-request"))
    document.querySelector<HTMLButtonElement>('[data-tab="group-debug-console"]')?.click();
  const timer = document.defaultView?.setInterval(() => void refresh().catch(() => {}), 1000);
  document.defaultView?.addEventListener("pagehide", () => document.defaultView?.clearInterval(timer), { once: true });
}
