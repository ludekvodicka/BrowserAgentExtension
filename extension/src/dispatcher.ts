import { maxMessageBytes, protocolVersion } from "../../shared/protocol.ts";
import type { ErrorCode, ProfileInfo, RelayRequest, RelayResponse } from "../../shared/protocol.ts";
import type { ProfileState, ProfileStateData } from "./profileState.ts";
import type { RequestLog } from "./requestLog.ts";
import type { BrowserTool } from "./tools/browserTool.ts";

export function describeProfile(state: ProfileStateData, tools: readonly BrowserTool[], extensionVersion: string): ProfileInfo {
  return { instanceId: state.instanceId, label: state.label, agentAccess: state.agentAccess, extensionVersion, protocolVersion,
    tools: tools.map(tool => ({ id: tool.id, section: tool.section, group: tool.group, title: tool.title,
      hosts: tool.hosts, sensitive: tool.sensitive, enabled: state.enabledTools.includes(tool.id) })) };
}

export function createDispatcher(state: ProfileState, log: RequestLog, tools: readonly BrowserTool[],
  permissions: Pick<typeof chrome.permissions, "contains">, action: Pick<typeof chrome.action, "setBadgeText">, version: string) {
  return async (request: RelayRequest): Promise<RelayResponse> => {
    let current = await state.read();
    const profile = () => describeProfile(current, tools, version);
    const name = () => current.label || current.instanceId;
    async function finish(response: RelayResponse, quiet = false): Promise<RelayResponse> {
      const json = JSON.stringify(response);
      if (json.length > 900_000 || new TextEncoder().encode(json).length > maxMessageBytes)
        response = { id: request.id, ok: false, code: "result_too_large",
          message: `${name().slice(0, 128)}: Result is too large; request a smaller page (lower limit).` };
      if (request.op === "call" && (!quiet || !response.ok))
        await log.add({ at: new Date().toISOString(), tool: request.tool, caller: request.caller, outcome: response.ok ? "ok" : response.code });
      if (!response.ok)
        await action.setBadgeText({ text: "!" });
      return response;
    }
    const refuse = (code: ErrorCode, message: string) => finish({ id: request.id, ok: false, code, message: `${name()}: ${message}`, profile: profile() });
    if (request.protocolVersion !== protocolVersion)
      return refuse("protocol_mismatch", "Update the extension and browser-agent CLI together.");
    if (request.op === "describe")
      return finish({ id: request.id, ok: true, profile: profile() });
    else if (request.op === "call") {
      if (!current.agentAccess)
        return refuse("access_off", "Turn on Agent access in this profile's Browser Agent popup.");
      const tool = tools.find(item => item.id === request.tool);
      if (!tool)
        return refuse("tool_unknown", "This tool is not installed. Update the extension or select a listed tool.");
      if (!current.enabledTools.includes(tool.id))
        return refuse("tool_denied", `Enable ${tool.title} in this profile's Browser Agent popup.`);
      try {
        const permitted = !tool.hosts.length || await permissions.contains({ origins: tool.hosts });
        // Permission lookup yields; honor a grant revoked before the tool starts.
        current = await state.read();
        if (!current.agentAccess)
          return refuse("access_off", "Turn on Agent access in this profile's Browser Agent popup.");
        if (!current.enabledTools.includes(tool.id))
          return refuse("tool_denied", `Enable ${tool.title} in this profile's Browser Agent popup.`);
        if (!permitted)
          return refuse("permission_missing", `Enable ${tool.title} again and allow its site permission in the popup.`);
        if (request.files?.length && !tool.acceptsFiles)
          return refuse("tool_args_invalid", `${tool.title} takes no files; call it without --file.`);
        const result = await tool.run(request.args, request.files ?? []);
        if (result.ok)
          return finish({ id: request.id, ok: true, profile: profile(), value: result.value }, tool.quiet);
        else if (result.ok === false)
          return refuse(result.code, result.message);
        else throw new Error("Unknown tool result.");
      } catch {
        return refuse("extension_error", "The tool could not read its data. Reload the extension and try again.");
      }
    } else throw new Error("Unknown operation.");
  };
}
