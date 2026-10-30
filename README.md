# Browser Agent

A Chromium Manifest V3 extension for Brave and Chrome that lets a coding agent (Claude Code, Codex) use
tools in the user's own signed-in browser profiles. Each profile decides what the agent may use: a master
switch "Agent access" and one switch per tool, both off by default. The tools read Slack (session
cookies, read-only API calls), Outlook mail and the open Gmail conversation (both read-only) from the
profile's open tabs, save that conversation's attachments into the browser's download folder, and
open a filled Gmail draft or a reply to the open conversation, with attached files, that only the
user sends. A browser tool opens a web page in a new tab of
the profile. The Meetings tab lists Google Meet, Zoom Web and Teams Web meeting tabs on demand.

The project has three parts that share one wire protocol (`shared/protocol.ts`):

| Part | Path | Role |
|---|---|---|
| Extension | `extension/`, built into `dist/extension` | Holds the tools, the permission gate, the popup and the request log of each profile |
| Native host | `host/` (Rust) | Started by the browser once per profile; relays between the extension and a Windows named pipe or macOS Unix socket |
| CLI | `cli/browserAgent.ts` | Lists connected profiles, calls a tool, registers the native host |

Design and reasons: [docs/architecture/agent-channel.md](docs/architecture/agent-channel.md).

## Install from a release

