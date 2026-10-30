import { expect, it } from "vitest";
import { endpointDirectory, profileEndpoint } from "../transport.ts";

const id = "00000000-0000-4000-8000-000000000000";

it("keeps Windows pipes and macOS socket paths independent of the test OS", () => {
  expect(endpointDirectory("win32", "ignored")).toBe("\\\\.\\pipe\\");
  expect(profileEndpoint(id, "win32", "ignored")).toBe(`\\\\.\\pipe\\browser-agent-${id}`);
  expect(endpointDirectory("darwin", "/Users/test")).toBe("/Users/test/.browser-agent/run");
  expect(profileEndpoint(id, "darwin", "/Users/test")).toBe(`/Users/test/.browser-agent/run/browser-agent-${id}.sock`);
});

it("enforces the macOS byte limit before the OS can truncate a socket path", () => {
  const tail = `/.browser-agent/run/browser-agent-${id}.sock`;
  const home = "/" + "a".repeat(102 - Buffer.byteLength(tail));
  expect(Buffer.byteLength(profileEndpoint(id, "darwin", home))).toBe(103);
  expect(() => profileEndpoint(id, "darwin", home + "a")).toThrow("104 UTF-8 bytes");
  expect(() => profileEndpoint(id, "darwin", "/Users/" + "é".repeat(20))).toThrow("104 UTF-8 bytes");
});

it("refuses invalid profile identities, relative homes and unsupported platforms", () => {
  expect(() => profileEndpoint("../../other", "darwin", "/Users/test")).toThrow("instance ID");
  expect(() => profileEndpoint(id, "darwin", "relative")).toThrow("absolute home");
  expect(() => endpointDirectory("linux", "/home/test")).toThrow("Windows and macOS");
});
