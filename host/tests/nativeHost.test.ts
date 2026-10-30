import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { basename } from "node:path";
import { createConnection } from "node:net";
import { afterEach, beforeAll, expect, it } from "vitest";
import { hostBinary } from "../../cli/registration.ts";
import { readExtensionId } from "../../shared/extensionId.ts";
import { fileChunkChars, maxFileBytes, maxMessageBytes, protocolVersion } from "../../shared/protocol.ts";
import type { FileChunkMessage, ProfileInfo, RelayRequest } from "../../shared/protocol.ts";
import { endpointDirectory, profileEndpoint } from "../../shared/transport.ts";

// The host is the Rust binary; these tests drive it as the browser does, through stdin and stdout.
const cleanups: (() => void)[] = [];
afterEach(() => cleanups.splice(0).reverse().forEach(cleanup => cleanup()));
beforeAll(() => {
  execFileSync("cargo", ["build", "--release", "--quiet"], { cwd: new URL("..", import.meta.url), stdio: "inherit" });
}, 300000);

const profile = (): ProfileInfo => ({ instanceId: randomUUID(), label: "fixture", agentAccess: false, extensionVersion: "0.1.0", protocolVersion, tools: [] });
const origin = `chrome-extension://${readExtensionId()}/`;
const endpointExists = (instanceId: string) =>
  existsSync(endpointDirectory()) && readdirSync(endpointDirectory()).includes(basename(profileEndpoint(instanceId)));

function encodeFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function messages(stream: NodeJS.ReadableStream) {
  let buffer = Buffer.alloc(0);
  const queued: unknown[] = [];
  const readers: ((value: unknown) => void)[] = [];
  stream.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      const message: unknown = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8"));
      buffer = buffer.subarray(4 + length);
      const reader = readers.shift();
      if (reader)
        reader(message);
      else queued.push(message);
    }
  });
  return () => queued.length ? Promise.resolve(queued.shift()) : new Promise<unknown>(resolve => readers.push(resolve));
}

function client(pipe: string, version = protocolVersion, request: object = { op: "describe", protocolVersion: version }) {
  const socket = createConnection(pipe);
  cleanups.push(() => socket.destroy());
  let text = "";
  const response = new Promise<{ ok: boolean; code?: string; value?: unknown }>((resolve, reject) => {
    socket.on("data", chunk => {
      text += chunk.toString();
      if (text.includes("\n"))
        resolve(JSON.parse(text));
    });
    socket.on("error", reject);
  });
  socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
  return response.finally(() => socket.end());
}

function host(hostOrigin = origin) {
  const child = spawn(hostBinary(), [hostOrigin], { stdio: "pipe" });
  cleanups.push(() => child.kill());
  let stderr = "";
  child.stderr.on("data", chunk => stderr += chunk.toString());
  return { child, next: messages(child.stdout), exited: once(child, "exit"), stderr: () => stderr };
}

async function ready(h: ReturnType<typeof host>, p = profile()) {
  h.child.stdin.write(encodeFrame({ type: "hello", profile: p }));
  return await h.next() as { type: string; pipe: string };
}

it("relays concurrent clients by id", async () => {
  const h = host();
  const p = profile();
  const { pipe } = await ready(h, p);
  expect(pipe).toBe(profileEndpoint(p.instanceId));
  const a = client(pipe);
  const requestA = await h.next() as RelayRequest;
  const b = client(pipe);
  const requestB = await h.next() as RelayRequest;
  expect(requestA.id).not.toBe(requestB.id);
  h.child.stdin.write(encodeFrame({ id: requestB.id, ok: true, profile: p, value: "b" }));
  h.child.stdin.write(encodeFrame({ id: requestA.id, ok: true, profile: p, value: "a" }));
  expect((await b).value).toBe("b");
  expect((await a).value).toBe("a");
  h.child.stdin.write(encodeFrame({ id: requestA.id, ok: true, profile: p }));
  expect((await client(pipe, 99)).code).toBe("protocol_mismatch");
});

