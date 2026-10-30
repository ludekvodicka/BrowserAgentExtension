export type SlackApiPageResult = { kind: "not_signed_in" | "extension_error" }
  | { kind: "response"; status: number; retryAfter?: number; body: Record<string, unknown> & { ok: boolean } };

export async function slackApiPage(teamId: string, method: string,
  params: Record<string, string | number | boolean>): Promise<SlackApiPageResult> {
  try {
    if (location.origin !== "https://app.slack.com")
      return { kind: "extension_error" };
    const token: unknown = JSON.parse(localStorage.getItem("localConfig_v2") || "{}").teams?.[teamId]?.token;
    if (typeof token !== "string" || !token)
      return { kind: "not_signed_in" };
    const form = new FormData();
    for (const [key, value] of Object.entries(params))
      form.set(key, String(value));
    form.set("token", token);
    const response = await fetch(`/api/${method}`, { method: "POST", body: form, credentials: "include", redirect: "error" });
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || Array.isArray(body) || !("ok" in body) || typeof body.ok !== "boolean")
      return { kind: "extension_error" };
    // Keep even an echoed credential inside this isolated world.
    if (JSON.stringify(body).includes(JSON.stringify(token).slice(1, -1)))
      return { kind: "extension_error" };
    const retryHeader = response.headers.get("retry-after");
    const retryAfter = Number(retryHeader);
    return { kind: "response", status: response.status, body: { ...body, ok: body.ok },
      ...(retryHeader?.trim() && Number.isFinite(retryAfter) && retryAfter >= 0 ? { retryAfter } : {}) };
  } catch {
    return { kind: "extension_error" };
  }
}
