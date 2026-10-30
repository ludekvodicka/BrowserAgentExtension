import { readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { endpointDirectory, profileEndpoint } from "../shared/transport.ts";
import { isResponse, maxMessageBytes, pipePrefix, protocolVersion } from "../shared/protocol.ts";
import type { PipeRequest, PipeResponse, ProfileInfo } from "../shared/protocol.ts";

export type ConnectedProfile = { pipe: string; profile: ProfileInfo };

export function requestPipe(pipe: string, request: PipeRequest): Promise<PipeResponse> {
  let timeout: number;
  if (request.op === "describe")
    timeout = 3000;
  else if (request.op === "call")
    timeout = request.files?.length ? 32000 : 15000;
  else throw new Error("Unknown pipe operation.");
  return new Promise(resolve => {
    const socket = createConnection(pipe);
    let bytes = Buffer.alloc(0);
    let settled = false;
    function finish(response: PipeResponse): void {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(response);
    }
    const unavailable = (): void => finish({ ok: false, code: "extension_disconnected", message: "Profile disconnected. Open Brave or Chrome with Browser Agent loaded, then list profiles again." });
    const timer = setTimeout(() => finish({ ok: false, code: "extension_timeout", message: "Profile did not answer. Reload Browser Agent in that browser profile." }), timeout);
    socket.on("error", unavailable);
    socket.on("end", unavailable);
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", chunk => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > maxMessageBytes) {
        finish({ ok: false, code: "extension_error", message: "Profile response is too large. Update the extension and CLI." });
        return;
      }
      const newline = bytes.indexOf(10);
      if (newline < 0)
        return;
      try {
        const response: unknown = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
        if (!isResponse(response))
          throw new Error("Invalid response.");
        if (response.profile && response.profile.protocolVersion !== protocolVersion) {
          finish({ ok: false, code: "protocol_mismatch", message: `${response.profile.label || response.profile.instanceId}: Update the extension and CLI together.` });
          return;
        }
        finish(response);
      } catch {
        finish({ ok: false, code: "extension_error", message: "Invalid profile response. Update the extension and CLI." });
      }
    });
  });
}

export async function discoverProfiles(platform: NodeJS.Platform = process.platform, home = homedir()): Promise<{ profiles: ConnectedProfile[]; refused: PipeResponse[] }> {
  const directory = endpointDirectory(platform, home);
  let endpoints: string[];
  if (platform === "win32")
    endpoints = readdirSync(directory).filter(name => name.startsWith(pipePrefix)).map(name => `${directory}${name}`);
  else if (platform === "darwin") {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { profiles: [], refused: [] };
      throw error;
    }
    endpoints = names.filter(name => /^browser-agent-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sock$/i.test(name))
      .map(name => profileEndpoint(name.slice(pipePrefix.length, -5), platform, home));
  } else throw new Error("Browser Agent supports Windows and macOS.");
  const replies = await Promise.all(endpoints.map(async pipe => {
    return { pipe, response: await requestPipe(pipe, { op: "describe", protocolVersion }) };
  }));
  return {
    profiles: replies.flatMap(({ pipe, response }) => response.ok ? [{ pipe, profile: response.profile }] : []),
    refused: replies.flatMap(({ response }) => response.ok ? [] : [response]),
  };
}
