import type { ProfileInfo } from "../../shared/protocol.ts";
import type { ConnectionStatus } from "./connection.ts";
import { Grants } from "./grants.ts";
import { ProfileState } from "./profileState.ts";
import type { RequestLogEntry } from "./requestLog.ts";
import type { ToolGroup, ToolSection } from "./tools/browserTool.ts";

declare const REGISTRATION_COMMAND: string;
export type PopupData = { profile: ProfileInfo; sections: ToolSection[]; groups: ToolGroup[]; connection: ConnectionStatus; log: RequestLogEntry[] };

function renderConnection(document: Document, status: ConnectionStatus): void {
  let text: string;
  if (status.state === "connected")
    text = "Agent channel connected";
  else if (status.state === "connecting")
    text = "Connecting to native host…";
  else if (status.state === "disconnected")
    text = "Agent channel disconnected";
  else throw new Error("Unknown connection state.");
  document.getElementById("connection")!.textContent = text;
  document.getElementById("header-text")!.textContent = status.state === "connected" ? "Connected" : "Not connected";
  for (const id of ["connection-dot", "header-dot"])
    document.getElementById(id)!.classList.toggle("on", status.state === "connected");
  const error = document.getElementById("error")!;
  error.hidden = !status.error;
  error.textContent = status.error;
  document.getElementById("registration")!.hidden = status.state === "connected";
}

function formatTime(at: string): string {
  const time = new Date(at);
  return Number.isNaN(time.getTime()) ? at : time.toLocaleString();
}

export function renderSummary(document: Document, data: PopupData, agentAccess: boolean, label: string | null): void {
  document.getElementById("summary-label")!.textContent = label || "No label: set one in Access";
  const access = document.getElementById("summary-access")!;
  access.textContent = agentAccess ? "On" : "Off";
  access.className = agentAccess ? "ok" : "refused";
  const enabled = data.profile.tools.filter(tool => tool.enabled);
  document.getElementById("summary-tools")!.textContent = enabled.length
    ? `${enabled.length} of ${data.profile.tools.length}: ${enabled.map(tool => tool.title).join(", ")}`
    : `None of ${data.profile.tools.length}`;
  const last = data.log.at(-1);
  document.getElementById("summary-last")!.textContent = last ? `${formatTime(last.at)} · ${last.tool} · ${last.outcome}` : "No requests yet";
  const ok = data.log.filter(entry => entry.outcome === "ok").length;
  document.getElementById("summary-recent")!.textContent = `${ok} ok, ${data.log.length - ok} refused (last ${data.log.length})`;
}

function selectTab(document: Document, name: string): void {
  for (const tab of document.querySelectorAll<HTMLButtonElement>("#tabs [role=tab]"))
    tab.setAttribute("aria-selected", String(tab.dataset.tab === name));
  for (const panel of document.querySelectorAll<HTMLElement>("[role=tabpanel]"))
    panel.hidden = panel.id !== `tab-${name}`;
}

export function renderTools(document: Document, data: PopupData, grants: Grants, message: HTMLElement, onChange: () => void): void {
  const nav = document.getElementById("tabs")!;
  const accessTab = nav.querySelector('[data-tab="access"]')!;
  const accessPanel = document.getElementById("tab-access")!;
  for (const section of data.sections) {
    for (const group of data.groups.filter(item => item.section === section.id)) {
      const name = `group-${section.id}-${group.id}`;
      const tab = document.createElement("button");
      tab.type = "button";
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-selected", "false");
      tab.dataset.tab = name;
      tab.textContent = group.title;
      nav.insertBefore(tab, accessTab);
      const panel = document.createElement("section");
      panel.id = `tab-${name}`;
      panel.setAttribute("role", "tabpanel");
      panel.hidden = true;
      const heading = document.createElement("p");
      heading.className = "muted";
      heading.textContent = `${section.title} · ${group.title}`;
      panel.append(heading);
      for (const tool of data.profile.tools.filter(item => item.section === section.id && item.group === group.id)) {
        const row = document.createElement("div");
        row.className = "tool";
        const label = document.createElement("label");
        const toggle = document.createElement("input");
        toggle.type = "checkbox";
        toggle.checked = tool.enabled;
        toggle.dataset.tool = tool.id;
        label.append(toggle, document.createTextNode(tool.title));
        const hosts = document.createElement("p");
        hosts.className = "hosts muted";
        hosts.textContent = tool.hosts.join(", ") || "No website permission required";
        row.append(label, hosts);
        panel.append(row);
        toggle.addEventListener("change", () => {
          const desired = toggle.checked;
          const controls = document.querySelectorAll<HTMLInputElement>("[data-tool]");
          controls.forEach(control => control.disabled = true);
          void grants.setEnabled(tool.id, desired).then(enabled => {
            tool.enabled = enabled;
            toggle.checked = enabled;
            message.textContent = desired && !enabled ? "Site permission was declined. The tool remains off." : "Tool choice saved.";
            onChange();
          }).catch(() => {
            toggle.checked = false;
            message.textContent = "Could not update site access. Reopen the popup to check the saved state.";
          }).finally(() => controls.forEach(control => control.disabled = false));
        });
      }
      document.body.insertBefore(panel, accessPanel);
    }
  }
}

