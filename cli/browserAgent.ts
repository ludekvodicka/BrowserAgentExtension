import { readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord, maxFileBytes, protocolVersion } from "../shared/protocol.ts";
import type { ToolFile } from "../shared/protocol.ts";
import { discoverProfiles, requestPipe } from "./pipeClient.ts";
import { resolveProfile } from "./profileResolver.ts";
import { registerHost, registrationPresent, registrationTargets } from "./registration.ts";

const usage = "browser-agent register | list | call <profile> <tool> [--args <json-object>] [--file <path>]... [--out <file>] [--caller <name>]";

export async function runCli(argv: string[]): Promise<{ exitCode: number; output: unknown }> {
  const [command, selector, toolId, ...options] = argv;
  if ((command === "register" || command === "list") && argv.length !== 1)
    return { exitCode: 2, output: { ok: false, code: "usage", message: usage } };
  let out: string | undefined;
  let args: Record<string, unknown> | undefined;
  let caller = "cli";
  const filePaths: string[] = [];
  if (command === "call") {
    if (!selector || !toolId || options.length % 2)
      return { exitCode: 2, output: { ok: false, code: "usage", message: usage } };
    const seen = new Set<string>();
    for (let i = 0; i < options.length; i += 2) {
      const flag = options[i];
      const value = options[i + 1];
      if (!value || value.startsWith("--") || seen.has(flag) && flag !== "--file")
        return { exitCode: 2, output: { ok: false, code: "usage", message: usage } };
      seen.add(flag);
      if (flag === "--file")
        filePaths.push(resolve(value));
      else if (flag === "--out")
        out = value;
      else if (flag === "--caller")
        caller = value;
      else if (flag === "--args") {
        try {
          const parsed: unknown = JSON.parse(value);
          if (!isRecord(parsed))
            return { exitCode: 2, output: { ok: false, code: "usage", message: usage } };
          args = parsed;
        } catch {
          return { exitCode: 2, output: { ok: false, code: "usage", message: usage } };
        }
      }
      else return { exitCode: 2, output: { ok: false, code: "usage", message: usage } };
    }
    if (caller.length > 128 || toolId.length > 128 || filePaths.length > 20)
      return { exitCode: 2, output: { ok: false, code: "usage", message: usage } };
    const sizes = filePaths.map(path => {
      try {
        const stat = statSync(path);
        return stat.isFile() ? stat.size : null;
      } catch {
        return null;
      }
    });
    const unreadable = filePaths.filter((_, i) => sizes[i] === null);
    if (unreadable.length)
      return { exitCode: 2, output: { ok: false, code: "usage", message: `Cannot read --file ${unreadable.join(", ")}.` } };
    if (sizes.reduce((sum: number, size) => sum + size!, 0) > maxFileBytes)
      return { exitCode: 2, output: { ok: false, code: "usage", message: "The files of one call may have at most 25 MB together." } };
  } else if (command !== "register" && command !== "list")
    return { exitCode: 2, output: { ok: false, code: "usage", message: usage } };
  try {
    if (command === "register")
      return { exitCode: 0, output: { ok: true, ...registerHost() } };
    const { profiles, refused } = await discoverProfiles();
    if (!profiles.length) {
      const mismatch = refused.find(response => !response.ok && response.code === "protocol_mismatch");
      if (mismatch)
        return { exitCode: 3, output: mismatch };
      const registered = registrationPresent();
      const targets = registrationTargets();
      const location = targets.registryKey ?? targets.hostManifests!.join(" or ");
      return { exitCode: 3, output: { ok: false, code: "no_profiles", registered, ...targets,
        message: `No connected profiles. ${location} is ${registered ? "present" : "missing; run browser-agent register"}. Open Brave or Chrome with the extension loaded.` } };
    }
    if (command === "list")
      return { exitCode: 0, output: profiles.map(({ profile }) => profile) };
    else if (command === "call") {
      const selected = resolveProfile(profiles, selector);
      if (!selected.ok)
        return { exitCode: 3, output: selected };
      const { profile, pipe } = selected.selected;
      const tool = profile.tools.find(item => item.id === toolId);
      if (!tool)
        return { exitCode: 3, output: { ok: false, code: "tool_unknown", message: `${profile.label || profile.instanceId}: Select a tool shown by browser-agent list, or update the extension.` } };
      if (tool.sensitive && !out)
        return { exitCode: 3, output: { ok: false, code: "output_required", message: `${profile.label || profile.instanceId}: ${tool.title} requires --out <file>. Its value cannot be printed.` } };
      const files: ToolFile[] = filePaths.map(path => ({ name: basename(path), data: readFileSync(path).toString("base64") }));
      const response = await requestPipe(pipe, { op: "call", protocolVersion, tool: toolId, caller, ...(args ? { args } : {}), ...(files.length ? { files } : {}) });
      if (!response.ok)
        return { exitCode: 3, output: response };
      if (!out && response.profile.tools.find(item => item.id === toolId)?.sensitive !== false)
        return { exitCode: 3, output: { ok: false, code: "output_required", message: "This tool now requires --out <file>. Its value was not printed." } };
      if (out) {
        const path = resolve(out);
        writeFileSync(path, JSON.stringify(response.value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
        return { exitCode: 0, output: { ok: true, profile: response.profile, wrote: path } };
      }
      return { exitCode: 0, output: response };
    } else throw new Error("Unknown command.");
  } catch {
    return { exitCode: 3, output: { ok: false, code: "extension_error", message: "Operation failed. Check registration, the browser profile and any output directory, then try again." } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await runCli(process.argv.slice(2));
  process.stdout.write(JSON.stringify(result.output) + "\n");
  process.exitCode = result.exitCode;
}
