import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { protocolVersion } from "../../shared/protocol.ts";
import type { PipeRequest, ProfileInfo } from "../../shared/protocol.ts";
import { endpointDirectory, profileEndpoint } from "../../shared/transport.ts";
import { runCli } from "../browserAgent.ts";
import { requestPipe } from "../pipeClient.ts";

const cleanup: (() => void)[] = [];
afterEach(() => { vi.useRealTimers(); cleanup.splice(0).reverse().forEach(fn => fn()); });

async function fakeProfile(silent = false, version = protocolVersion) {
  const id = randomUUID();
  const profile: ProfileInfo = { instanceId: id, label: null, agentAccess: true, extensionVersion: "0.1.0", protocolVersion: version,
    tools: [{ id: "fixture.session.read", section: "fixture", group: "session", title: "Fixture session", hosts: [], sensitive: true, enabled: true }] };
  const calls: PipeRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk.toString();
      if (!buffer.includes("\n"))
        return;
      const request: PipeRequest = JSON.parse(buffer.split("\n")[0]);
      calls.push(request);
      if (!silent)
        socket.end(JSON.stringify({ ok: true, profile, ...(request.op === "call" ? { value: [{ name: "fixture", value: "invented-cookie-value" }] } : {}) }) + "\n");
    });
  });
  const pipe = profileEndpoint(id);
  if (process.platform === "darwin")
    mkdirSync(endpointDirectory(), { recursive: true, mode: 0o700 });
  server.listen(pipe);
  await once(server, "listening");
  cleanup.push(() => { sockets.forEach(socket => socket.destroy()); server.close(); });
  return { pipe, profile, calls };
}

it("real CLI refuses sensitive output before call and writes only the requested file", async () => {
  const fixture = await fakeProfile();
  const args = ["call", fixture.profile.instanceId, "fixture.session.read"];
  expect(await runCli(args)).toMatchObject({ exitCode: 3, output: { code: "output_required" } });
  expect(fixture.calls.filter(request => request.op === "call")).toHaveLength(0);
  const base = fileURLToPath(new URL("../../../.aidocs/temp/", import.meta.url));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "browser-agent-cli-"));
  const out = join(directory, "output.json");
  cleanup.push(() => { rmSync(out, { force: true }); rmdirSync(directory); });
  const child = spawn(process.execPath, [fileURLToPath(new URL("../browserAgent.ts", import.meta.url)), ...args, "--out", out]);
  cleanup.push(() => child.kill());
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => stdout += chunk.toString());
  child.stderr.on("data", chunk => stderr += chunk.toString());
  expect((await once(child, "exit"))[0]).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ ok: true, wrote: out });
  expect(stdout + stderr).not.toContain("invented-cookie-value");
  expect(JSON.parse(readFileSync(out, "utf8"))).toEqual([{ name: "fixture", value: "invented-cookie-value" }]);
  expect(fixture.calls.filter(request => request.op === "call")).toEqual([{ op: "call", protocolVersion, tool: "fixture.session.read", caller: "cli" }]);
});

it("list omits an unresponsive pipe after three seconds and retains live unlabeled profiles", async () => {
  const live = await fakeProfile();
  const silent = await fakeProfile(true);
  const result = await runCli(["list"]);
  expect(result.exitCode).toBe(0);
  expect(result.output).toEqual(expect.arrayContaining([live.profile]));
  expect(result.output).not.toEqual(expect.arrayContaining([silent.profile]));
  expect(silent.calls).toEqual([{ op: "describe", protocolVersion }]);
});

it("protocol skew is refused before a tool call", async () => {
  const fixture = await fakeProfile(false, 99);
  expect(await requestPipe(fixture.pipe, { op: "describe", protocolVersion })).toMatchObject({ code: "protocol_mismatch" });
  expect(fixture.calls.every(request => request.op === "describe")).toBe(true);
});

it("version 1 peers are refused before a tool call", async () => {
  const fixture = await fakeProfile(false, 1);
  expect(await requestPipe(fixture.pipe, { op: "describe", protocolVersion })).toMatchObject({ code: "protocol_mismatch" });
  expect(fixture.calls.every(request => request.op === "describe")).toBe(true);
});

it("passes JSON object arguments through the real pipe", async () => {
  const fixture = await fakeProfile();
  fixture.profile.tools[0].sensitive = false;
  expect(await runCli(["call", fixture.profile.instanceId, "fixture.session.read", "--args", '{"a":1}']))
    .toMatchObject({ exitCode: 0 });
  expect(fixture.calls.filter(request => request.op === "call"))
    .toEqual([{ op: "call", protocolVersion, tool: "fixture.session.read", caller: "cli", args: { a: 1 } }]);
});

it("sends each --file by name and base64 content; a missing file exits 2 before discovery", async () => {
  const fixture = await fakeProfile();
  fixture.profile.tools[0].sensitive = false;
  const base = fileURLToPath(new URL("../../../.aidocs/temp/", import.meta.url));
  mkdirSync(base, { recursive: true });
  const directory = mkdtempSync(join(base, "browser-agent-cli-"));
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, "a.txt"), "příloha");
  writeFileSync(join(directory, "b.bin"), Buffer.from([0, 255]));
  const call = ["call", fixture.profile.instanceId, "fixture.session.read"];
  expect(await runCli([...call, "--file", join(directory, "a.txt"), "--file", join(directory, "b.bin")])).toMatchObject({ exitCode: 0 });
  expect(fixture.calls.filter(request => request.op === "call")).toEqual([{ op: "call", protocolVersion, tool: "fixture.session.read", caller: "cli",
    files: [{ name: "a.txt", data: Buffer.from("příloha").toString("base64") }, { name: "b.bin", data: "AP8=" }] }]);
  const calls = fixture.calls.length;
  expect(await runCli([...call, "--file", join(directory, "missing.pdf")])).toMatchObject({ exitCode: 2, output: { message: expect.stringContaining("missing.pdf") } });
  expect(await runCli([...call, "--file", directory])).toMatchObject({ exitCode: 2 });
  expect(fixture.calls).toHaveLength(calls);
});

it.each(["[1]", "not json", "null", "true", "1", '"text"'])("refuses invalid arguments %s before discovery", async args => {
  const fixture = await fakeProfile();
  expect(await runCli(["call", fixture.profile.instanceId, "fixture.session.read", "--args", args]))
    .toMatchObject({ exitCode: 2, output: { code: "usage", message: expect.stringContaining("--args") } });
  expect(fixture.calls).toEqual([]);
});

it("duplicate labels refuse the call and identify both instances", async () => {
  const a = await fakeProfile();
  const b = await fakeProfile();
  const label = `fixture-${randomUUID()}`;
  a.profile.label = label;
  b.profile.label = label.toUpperCase();
  const result = await runCli(["call", label, "fixture.session.read", "--out", "unused.json"]);
  expect(result).toMatchObject({ exitCode: 3, output: { code: "profile_ambiguous" } });
  expect(JSON.stringify(result.output)).toContain(a.profile.instanceId);
  expect(JSON.stringify(result.output)).toContain(b.profile.instanceId);
  expect([...a.calls, ...b.calls].every(request => request.op === "describe")).toBe(true);
});

it("invalid CLI grammar exits 2 before discovery", async () => {
  for (const argv of [[], ["unknown"], ["list", "extra"], ["call"], ["call", "work", "tool", "--out"], ["call", "work", "tool", "--bad", "x"]])
    expect(await runCli(argv)).toMatchObject({ exitCode: 2, output: { code: "usage" } });
});
