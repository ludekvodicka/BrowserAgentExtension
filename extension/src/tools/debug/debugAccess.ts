import type { ToolFailure } from "../browserTool.ts";

export type DebugRequest = { id: string; caller: string; reason: string; requestedAt: number; expiresAt: number;
  status: "pending_approval" | "denied" | "expired" };
export type DebugGrant = { caller: string; reason: string; approvedAt: number; until: number };
export type DebugState = { request: DebugRequest | null; grant: DebugGrant | null };
export type DebugStatus = { status: "approved"; until: number } | { status: "pending_approval" | "denied" | "expired"; id: string; expiresAt: number }
  | { status: "not_requested" };

export const debugDurations = [10, 60] as const;
const requestLifetime = 600_000;

export class DebugAccess {
  private queue: Promise<unknown>;

  constructor() {
    this.queue = Promise.resolve();
  }

  private change<T>(update: (state: DebugState) => T): Promise<T> {
    const result = this.queue.then(async () => {
      const state = await this.read();
      const value = update(state);
      await chrome.storage.local.set({ debugAccess: state });
      await this.badge(state);
      return value;
    });
    this.queue = result.catch(() => {});
    return result;
  }

  async read(): Promise<DebugState> {
    const { debugAccess } = await chrome.storage.local.get("debugAccess");
    const stored = (debugAccess ?? {}) as Partial<DebugState>;
    const now = Date.now();
    const request = stored.request ?? null;
    return {
      request: request?.status === "pending_approval" && request.expiresAt <= now ? { ...request, status: "expired" } : request,
      grant: stored.grant && stored.grant.until > now ? stored.grant : null,
    };
  }

  status(state: DebugState): DebugStatus {
    if (state.grant)
      return { status: "approved", until: state.grant.until };
    else if (state.request)
      return { status: state.request.status, id: state.request.id, expiresAt: state.request.expiresAt };
    else return { status: "not_requested" };
  }

  async check(): Promise<ToolFailure | void> {
    if (!(await this.read()).grant)
      return { ok: false, code: "permission_missing",
        message: "Debug access is not approved or has ended. Call debug.requestAccess with a reason and wait for the user to approve it in the Debug tab." };
  }

  // Returns the current status and whether this call created a new request.
  request(caller: string, reason: string, retry: boolean): Promise<{ status: DebugStatus; created: boolean }> {
    return this.change(state => {
      const request = state.request;
      if (state.grant || request?.status === "pending_approval" || request && !retry)
        return { status: this.status(state), created: false };
      state.request = { id: crypto.randomUUID(), caller, reason, requestedAt: Date.now(), expiresAt: Date.now() + requestLifetime, status: "pending_approval" };
      return { status: this.status(state), created: true };
    });
  }

  approve(id: string, minutes: number): Promise<void> {
    return this.change(state => {
      if (!debugDurations.some(duration => duration === minutes))
        throw new Error("Choose 10 minutes or 1 hour.");
      const request = state.request;
      if (!request || request.id !== id || request.status !== "pending_approval")
        throw new Error("This debug request expired or was replaced. Ask the agent to request it again.");
      state.grant = { caller: request.caller, reason: request.reason, approvedAt: Date.now(), until: Date.now() + minutes * 60_000 };
      state.request = null;
    });
  }

  deny(id: string): Promise<void> {
    return this.change(state => {
      if (state.request?.id === id && state.request.status === "pending_approval")
        state.request.status = "denied";
    });
  }

  revoke(): Promise<void> {
    return this.change(state => {
      state.grant = null;
    });
  }

  // "D" marks a pending debug request; it never replaces another badge such as "?" or "!".
  async badge(state?: DebugState): Promise<void> {
    const pending = (state ?? await this.read()).request?.status === "pending_approval";
    const current = await chrome.action.getBadgeText({});
    if (pending && current === "")
      await chrome.action.setBadgeText({ text: "D" });
    else if (!pending && current === "D")
      await chrome.action.setBadgeText({ text: "" });
  }
}

export const debugAccess = new DebugAccess();
