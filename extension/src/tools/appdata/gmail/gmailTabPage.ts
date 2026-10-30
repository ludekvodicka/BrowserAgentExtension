export type GmailTabInfo = { account: string | null; ik: string | null; user: string | null; threadId: string | null };

// Runs in Gmail's main world: GLOBALS (account at 10, request key `ik` at 9) is not visible to an isolated script.
export function gmailTabPage(): GmailTabInfo {
  const globals = (window as unknown as { GLOBALS?: unknown }).GLOBALS;
  const field = (index: number) => Array.isArray(globals) && typeof globals[index] === "string" ? globals[index] as string : null;
  // Gmail keeps earlier conversations in the page hidden; only the visible heading is the open one.
  const heading = [...document.querySelectorAll("h2[data-thread-perm-id]")].find(element => element.checkVisibility());
  return { account: field(10), ik: field(9), user: location.pathname.match(/^\/mail\/u\/(\d+)\//)?.[1] ?? null,
    threadId: heading?.getAttribute("data-thread-perm-id") ?? null };
}
