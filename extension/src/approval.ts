import { mountSiteAccess } from "./siteAccessPanel.ts";

void mountSiteAccess(document, document.getElementById("sites")!, chrome.runtime, chrome.permissions)
  .catch(() => { document.getElementById("message")!.textContent = "Cannot read site requests. Reopen the extension."; });
