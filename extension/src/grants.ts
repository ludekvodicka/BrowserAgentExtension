import type { ToolInfo } from "../../shared/protocol.ts";
import type { ProfileState } from "./profileState.ts";

type GrantTool = Pick<ToolInfo, "id" | "hosts">;

export class Grants {
  private state: ProfileState;
  private tools: readonly GrantTool[];
  private permissions: Pick<typeof chrome.permissions, "request" | "remove" | "contains">;

  constructor(state: ProfileState, tools: readonly GrantTool[], permissions: Pick<typeof chrome.permissions, "request" | "remove" | "contains">) {
    this.state = state;
    this.tools = tools;
    this.permissions = permissions;
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const tool = this.tools.find(item => item.id === id);
    if (!tool)
      throw new Error("Unknown tool. Reopen the popup.");
    if (enabled) {
      // The permission request must happen synchronously in the click handler's user gesture.
      const granted = tool.hosts.length ? this.permissions.request({ origins: tool.hosts }) : Promise.resolve(true);
      // Brave's permission prompt can close the popup before the request resolves;
      // completePending in the background then finishes the grant.
      const marked = this.state.setPendingTool(id);
      if (!await granted) {
        await marked;
        await this.state.setPendingTool(null);
        return false;
      }
      await marked;
      await this.enable(id);
      return true;
    } else if (enabled === false) {
      const current = await this.state.read();
      const remaining = current.enabledTools.filter(item => item !== id);
      await this.state.setEnabledTools(remaining);
      const needed = new Set(this.tools.filter(item => remaining.includes(item.id)).flatMap(item => item.hosts));
      const unused = tool.hosts.filter(host => !needed.has(host));
      if (unused.length)
        await this.permissions.remove({ origins: unused });
      return false;
    } else throw new Error("Unknown grant state.");
  }

  async completePending(): Promise<void> {
    const { pendingTool } = await this.state.read();
    if (!pendingTool)
      return;
    const tool = this.tools.find(item => item.id === pendingTool);
    if (!tool)
      await this.state.setPendingTool(null);
    else if (await this.permissions.contains({ origins: tool.hosts }))
      await this.enable(tool.id);
  }

  private async enable(id: string): Promise<void> {
    const current = await this.state.read();
    await this.state.setEnabledTools([...new Set([...current.enabledTools, id])]);
    await this.state.setPendingTool(null);
  }
}
