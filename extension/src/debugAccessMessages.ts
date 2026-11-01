import { isRecord } from "../../shared/protocol.ts";
import { debugAccess } from "./tools/debug/debugAccess.ts";

export async function debugAccessMessage(request: unknown) {
  if (!isRecord(request))
    throw new Error("Invalid debug access request.");
  switch (request.action) {
    case "read": break;
    case "approve":
      if (typeof request.id !== "string" || typeof request.minutes !== "number")
        throw new Error("Invalid debug approval.");
      await debugAccess.approve(request.id, request.minutes);
      break;
    case "deny":
      if (typeof request.id !== "string")
        throw new Error("Invalid debug denial.");
      await debugAccess.deny(request.id);
      break;
    case "revoke": await debugAccess.revoke(); break;
    default: throw new Error("Unknown debug access operation.");
  }
  const state = await debugAccess.read();
  await debugAccess.badge(state);
  return state;
}
