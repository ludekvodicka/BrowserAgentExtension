// Tabs an agent tool opened, so browser.tabs.close never closes a tab of the user. Session storage ends with the
// browser session, together with the tab IDs it holds; one key per tab keeps parallel tool calls from overwriting each other.
const key = (tabId: number) => `agentTab:${tabId}`;

export const agentTabs = {
  async record(tabId: number | undefined): Promise<void> {
    if (tabId !== undefined)
      await chrome.storage.session.set({ [key(tabId)]: true });
  },
  async owns(tabId: number): Promise<boolean> {
    return (await chrome.storage.session.get(key(tabId)))[key(tabId)] === true;
  },
  async forget(tabId: number): Promise<void> {
    await chrome.storage.session.remove(key(tabId));
  },
};
