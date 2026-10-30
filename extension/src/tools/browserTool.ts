import type { ToolFile } from "../../../shared/protocol.ts";

export type ToolResult = { ok: true; value: unknown }
  | { ok: false; code: "not_signed_in" | "extension_error" | "tab_missing" | "tab_not_ready" | "tool_args_invalid" | "result_too_large"; message: string };

// A script the tool needs in its site's main world from document_start, registered only while the tool is enabled and permitted.
export type PageScript = { id: string; file: string; matches: string[] };

export interface BrowserTool {
  readonly id: string;
  readonly section: string;
  readonly group: string;
  readonly title: string;
  readonly hosts: string[];
  readonly sensitive: boolean;
  readonly quiet?: boolean;
  readonly pageScripts?: PageScript[];
  // Only such a tool receives the files a caller passes with --file; the dispatcher refuses them for any other.
  readonly acceptsFiles?: boolean;
  run(args: unknown, files?: ToolFile[]): Promise<ToolResult>;
}

export type ToolSection = { id: string; title: string };
export type ToolGroup = { section: string; id: string; title: string };
