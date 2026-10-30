export type ProfileStateData = { instanceId: string; label: string | null; agentAccess: boolean; enabledTools: string[]; pendingTool: string | null };

export class ProfileState {
  private storage: Pick<typeof chrome.storage.local, "get" | "set">;
  private initialization: Promise<void> | undefined;

  constructor(storage: Pick<typeof chrome.storage.local, "get" | "set">) {
    this.storage = storage;
  }

  async read(): Promise<ProfileStateData> {
    this.initialization ??= this.initialize().catch(error => { this.initialization = undefined; throw error; });
    await this.initialization;
    const data = await this.storage.get(["instanceId", "label", "agentAccess", "enabledTools", "pendingTool"]);
    if (typeof data.instanceId !== "string")
      throw new Error("Profile identity is unavailable.");
    return {
      instanceId: data.instanceId,
      label: typeof data.label === "string" ? data.label : null,
      agentAccess: data.agentAccess === true,
      enabledTools: Array.isArray(data.enabledTools) ? data.enabledTools.filter((id: unknown) => typeof id === "string") : [],
      pendingTool: typeof data.pendingTool === "string" ? data.pendingTool : null,
    };
  }

  private async initialize(): Promise<void> {
    const { instanceId } = await this.storage.get("instanceId");
    if (!instanceId)
      await this.storage.set({ instanceId: crypto.randomUUID() });
  }

  async setLabel(label: string): Promise<void> {
    await this.storage.set({ label: label.trim() || null });
  }

  async setAgentAccess(agentAccess: boolean): Promise<void> {
    await this.storage.set({ agentAccess });
  }

  async setEnabledTools(enabledTools: string[]): Promise<void> {
    await this.storage.set({ enabledTools });
  }

  // One key written without a prior read, so the write leaves before the popup closes.
  setPendingTool(pendingTool: string | null): Promise<void> {
    return this.storage.set({ pendingTool });
  }
}
