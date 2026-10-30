import { expect, it, vi } from "vitest";
import { PageScripts } from "../src/pageScripts.ts";
import { ProfileState } from "../src/profileState.ts";

const hooked = { id: "site.read", hosts: ["https://site.example/*"], pageScripts: [{ id: "site-hook", file: "hooks/siteHook.js", matches: ["https://site.example/*"] }] };
const plain = { id: "other.read", hosts: ["https://other.example/*"] };

function setup(enabledTools: string[], granted = true, registered: { id: string }[] = []) {
  const data: Record<string, unknown> = { instanceId: "00000000-0000-4000-8000-000000000000", enabledTools };
  const state = new ProfileState({ get: async () => structuredClone(data), set: async value => { Object.assign(data, value); } });
  const scripting = { getRegisteredContentScripts: vi.fn(async () => registered), registerContentScripts: vi.fn(async () => {}),
    unregisterContentScripts: vi.fn(async () => {}) };
  const permissions = { contains: vi.fn(async () => granted) };
  return { scripts: new PageScripts(state, [hooked, plain], permissions, scripting as never), scripting, data };
}

it("registers an enabled, permitted tool's page script in the main world from document_start", async () => {
  const s = setup(["site.read", "other.read"]);
  await s.scripts.sync();
  expect(s.scripting.registerContentScripts).toHaveBeenCalledExactlyOnceWith([{ id: "site-hook", js: ["hooks/siteHook.js"],
    matches: ["https://site.example/*"], runAt: "document_start", world: "MAIN", persistAcrossSessions: true }]);
  expect(s.scripting.unregisterContentScripts).not.toHaveBeenCalled();
});

it.each([[[], true], [["site.read"], false]] as const)("unregisters the script when the tool is off or unpermitted (%j, %s)", async (enabled, granted) => {
  const s = setup([...enabled], granted, [{ id: "site-hook" }]);
  await s.scripts.sync();
  expect(s.scripting.unregisterContentScripts).toHaveBeenCalledExactlyOnceWith({ ids: ["site-hook"] });
  expect(s.scripting.registerContentScripts).not.toHaveBeenCalled();
});

it("leaves an already registered script alone and serializes overlapping syncs", async () => {
  const s = setup(["site.read"], true, [{ id: "site-hook" }]);
  await Promise.all([s.scripts.sync(), s.scripts.sync()]);
  expect(s.scripting.registerContentScripts).not.toHaveBeenCalled();
  expect(s.scripting.getRegisteredContentScripts).toHaveBeenCalledTimes(2);
});