it("sends a call's files in ordered chunks under the native message cap, then the call without them", async () => {
  const h = host();
  const { pipe } = await ready(h);
  const big = "QUJD".repeat((fileChunkChars + 4000) / 4);
  void client(pipe, protocolVersion, { op: "call", protocolVersion, tool: "fixture", caller: "test", args: { a: 1 },
    files: [{ name: "big.bin", data: big }, { name: "empty.txt", data: "" }] });
  const chunks = [await h.next(), await h.next(), await h.next()] as FileChunkMessage[];
  expect(chunks.map(({ index, name, data }) => [index, name, data.length])).toEqual([[0, "big.bin", fileChunkChars], [0, "big.bin", 4000], [1, "empty.txt", 0]]);
  expect(chunks[0].data + chunks[1].data).toBe(big);
  expect(new Set(chunks.map(chunk => chunk.id)).size).toBe(1);
  const call = await h.next() as RelayRequest;
  expect(call).toEqual({ op: "call", protocolVersion, tool: "fixture", caller: "test", args: { a: 1 }, id: chunks[0].id });
});

it("refuses files over 25 MB without relaying anything", async () => {
  const h = host();
  const { pipe } = await ready(h);
  const response = await client(pipe, protocolVersion, { op: "call", protocolVersion, tool: "fixture", caller: "test",
    files: [{ name: "big.bin", data: "QUJD".repeat(maxFileBytes / 3 + 1) }] });
  expect(response).toMatchObject({ ok: false, code: "tool_args_invalid" });
});

it("refuses an invalid request line", async () => {
  const h = host();
  const { pipe } = await ready(h);
  expect(await client(pipe, protocolVersion, { op: "watch", protocolVersion })).toMatchObject({ ok: false, code: "extension_error" });
});

it("refuses incompatible hello before creating a pipe", async () => {
  const h = host();
  const p = { ...profile(), protocolVersion: 99 };
  h.child.stdin.write(encodeFrame({ type: "hello", profile: p }));
  expect(await h.next()).toMatchObject({ type: "refused", code: "protocol_mismatch" });
  expect((await h.exited)[0]).toBe(1);
  expect(endpointExists(p.instanceId)).toBe(false);
});

it("refuses a busy profile pipe after the bounded retries", async () => {
  const first = host();
  const p = profile();
  await ready(first, p);
  const second = host();
  expect(await ready(second, p)).toMatchObject({ type: "refused", code: "pipe_busy" });
  expect((await second.exited)[0]).toBe(1);
  expect(first.child.exitCode).toBeNull();
});

it("is silent until hello, disconnects pending requests and removes its pipe", async () => {
  const h = host();
  const p = profile();
  const { type, pipe } = await ready(h, p);
  expect(type).toBe("ready");
  const response = client(pipe);
  expect(await h.next()).toMatchObject({ op: "describe" });
  h.child.stdin.end();
  expect((await response).code).toBe("extension_disconnected");
  expect((await h.exited)[0]).toBe(0);
  expect(endpointExists(p.instanceId)).toBe(false);
  expect(h.stderr()).toBe("");
});

it("exits 1 on an unexpected native message", async () => {
  const h = host();
  await ready(h);
  h.child.stdin.write(encodeFrame({ type: "hello", profile: profile() }));
  expect((await h.exited)[0]).toBe(1);
});

it.each(["origin", "oversize"])("rejects %s with exit 1 and no output", async mode => {
  const h = host(mode === "origin" ? "chrome-extension://invalid/" : origin);
  let stdout = "";
  h.child.stdout.on("data", chunk => stdout += chunk.toString());
  if (mode === "oversize") {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(maxMessageBytes + 1);
    h.child.stdin.write(header);
  }
  expect((await h.exited)[0]).toBe(1);
  expect(stdout).toBe("");
});
