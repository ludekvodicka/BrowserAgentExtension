import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export function extensionIdFromKey(key: string): string {
  if (!key || !/^[A-Za-z0-9+/]+={0,2}$/.test(key))
    throw new Error("The extension manifest has no valid public key.");
  return createHash("sha256").update(Buffer.from(key, "base64")).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
}

export function readExtensionId(): string {
  const manifest = JSON.parse(readFileSync(new URL("../extension/manifest.json", import.meta.url), "utf8"));
  return extensionIdFromKey(manifest.key);
}
