import { homedir } from "node:os";
import { posix } from "node:path";
import { pipePrefix } from "./protocol.ts";

export function endpointDirectory(platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (platform === "win32")
    return "\\\\.\\pipe\\";
  else if (platform === "darwin") {
    if (!posix.isAbsolute(home))
      throw new Error("The socket directory requires an absolute home path.");
    return posix.join(home, ".browser-agent", "run");
  } else throw new Error("Browser Agent supports Windows and macOS.");
}

export function profileEndpoint(instanceId: string, platform: NodeJS.Platform = process.platform, home = homedir()): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(instanceId))
    throw new Error("Invalid profile instance ID.");
  const directory = endpointDirectory(platform, home);
  if (platform === "win32")
    return `${directory}${pipePrefix}${instanceId}`;
  else if (platform === "darwin") {
    const path = posix.join(directory, `${pipePrefix}${instanceId}.sock`);
    if (Buffer.byteLength(path, "utf8") >= 104)
      throw new Error("Browser Agent socket path must be shorter than 104 UTF-8 bytes.");
    return path;
  } else throw new Error("Browser Agent supports Windows and macOS.");
}