Download the package for your system from the
[releases](https://github.com/ludekvodicka/BrowserAgentExtension/releases): `windows-x64` or
`macos-universal`. It holds the extension (`extension/`) and the native host binary. Neither needs
Node.js.

1. Unzip it to a folder you keep.
2. Register the native host from that folder:
   - Windows: `browser-agent-host.exe install`
   - macOS: `xattr -dr com.apple.quarantine .` and then `./browser-agent-host install`. The binary is
     not notarized, so macOS refuses to start a downloaded copy until the quarantine flag is removed.
3. In each Brave or Chrome profile that should be reachable, open `brave://extensions` or
   `chrome://extensions`, turn on Developer mode, choose Load unpacked and select the `extension`
   folder.
4. Open the extension popup, set a label (for example `work`), turn on Agent access and enable the
   tools the agent may use. Enabling a tool asks the browser for the site permission that tool needs.

`browser-agent-host uninstall` removes the registration and the installed copy.

The fixed `key` in `extension/manifest.json` gives the extension the same ID in every profile, so one
registration serves all of them, and a reload keeps each profile's label and grants.

## Build from source

Requirements: Windows or macOS with Brave or Chrome, Node.js 24 or newer (the CLI runs as TypeScript
directly) and Rust (stable `cargo`) for the native host.

```sh
npm ci
npm run build
node cli/browserAgent.ts register
```

`npm run build` bundles the extension into `dist/extension` and builds the host with
`cargo build --release`. `register` runs `browser-agent-host install` on that build. Then load
`dist/extension` as in steps 3 and 4 above. Run `register` again after each host build.

## What `install` changes

The browsers start a per-user copy of the host, so the downloaded or built binary can move, and a
rebuild never meets a binary a running browser holds.

- **Windows:** `%LOCALAPPDATA%\BrowserAgent\` (or `%TOOLING_DATA_ROOT%\browser-agent\` when that
  variable is set) receives `browser-agent-host.exe` and the host manifest, and
  `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ludekvodicka.browser_agent` points at the
  manifest. Chrome and Brave both read that key. No admin rights are needed. A binary that a running
  host still holds is renamed to `browser-agent-host.<time>.old.exe`; a later `install` removes it
  once that host has exited.
- **macOS:** `~/.browser-agent/browser-agent-host`, and a manifest named
  `com.ludekvodicka.browser_agent.json` in both
  `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` and
  `~/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/`.

The macOS host serves `~/.browser-agent/run/browser-agent-<instanceId>.sock`, with mode 0600 in a
directory with mode 0700; it closes and removes the socket on normal exit or SIGINT/SIGTERM. The
entire socket path must be shorter than 104 UTF-8 bytes. A longer home path is refused. An abrupt
kill leaves the socket file behind; the next host of that profile finds that the file refuses
connections, removes it and listens again.

A running profile keeps its old host until its native port reconnects. Reload the extension or
restart the browser to switch to a newly installed host. Each host process takes a few megabytes of
memory.

## Use

```sh
node cli/browserAgent.ts list
node cli/browserAgent.ts call work appdata.slack.cookies --out <file> --caller <name>
node cli/browserAgent.ts call work meetings.web.googleMeet --caller manual
```

`list` shows the profiles whose browser window runs. A tool marked `sensitive` writes its value only
into the `--out` file; the CLI never prints it. `--file <path>`, repeatable, passes local files to a
tool that accepts them (the Gmail draft and reply tools), at most 25 MB together. Exit codes: `0` success, `2` usage, `3` refusal with
`{ "ok": false, "code", "message" }` on stdout.

Enable the desired tools in the popup's **Meetings** tab and allow their site permissions:

| Tool | Matching meeting tabs |
|---|---|
| `meetings.web.googleMeet` | HTTPS `meet.google.com`, path starting with a meeting code such as `/abc-defg-hij` |
| `meetings.web.zoom` | HTTPS subdomains of `zoom.us`, path starting with `/wc/` |
| `meetings.web.teams` | HTTPS `teams.microsoft.com` or `teams.cloud.microsoft`, meeting/call routes in the path or fragment |

Each successful call returns `value: { meetings: [{ key, title, tabId, windowId, audible, lastAccessed }] }`.
The key is host plus path (also the fragment for Teams); query parameters are omitted. Key and title
are capped at 300 UTF-16 code units. No matching tabs means an empty array. These are URL candidates,
not proof that the user joined a call. Missing title, audible state or access time become `""`, `false`
and `0`; access time otherwise is milliseconds since the Unix epoch. Successful meeting calls do
not enter the popup request log; refusals still do. Each call makes one tab query, with no page
script, subscription or meeting timer.

Clients in other languages can use the same channel directly. Discover Windows pipes starting with
`browser-agent-` in `\\.\pipe\`, or macOS socket files in `~/.browser-agent/run/`; connect to each and
send `{"protocolVersion":4,"op":"describe"}` followed by LF. For a call send
`{"protocolVersion":4,"op":"call","tool":"meetings.web.googleMeet","caller":"meeting-recorder"}`
followed by LF. Each connection returns one UTF-8 JSON line; close the connection after reading it. Discover and address each
profile separately; do not assume labels are unique. The complete shapes, limits, errors and Python
client guidance are in [Agent channel: client wire format](docs/architecture/agent-channel.md#client-wire-format).

## Add a tool

1. Create `extension/src/tools/<section>/<group>/<tool>.ts` implementing `BrowserTool`
   (`extension/src/tools/browserTool.ts`): an id `<section>.<group>.<name>`, a title, the host
   patterns it reads, `sensitive` when its value is a credential, and `run`. Set `quiet: true` to omit
   successful calls from the request log while keeping refusals. A tool that needs a
   script in the page from `document_start` lists it in `pageScripts`, built from a `*Hook.ts` beside it.
2. Register it in `extension/src/tools/toolRegistry.ts`, adding its section and group when new.
3. Add its host patterns to `optional_host_permissions` in `extension/manifest.json`.
4. Add tests in `extension/tests/`, then `npm run build` and reload the extension in each profile.

The dispatcher, the popup and the CLI need no change: they read tools only through the registry data.

## Development

```sh
npm run typecheck
npm test
npm run build
cd host && cargo fmt --check && cargo clippy --all-targets && cargo test
```

`npm test` builds the host and drives the binary through stdin, stdout and a real pipe or socket.
`host/src/protocol.rs` repeats the rules of `shared/protocol.ts`; change both together.
