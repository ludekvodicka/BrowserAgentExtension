import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { hostName } from "../shared/protocol.ts";

export const registryKey = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${hostName}`;

export function hostBinary(platform: NodeJS.Platform = process.platform): string {
  return fileURLToPath(new URL(`../host/target/release/browser-agent-host${platform === "win32" ? ".exe" : ""}`, import.meta.url));
}

export function registrationTargets(platform: NodeJS.Platform = process.platform, home = homedir()) {
  if (platform === "win32")
    return { registryKey };
  else if (platform === "darwin")
    return { hostManifests: ["Google/Chrome", "BraveSoftware/Brave-Browser"].map(browser =>
      posix.join(home, "Library/Application Support", browser, "NativeMessagingHosts", `${hostName}.json`)) };
  else throw new Error("Browser Agent supports Windows and macOS.");
}

export function registrationPresent(platform: NodeJS.Platform = process.platform, home = homedir()): boolean {
  const targets = registrationTargets(platform, home);
  if (platform === "darwin")
    return targets.hostManifests!.some(path => existsSync(path));
  else if (platform !== "win32")
    throw new Error("Browser Agent supports Windows and macOS.");
  try {
    execFileSync("reg.exe", ["query", registryKey, "/ve"], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

// The host binary owns installation, so a release download registers itself the same way.
export function registerHost(source = hostBinary()) {
  if (!existsSync(source))
    throw new Error(`The native host is not built: ${source}. Run npm run build first.`);
  const extension = fileURLToPath(new URL("../dist/extension", import.meta.url));
  // A checkout loads the build output itself, so install records that folder instead of copying it.
  const args = existsSync(join(extension, "manifest.json")) ? ["install", "--extension", extension] : ["install"];
  const result: unknown = JSON.parse(execFileSync(source, args, { encoding: "utf8", windowsHide: true }));
  return { ...result as object, loadUnpacked: extension };
}
