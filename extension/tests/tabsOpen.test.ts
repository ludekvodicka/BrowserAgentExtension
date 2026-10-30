import { afterEach, expect, it, vi } from "vitest";
import { tabsOpen } from "../src/tools/browser/tabs/tabsOpen.ts";

afterEach(() => vi.unstubAllGlobals());

function setup() {
  const create = vi.fn(async (properties: chrome.tabs.CreateProperties) => ({ id: 11, windowId: properties.windowId ?? 5 }));
  const get = vi.fn(async (windowId: number) => {
    if (windowId === 5)
      return { id: 5, type: "normal" };
    else if (windowId === 6)
      return { id: 6, type: "popup" };
    throw new Error("No window");
  });
  vi.stubGlobal("chrome", { tabs: { create }, windows: { get } });
  return { create };
}

it.each([[undefined], [{}], [{ url: "javascript:alert(1)" }], [{ url: "file:///C:/x" }], [{ url: "chrome://settings" }], [{ url: "not a url" }],
  [{ url: "https://x.cz", windowId: -1 }], [{ url: "https://x.cz", windowId: "5" }], [{ url: "https://x.cz", active: false }]])("refuses args %j", async args => {
  const s = setup();
  expect(await tabsOpen.run(args)).toMatchObject({ ok: false, code: "tool_args_invalid" });
  expect(s.create).not.toHaveBeenCalled();
});

it("opens the page in the window the user used last and returns its window", async () => {
  const s = setup();
  expect(await tabsOpen.run({ url: "https://example.com/a b?q=č" })).toEqual({ ok: true, value: { tabId: 11, windowId: 5, url: "https://example.com/a%20b?q=%C4%8D" } });
  expect(s.create).toHaveBeenCalledExactlyOnceWith({ url: "https://example.com/a%20b?q=%C4%8D", active: true });
});

it("opens the page in a named window and refuses a window the profile does not have", async () => {
  const s = setup();
  expect(await tabsOpen.run({ url: "http://example.com/", windowId: 5 })).toMatchObject({ ok: true, value: { windowId: 5 } });
  expect(s.create).toHaveBeenCalledWith({ url: "http://example.com/", active: true, windowId: 5 });
  for (const windowId of [6, 9])
    expect(await tabsOpen.run({ url: "http://example.com/", windowId })).toMatchObject({ ok: false, code: "tool_args_invalid", message: expect.stringContaining(`window ${windowId}`) });
  expect(s.create).toHaveBeenCalledTimes(1);
});
