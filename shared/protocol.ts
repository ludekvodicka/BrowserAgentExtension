export const protocolVersion = 4;
export const hostName = "com.ludekvodicka.browser_agent";
export const maxMessageBytes = 1024 * 1024;
// Files ride in the pipe request; Gmail takes at most 25 MB of attachments, 34 MB as base64.
export const maxFileBytes = 25 * 1024 * 1024;
export const maxRequestBytes = 36 * 1024 * 1024;
// The browser caps a host-to-extension message at 1 MiB, so the host sends file data in chunks of whole base64 groups.
export const fileChunkChars = 800_000;
export const pipePrefix = "browser-agent-";

export type ToolInfo = { id: string; section: string; group: string; title: string; hosts: string[]; sensitive: boolean; enabled: boolean };
export type ProfileInfo = { instanceId: string; label: string | null; agentAccess: boolean; extensionVersion: string; protocolVersion: number; tools: ToolInfo[] };
export type HelloMessage = { type: "hello"; profile: ProfileInfo };
export type ReadyMessage = { type: "ready"; pipe: string } | { type: "refused"; code: "protocol_mismatch" | "pipe_busy"; message: string };
// A file the caller passes to a tool: its name and base64 content.
export type ToolFile = { name: string; data: string };
export type FileChunkMessage = { type: "fileChunk"; id: string; index: number; name: string; data: string };
export type PipeRequest = { protocolVersion: number } & ({ op: "describe" } | { op: "call"; tool: string; caller: string; args?: unknown; files?: ToolFile[] });
export type ErrorCode = "access_off" | "tool_unknown" | "tool_denied" | "permission_missing" | "not_signed_in"
  | "protocol_mismatch" | "extension_disconnected" | "extension_timeout" | "extension_error"
  | "profile_not_found" | "profile_ambiguous" | "no_profiles" | "output_required"
  | "tab_missing" | "tab_not_ready" | "tool_args_invalid" | "result_too_large";
export type PipeResponse = { ok: true; profile: ProfileInfo; value?: unknown } | { ok: false; code: ErrorCode; message: string; profile?: ProfileInfo };
export type RelayRequest = { id: string } & PipeRequest;
export type RelayResponse = { id: string } & PipeResponse;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProfile(value: unknown): value is ProfileInfo {
  return isRecord(value) && typeof value.instanceId === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.instanceId)
    && (value.label === null || typeof value.label === "string") && typeof value.agentAccess === "boolean"
    && typeof value.extensionVersion === "string" && Number.isInteger(value.protocolVersion)
    && Array.isArray(value.tools) && value.tools.every(tool => isRecord(tool)
      && [tool.id, tool.section, tool.group, tool.title].every(v => typeof v === "string")
      && Array.isArray(tool.hosts) && tool.hosts.every(v => typeof v === "string")
      && typeof tool.sensitive === "boolean" && typeof tool.enabled === "boolean");
}

export function isRequest(value: unknown): value is PipeRequest {
  if (!isRecord(value) || !Number.isInteger(value.protocolVersion))
    return false;
  if (value.op === "describe")
    return true;
  else if (value.op === "call")
    return typeof value.tool === "string" && value.tool.length > 0 && value.tool.length <= 128
      && typeof value.caller === "string" && value.caller.length > 0 && value.caller.length <= 128
      && (value.files === undefined || Array.isArray(value.files) && value.files.length <= 20 && value.files.every(isToolFile));
  else return false;
}

export function isToolFile(value: unknown): value is ToolFile {
  return isRecord(value) && typeof value.name === "string" && value.name.length > 0 && value.name.length <= 255
    && typeof value.data === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(value.data);
}

export function isFileChunk(value: unknown): value is FileChunkMessage {
  return isRecord(value) && value.type === "fileChunk" && typeof value.id === "string" && Number.isInteger(value.index)
    && typeof value.name === "string" && typeof value.data === "string";
}

const errorCodes: readonly ErrorCode[] = ["access_off", "tool_unknown", "tool_denied", "permission_missing", "not_signed_in",
  "protocol_mismatch", "extension_disconnected", "extension_timeout", "extension_error", "profile_not_found",
  "profile_ambiguous", "no_profiles", "output_required", "tab_missing", "tab_not_ready", "tool_args_invalid", "result_too_large"];

export function isResponse(value: unknown): value is PipeResponse {
  if (!isRecord(value))
    return false;
  if (value.ok === true)
    return isProfile(value.profile);
  else if (value.ok === false)
    return errorCodes.some(code => code === value.code) && typeof value.message === "string"
      && (value.profile === undefined || isProfile(value.profile));
  else return false;
}
