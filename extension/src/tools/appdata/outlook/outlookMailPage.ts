export type OutlookMailPageResult = { kind: "hook_missing" | "not_ready" | "extension_error" }
  | { kind: "response"; status: number; body: unknown };

export async function outlookMailPage(path: string): Promise<OutlookMailPageResult> {
  try {
    if (location.origin !== "https://outlook.cloud.microsoft" || !/^\/api\/v2\.0\/me\/(mailfolders|messages)[/?]/.test(path))
      return { kind: "extension_error" };
    const hook = (window as unknown as Record<symbol, { authorization(): string | null } | undefined>)[Symbol.for("browserAgent.outlook")];
    if (!hook)
      return { kind: "hook_missing" };
    const authorization = hook.authorization();
    if (!authorization)
      return { kind: "not_ready" };
    const response = await fetch(path, { method: "GET", redirect: "error",
      headers: { Authorization: authorization, Prefer: 'outlook.body-content-type="text"' } });
    if (response.status === 401)
      return { kind: "not_ready" };
    const text = await response.text();
    // Keep even an echoed credential inside the page.
    if (text.includes(authorization.slice(7)))
      return { kind: "extension_error" };
    return { kind: "response", status: response.status, body: text ? JSON.parse(text) : null };
  } catch {
    return { kind: "extension_error" };
  }
}
