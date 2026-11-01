import { mountDebugAccess } from "./debugAccessPanel.ts";
import { mountSiteAccess } from "./siteAccessPanel.ts";

void Promise.all([mountSiteAccess(document, document.getElementById("sites")!, chrome.runtime, chrome.permissions),
  mountDebugAccess(document, document.getElementById("debug")!, chrome.runtime)])
  .catch(() => { document.getElementById("message")!.textContent = "Cannot read the requests. Reopen the extension."; });
