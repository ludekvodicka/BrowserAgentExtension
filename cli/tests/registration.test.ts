import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { extensionIdFromKey, readExtensionId } from "../../shared/extensionId.ts";
import { hostBinary, registryKey } from "../registration.ts";

it("derives one extension ID from the manifest key and names the built host", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../extension/manifest.json", import.meta.url), "utf8"));
  const id = extensionIdFromKey(manifest.key);
  expect(readExtensionId()).toBe(id);
  expect(id).toMatch(/^[a-p]{32}$/);
  expect(registryKey).toBe("HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.ludekvodicka.browser_agent");
  expect(hostBinary("win32")).toMatch(/host[\\/]target[\\/]release[\\/]browser-agent-host\.exe$/);
  expect(hostBinary("darwin")).toMatch(/host[\\/]target[\\/]release[\\/]browser-agent-host$/);
});
