import { isRecord } from "../../shared/protocol.ts";
import { siteAccess, webOrigin } from "./tools/page/siteAccess.ts";

export async function siteAccessMessage(request: unknown) {
  if (!isRecord(request))
    throw new Error("Invalid site access request.");
  const origin = webOrigin(request.origin);
  switch (request.action) {
    case "read": break;
    case "approve-start":
      if (!origin || origin !== request.origin || !(typeof request.id === "string" || request.id === null))
        throw new Error("Invalid site approval.");
      await siteAccess.beginApproval(origin, request.id);
      break;
    case "approve-finish": await siteAccess.completeApprovals(); break;
    case "deny":
      if (!origin || typeof request.id !== "string")
        throw new Error("Invalid site denial.");
      await siteAccess.deny(origin, request.id);
      break;
    case "remove":
      if (!origin)
        throw new Error("Invalid site origin.");
      await siteAccess.remove(origin);
      break;
    default: throw new Error("Unknown site access operation.");
  }
  const [sites, tabs] = await Promise.all([siteAccess.read(), chrome.tabs.query({ active: true, lastFocusedWindow: true })]);
  await siteAccess.badge(sites);
  return { sites, currentOrigin: webOrigin(tabs[0]?.url) };
}
