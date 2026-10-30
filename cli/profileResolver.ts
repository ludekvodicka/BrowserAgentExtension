import type { ConnectedProfile } from "./pipeClient.ts";

export function resolveProfile(profiles: readonly ConnectedProfile[], selector: string) {
  const query = selector.toLowerCase();
  let matches = profiles.filter(({ profile }) => profile.label?.toLowerCase() === query);
  if (!matches.length && query.length >= 8)
    matches = profiles.filter(({ profile }) => profile.instanceId.toLowerCase().startsWith(query));
  if (matches.length === 1)
    return { ok: true as const, selected: matches[0] };
  else if (matches.length > 1)
    return { ok: false as const, code: "profile_ambiguous" as const, message: `Profile ${selector} is ambiguous. Use an instanceId prefix: ${matches.map(({ profile }) => profile.instanceId).join(", ")}.` };
  else return { ok: false as const, code: "profile_not_found" as const,
    message: `Profile ${selector} was not found. Open its browser window or choose a listed label/id: ${profiles.map(({ profile }) => `${profile.label || "(unlabeled)"} [${profile.instanceId}]`).join(", ") || "none"}.` };
}
