import { mountPopup } from "./popup.ts";
import { mountSiteAccess } from "./siteAccessPanel.ts";
import { mountDebugAccess } from "./debugAccessPanel.ts";

declare const REGISTRATION_COMMAND: string;
void mountPopup(document, chrome.runtime, chrome.storage.local, chrome.permissions, REGISTRATION_COMMAND,
  { siteAccess: container => mountSiteAccess(document, container, chrome.runtime, chrome.permissions),
    debugAccess: container => mountDebugAccess(document, container, chrome.runtime) })
  .catch(() => { document.getElementById("message")!.textContent = "Cannot read this profile. Reload Browser Agent in this browser."; });