function renderRequests(document: Document, log: RequestLogEntry[]): void {
  const requests = document.getElementById("requests")!;
  requests.replaceChildren();
  for (const entry of [...log].reverse()) {
    const item = document.createElement("li");
    const outcome = document.createElement("span");
    outcome.className = entry.outcome === "ok" ? "ok" : "refused";
    outcome.textContent = entry.outcome;
    item.append(`${formatTime(entry.at)} · ${entry.tool} · ${entry.caller} · `, outcome);
    requests.append(item);
  }
  if (!log.length) {
    const empty = document.createElement("li");
    empty.textContent = "No requests yet.";
    requests.append(empty);
  }
}

export async function mountPopup(document: Document, runtime: Pick<typeof chrome.runtime, "sendMessage">,
  storage: Pick<typeof chrome.storage.local, "get" | "set">,
  permissions: Pick<typeof chrome.permissions, "request" | "remove" | "contains">, registrationCommand: string): Promise<void> {
  const data: PopupData = await runtime.sendMessage({ op: "popup" });
  if (!data?.profile)
    throw new Error("Cannot read the profile. Reload the extension.");
  const state = new ProfileState(storage);
  const label = document.getElementById("profile-label") as HTMLInputElement;
  const access = document.getElementById("agent-access") as HTMLInputElement;
  const message = document.getElementById("message")!;
  const summary = () => renderSummary(document, data, access.checked, label.value.trim() || null);
  label.value = data.profile.label || "";
  access.checked = data.profile.agentAccess;
  document.getElementById("instance")!.textContent = `Instance: ${data.profile.instanceId}`;
  renderConnection(document, data.connection);
  document.getElementById("registration-command")!.textContent = registrationCommand;
  const window = document.defaultView;
  if (window) {
    const timer = window.setInterval(() => {
      void runtime.sendMessage({ op: "status" }).then(status => renderConnection(document, status)).catch(() => {});
    }, 1000);
    window.addEventListener("pagehide", () => window.clearInterval(timer), { once: true });
  }
  document.getElementById("label-form")!.addEventListener("submit", event => {
    event.preventDefault();
    void state.setLabel(label.value).then(() => {
      label.value = label.value.trim();
      message.textContent = "Profile label saved.";
      summary();
    }).catch(() => message.textContent = "Could not save the profile label.");
  });
  access.addEventListener("change", () => {
    access.disabled = true;
    void state.setAgentAccess(access.checked).then(() => { message.textContent = "Agent access saved."; summary(); })
      .catch(() => { access.checked = !access.checked; message.textContent = "Could not save agent access."; })
      .finally(() => access.disabled = false);
  });
  renderTools(document, data, new Grants(state, data.profile.tools, permissions), message, summary);
  renderRequests(document, data.log);
  summary();
  for (const tab of document.querySelectorAll<HTMLButtonElement>("#tabs [role=tab]"))
    tab.addEventListener("click", () => selectTab(document, tab.dataset.tab!));
}

if (typeof document !== "undefined" && typeof chrome !== "undefined")
  void mountPopup(document, chrome.runtime, chrome.storage.local, chrome.permissions, REGISTRATION_COMMAND)
    .catch(() => { document.getElementById("message")!.textContent = "Cannot read this profile. Reload Browser Agent in this browser."; });
