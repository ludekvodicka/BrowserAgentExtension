import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { beforeEach, expect, it, vi } from "vitest";
import { hostName } from "../../shared/protocol.ts";
import { registerHost, registrationPresent, registrationTargets, registryKey } from "../registration.ts";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));
vi.mock("node:fs", async () => ({ ...await vi.importActual("node:fs"), existsSync: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

const home = "/Users/test";
const manifests = [
  `/Users/test/Library/Application Support/Google/Chrome/NativeMessagingHosts/${hostName}.json`,
  `/Users/test/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/${hostName}.json`,
];

it("lets the built host install itself and adds the extension folder to load", () => {
  vi.mocked(existsSync).mockReturnValue(true);
  vi.mocked(execFileSync).mockReturnValue('{"ok":true,"host":"/installed/browser-agent-host"}\n');
  const result = registerHost("/build/browser-agent-host");
  expect(execFileSync).toHaveBeenCalledWith("/build/browser-agent-host", ["install"], { encoding: "utf8", windowsHide: true });
  expect(result).toMatchObject({ ok: true, host: "/installed/browser-agent-host" });
  expect(result.loadUnpacked).toMatch(/dist[\\/]extension$/);
});

it("refuses to register a host that is not built", () => {
  vi.mocked(existsSync).mockReturnValue(false);
  expect(() => registerHost("/missing")).toThrow("npm run build");
  expect(execFileSync).not.toHaveBeenCalled();
});

it("finds either macOS browser registration and the Windows registry key", () => {
  expect(registrationTargets("win32", "ignored")).toEqual({ registryKey });
  expect(registrationTargets("darwin", home)).toEqual({ hostManifests: manifests });
  vi.mocked(existsSync).mockReturnValue(false);
  expect(registrationPresent("darwin", home)).toBe(false);
  vi.mocked(existsSync).mockImplementation(path => path === manifests[1]);
  expect(registrationPresent("darwin", home)).toBe(true);
  expect(execFileSync).not.toHaveBeenCalled();
  expect(registrationPresent("win32", home)).toBe(true);
  expect(execFileSync).toHaveBeenCalledWith("reg.exe", ["query", registryKey, "/ve"], { stdio: "ignore", windowsHide: true });
  expect(() => registrationTargets("linux", home)).toThrow("Windows and macOS");
});
