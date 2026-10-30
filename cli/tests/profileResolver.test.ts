import { expect, it } from "vitest";
import { resolveProfile } from "../profileResolver.ts";
import type { ConnectedProfile } from "../pipeClient.ts";

const profiles: ConnectedProfile[] = ["Work", "home", null].map((label, i) => ({ pipe: `fixture-${i}`,
  profile: { instanceId: `${String(i).repeat(8)}-0000-4000-8000-000000000000`, label, agentAccess: false, extensionVersion: "0.1.0", protocolVersion: 1, tools: [] } }));

it("matches labels without case, or an id prefix of at least eight characters", () => {
  expect(resolveProfile(profiles, "work")).toMatchObject({ ok: true, selected: profiles[0] });
  expect(resolveProfile(profiles, "11111111")).toMatchObject({ ok: true, selected: profiles[1] });
  expect(resolveProfile(profiles, "1111111")).toMatchObject({ code: "profile_not_found" });
  expect(resolveProfile(profiles, "22222222")).toMatchObject({ ok: true, selected: profiles[2] });
});

it("refuses duplicate labels and lists both ids", () => {
  const duplicate = { ...profiles[1], profile: { ...profiles[1].profile, label: "work" } };
  const result = resolveProfile([profiles[0], duplicate], "work");
  expect(result).toMatchObject({ code: "profile_ambiguous" });
  if (!result.ok) {
    expect(result.message).toContain(profiles[0].profile.instanceId);
    expect(result.message).toContain(duplicate.profile.instanceId);
  }
});
