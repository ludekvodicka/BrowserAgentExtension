import type { ProfileState } from "./profileState.ts";
import type { BrowserTool, PageScript } from "./tools/browserTool.ts";

type Scripting = Pick<typeof chrome.scripting, "getRegisteredContentScripts" | "registerContentScripts" | "unregisterContentScripts">;

export class PageScripts {
  private state: ProfileState;
  private tools: readonly Pick<BrowserTool, "id" | "hosts" | "pageScripts">[];
  private permissions: Pick<typeof chrome.permissions, "contains">;
  private scripting: Scripting;
  private queue: Promise<void> = Promise.resolve();

  constructor(state: ProfileState, tools: readonly Pick<BrowserTool, "id" | "hosts" | "pageScripts">[],
    permissions: Pick<typeof chrome.permissions, "contains">, scripting: Scripting) {
    this.state = state;
    this.tools = tools;
    this.permissions = permissions;
    this.scripting = scripting;
  }

  // Serialized: two overlapping syncs would register the same script id twice.
  sync(): Promise<void> {
    this.queue = this.queue.then(() => this.apply(), () => this.apply());
    return this.queue;
  }

  private async apply(): Promise<void> {
    const { enabledTools } = await this.state.read();
    const wanted: PageScript[] = [];
    for (const tool of this.tools)
      if (tool.pageScripts?.length && enabledTools.includes(tool.id) && await this.permissions.contains({ origins: tool.hosts }))
        wanted.push(...tool.pageScripts);
    const registered = await this.scripting.getRegisteredContentScripts();
    const stale = registered.filter(script => !wanted.some(item => item.id === script.id)).map(script => script.id);
    if (stale.length)
      await this.scripting.unregisterContentScripts({ ids: stale });
    const missing = wanted.filter(item => !registered.some(script => script.id === item.id));
    if (missing.length)
      await this.scripting.registerContentScripts(missing.map(item => ({ id: item.id, js: [item.file], matches: item.matches,
        runAt: "document_start" as const, world: "MAIN" as const, persistAcrossSessions: true })));
  }
}
