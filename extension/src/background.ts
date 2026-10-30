import { NativeConnection } from "./connection.ts";
import { createDispatcher, describeProfile } from "./dispatcher.ts";
import { Grants } from "./grants.ts";
import { PageScripts } from "./pageScripts.ts";
import { ProfileState } from "./profileState.ts";
import { RequestLog } from "./requestLog.ts";
import { tools, sections, groups } from "./tools/toolRegistry.ts";

const state = new ProfileState(chrome.storage.local);
const log = new RequestLog(chrome.storage.local);
const version = chrome.runtime.getManifest().version;
const describe = async () => describeProfile(await state.read(), tools, version);
const dispatch = createDispatcher(state, log, tools, chrome.permissions, chrome.action, version);
const connection = new NativeConnection(chrome.runtime, chrome.alarms, describe, dispatch);
chrome.runtime.onMessage.addListener((request, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.url !== chrome.runtime.getURL("popup.html"))
    return false;
  if (request?.op === "popup") {
    const previous = connection.getStatus();
    connection.connect();
    void Promise.all([describe(), log.read(), chrome.action.setBadgeText({ text: "" })])
      .then(([profile, entries]) => reply({ profile, sections, groups, log: entries,
        connection: { ...connection.getStatus(), error: connection.getStatus().error || previous.error } }))
      .catch(() => reply({ error: "Cannot read profile settings." }));
    return true;
  } else if (request?.op === "status") {
    reply(connection.getStatus());
    return false;
  } else return false;
});
const grants = new Grants(state, tools, chrome.permissions);
const pageScripts = new PageScripts(state, tools, chrome.permissions, chrome.scripting);
chrome.permissions.onAdded.addListener(() => void grants.completePending().then(() => pageScripts.sync()));
chrome.permissions.onRemoved.addListener(() => void pageScripts.sync());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "enabledTools" in changes)
    void pageScripts.sync();
});
void grants.completePending().then(() => pageScripts.sync());
chrome.runtime.onStartup.addListener(() => connection.connect());
chrome.runtime.onInstalled.addListener(() => connection.connect());
connection.start();
