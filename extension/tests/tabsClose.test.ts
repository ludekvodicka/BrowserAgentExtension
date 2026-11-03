import { afterEach, expect, it, vi } from "vitest";
import { tabsClose } from "../src/tools/browser/tabs/tabsClose.ts";
import { tabsOpen } from "../src/tools/browser/tabs/tabsOpen.ts";

afterEach(() => vi.unstubAllGlobals());

function setup(openTabs: number[]) {
  const stored: Record<string, unknown> = {};
  const session = {
    set: vi.fn(async (values: Record<string, unknown>) => { Object.assign(stored, values); }),
    get: vi.fn(async (key: string) => (key in stored ? { [key]: stored[key] } : {})),
    remove: vi.fn(async (key: string) => { delete stored[key]; }),
  };
  const tabs = {
    create: vi.fn(async () => { openTabs.push(11); return { id: 11, windowId: 5 }; }),
    get: vi.fn(async (tabId: number) => {
      if (!openTabs.includes(tabId))
        throw new Error("No tab");
      return { id: tabId };
    }),
    remove: vi.fn(async (tabId: number) => { openTabs.splice(openTabs.indexOf(tabId), 1); }),
  };
  vi.stubGlobal("chrome", { tabs, storage: { session } });
  return { tabs, stored };
}

it.each([[undefined], [{}], [{ tabId: "11" }], [{ tabId: -1 }], [{ tabId: 1.5 }], [{ tabId: 11, windowId: 5 }]])("refuses args %j", async args => {
  const s = setup([11]);
  expect(await tabsClose.run(args)).toMatchObject({ ok: false, code: "tool_args_invalid" });
  expect(s.tabs.remove).not.toHaveBeenCalled();
});

it("closes a tab browser.tabs.open opened and then forgets it", async () => {
  const s = setup([]);
  await tabsOpen.run({ url: "https://example.com/" });
  expect(await tabsClose.run({ tabId: 11 })).toEqual({ ok: true, value: { tabId: 11, closed: true } });
  expect(s.tabs.remove).toHaveBeenCalledExactlyOnceWith(11);
  expect(s.stored).toEqual({});
  expect(await tabsClose.run({ tabId: 11 })).toMatchObject({ ok: false, code: "tool_denied" });
});

it("refuses a tab of the user", async () => {
  const s = setup([3]);
  expect(await tabsClose.run({ tabId: 3 })).toMatchObject({ ok: false, code: "tool_denied", message: expect.stringContaining("Tab 3") });
  expect(s.tabs.remove).not.toHaveBeenCalled();
});

it("reports an agent tab the user already closed", async () => {
  const s = setup([]);
  s.stored["agentTab:12"] = true;
  expect(await tabsClose.run({ tabId: 12 })).toMatchObject({ ok: false, code: "tab_missing" });
  expect(s.tabs.remove).not.toHaveBeenCalled();
  expect(s.stored).toEqual({});
});
