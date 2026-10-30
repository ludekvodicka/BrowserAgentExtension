import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, expect, it, vi } from "vitest";
import { mountPopup } from "../src/popup.ts";
import type { PopupData } from "../src/popup.ts";

const windows: JSDOM[] = [];
afterEach(() => windows.splice(0).forEach(dom => dom.window.close()));

async function setup() {
  const dom = new JSDOM(readFileSync(new URL("../popup.html", import.meta.url), "utf8"));
  windows.push(dom);
  const document = dom.window.document;
  const profile = { instanceId: "00000000-0000-4000-8000-000000000000", label: null, agentAccess: false, extensionVersion: "0.1.0", protocolVersion: 1,
    tools: ["first", "second"].map(id => ({ id, title: `${id} tool`, section: id, group: "group", hosts: ["https://example.com/*"], enabled: false, sensitive: true })) };
  const data: PopupData = { profile, sections: [{ id: "first", title: "First section" }, { id: "second", title: "Second section" }],
    groups: [{ section: "first", id: "group", title: "First group" }, { section: "second", id: "group", title: "Second group" }],
    connection: { state: "disconnected", error: "Specified native messaging host not found." },
    log: [{ at: "2026-01-01", tool: "first", caller: "cli", outcome: "tool_denied" }] };
  const saved: Record<string, unknown> = { instanceId: profile.instanceId };
  const storage = { get: vi.fn(async () => structuredClone(saved)), set: vi.fn(async (value: Record<string, unknown>) => { Object.assign(saved, value); }) };
  const runtime = { sendMessage: vi.fn(async request => request.op === "status" ? data.connection : data) } as unknown as Pick<typeof chrome.runtime, "sendMessage">;
  const permissions = { request: vi.fn(async () => false), remove: vi.fn(async () => true), contains: vi.fn(async () => false) };
  await mountPopup(document, runtime, storage, permissions, "node /fixture/cli/browserAgent.ts register");
  return { dom, document, saved, permissions };
}

it("renders one tab per tool group from registry metadata between Overview and Access", async () => {
  const { document } = await setup();
  expect([...document.querySelectorAll("#tabs [role=tab]")].map(node => node.textContent))
    .toEqual(["Overview", "First group", "Second group", "Access", "Requests"]);
  expect(document.querySelectorAll("[data-tool]")).toHaveLength(2);
  expect(document.getElementById("tab-group-first-group")!.textContent).toContain("first tool");
  expect(document.getElementById("error")!.textContent).toContain("host not found");
  expect(document.getElementById("registration-command")!.textContent).toBe("node /fixture/cli/browserAgent.ts register");
  expect(document.getElementById("requests")!.textContent).toContain("first · cli · tool_denied");
});

it("shows only the Overview panel first and switches panels by tab", async () => {
  const { document } = await setup();
  const visible = () => [...document.querySelectorAll<HTMLElement>("[role=tabpanel]")].filter(panel => !panel.hidden).map(panel => panel.id);
  expect(visible()).toEqual(["tab-overview"]);
  document.querySelector<HTMLButtonElement>('[data-tab="requests"]')!.click();
  expect(visible()).toEqual(["tab-requests"]);
  expect(document.querySelector('[data-tab="requests"]')!.getAttribute("aria-selected")).toBe("true");
  document.querySelector<HTMLButtonElement>('[data-tab="group-second-group"]')!.click();
  expect(visible()).toEqual(["tab-group-second-group"]);
});

it("summarizes connection, access, enabled tools and recent requests on Overview", async () => {
  const { document } = await setup();
  expect(document.getElementById("header-text")!.textContent).toBe("Not connected");
  expect(document.getElementById("summary-label")!.textContent).toContain("No label");
  expect(document.getElementById("summary-access")!.textContent).toBe("Off");
  expect(document.getElementById("summary-tools")!.textContent).toBe("None of 2");
  expect(document.getElementById("summary-last")!.textContent).toContain("first · tool_denied");
  expect(document.getElementById("summary-recent")!.textContent).toBe("0 ok, 1 refused (last 1)");
});

it("saves a trimmed label and reflects a refused permission as disabled", async () => {
  const { document, dom, saved, permissions } = await setup();
  const label = document.getElementById("profile-label") as HTMLInputElement;
  label.value = " work ";
  document.getElementById("label-form")!.dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  await vi.waitFor(() => expect(saved.label).toBe("work"));
  const toggle = document.querySelector<HTMLInputElement>("[data-tool]")!;
  toggle.click();
  expect(permissions.request).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(toggle.checked).toBe(false));
  expect(document.getElementById("message")!.textContent).toContain("declined");
});
