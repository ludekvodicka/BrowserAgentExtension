# Agent channel

## Decision

A coding agent reaches the extension of a named Brave or Chrome profile through native messaging and a
local OS channel. The extension opens a native messaging port; the browser starts one host process per
profile. On Windows the host serves `\\.\pipe\browser-agent-<instanceId>` and the CLI enumerates
`\\.\pipe\`. On macOS the host serves `~/.browser-agent/run/browser-agent-<instanceId>.sock` and the CLI
enumerates that directory. Each endpoint answers `describe` or one tool call, one JSON line per connection.

Reasons:

- **The browser starts the host,** so nothing has to run before the agent asks, and a closed profile
  simply has no pipe.
- **No central process:** endpoint enumeration finds every connected profile, so no broker is needed.
- **A web page cannot reach these OS endpoints,** unlike a localhost HTTP port.
- **A CLI with a skill** works from Claude Code and Codex alike and needs no per-client server
  configuration. An MCP server could wrap the same pipe messages later.

## Behavior

- **Identity:** the fixed manifest `key` gives one extension ID everywhere. Each profile creates a
  random `instanceId` on first run; the user sets its label. The CLI matches a label without regard to
  case, else an `instanceId` prefix of at least 8 characters, and refuses two matches.
- **Permission gate:** the extension checks, in this order, agent access, a known tool, the tool
  enabled, and the browser's host permission for the tool's sites. The first failure is an immediate
  refusal with its own code (`access_off`, `tool_unknown`, `tool_denied`, `permission_missing`).
  Enabling a tool requests its `optional_host_permissions`, so the browser enforces the allowlist too.
  Turning agent access off keeps the enabled tools stored and refuses later requests.
- **Credentials:** a tool marked `sensitive` returns its value only into a file named by `--out`. The
  request log (last 20 entries, shown in the popup) holds time, tool, caller and outcome, never values.
  A tool's optional `quiet: true` suppresses successful log entries only. Gate refusals, execution
  failures and oversized results remain logged. The dispatcher knows only that property, never tool
  identities. A refused request sets the `!` badge until the popup opens.
- **Versions:** the hello and every request carry `protocolVersion: 4`; older peers and any other
  mismatch are refused before a tool runs. The CLI accepts tool arguments as a JSON object in `--args`.
- **Files:** `--file <path>` (up to 20, at most 25 MB together, Gmail's attachment limit) puts each
  file's name and base64 content into the pipe request, which may then reach 36 MiB. The browser
  takes at most 1 MiB per message from the host, so the host sends each file as ordered `fileChunk`
  messages of 800,000 base64 characters before the call itself, and the extension joins them into
  the call's `files`. The host refuses arguments over 1 MiB or files over 25 MB, and gives a call
  with files 30 seconds instead of 15. Only a tool marked `acceptsFiles` receives files; the
  dispatcher refuses them for any other tool, so a file cannot reach a tool that was not built for it.
- **Response size:** the dispatcher refuses every response over 900,000 JSON characters or the
  transport's 1 MiB UTF-8 byte cap with `result_too_large`, before logging its outcome and sending it.
  The small refusal omits the value and profile metadata, which can itself exceed the cap. Callers
  should reduce their page limit; the native host stays connected.
- **Lifetime:** the open native port keeps the service worker alive; a `reconnect` alarm reopens a lost
  port within a minute. When the port closes, the host fails pending requests with
  `extension_disconnected`, exits, and its endpoint disappears. On macOS the run directory is mode
  0700 and the socket is mode 0600 before readiness is announced. The host rejects paths of 104 or
  more UTF-8 bytes instead of letting the OS truncate them. The host removes its socket when it stops;
  SIGINT and SIGTERM use that same shutdown. A crash or SIGKILL
  leaves the file, and because the instanceId is stable the next host of that profile would get
  `EADDRINUSE` forever. On `EADDRINUSE` the macOS host therefore connects to the path first: a file
  that refuses the connection (`ECONNREFUSED`) has no listener and is unlinked; a path where a live
  host answers is never unlinked. Both cases retry after 500 ms, up to five times, then `pipe_busy`.
  Until the profile reopens, discovery reports a stale file as disconnected.
- **Meeting tabs:** the `meetings` section and `web` group both have the title `Meetings`, so the
  registry produces one popup tab with three independently enabled tools. Each queries only its
  granted hosts with `chrome.tabs.query({ url: hosts })`, then applies the pure URL rules below.
  They are non-sensitive, quiet tools with no page script or file input. No meeting watch, alarm,
  content script or timer is installed; clients choose when to ask. The existing native-port
  reconnect alarm is unchanged. Host permissions provide the tab URL and title, without a required
  `tabs` permission ([Chrome Tabs API](https://developer.chrome.com/docs/extensions/reference/api/tabs)).
- **Slack API:** `appdata.slack.api` validates a workspace ID, one of five read methods and flat
  parameters before selecting the first non-discarded `app.slack.com` tab. An isolated script reads
  that workspace's token from local storage and makes one same-origin form request, refusing redirects.
  The token stays in the tab; errors and any body echoing it become a fixed refusal. Slack's JSON
  body and optional numeric `retryAfter` are the value, including Slack-level errors. Paging and
  retries belong to the caller. Missing tabs refuse with `tab_missing`; the tool never changes
  tab state or starts a browser. The API tool and cookie tool have separate switches and share one
  optional Slack host permission.
- **Page scripts:** a tool may declare scripts it needs in its site's main world from
  `document_start` (`pageScripts`). `PageScripts` registers them while the tool is enabled and its host
  permission granted, and unregisters them otherwise; it re-syncs on startup, permission changes and
  tool switches. The build bundles each `*Hook.ts` under `tools/` into `hooks/<name>.js`.
- **Outlook mail:** `appdata.outlook.mail` reads Outlook on the web at `outlook.cloud.microsoft`.
  Outlook keeps its tokens in an encrypted MSAL cache and exposes no token client, so its page script
  (`outlookHook.ts`) remembers the latest `Authorization` the page itself sends whose audience is
  `https://outlook.office.com`. The tool builds one of three read paths of the Outlook REST API v2.0
  (`folders.list`, `messages.list`, `messages.get`), then a main-world function makes one same-origin
  GET with that authorization and plain-text bodies. The value is `{ status, body }`; the token never
  leaves the tab. A tab opened before the hook gets it injected and refuses with `tab_not_ready` until
  Outlook sends its next request; a `401` refuses the same way. The token Outlook holds can also send
  and delete mail, so the read-only limit lives in the path builder and the page function's path check.
- **Gmail conversation:** `appdata.gmail.thread` reads the conversation open in a `mail.google.com`
  tab. A main-world function reads the signed-in address and the request key `ik` from Gmail's
  `GLOBALS` (indexes 10 and 9), the user index from `/mail/u/<n>/` and the thread ID from the visible
  `h2[data-thread-perm-id]`; Gmail keeps earlier conversations hidden in the page. Without an `account`
  argument the tool takes the tab with an open conversation that the user viewed last
  (`tab.lastAccessed`). An isolated script then fetches the thread's print view
  (`view=pt&permthid=thread-f:<n>`), which lists every message expanded, and turns it into sender,
  date, recipient lines, plain-text body and attachment names. It parses in the isolated world
  because Gmail's Trusted Types policy blocks `DOMParser` in the main world. Dates and recipient
  labels stay in Gmail's display language. Each attachment carries an `id` `<message>:<attid>` taken
  from its print-view link.
- **Gmail attachments:** `appdata.gmail.attachments` selects the same tab, reads the same print view,
  and passes each attachment's `view=att&disp=safe` URL to `chrome.downloads`, into
  `browser-agent/gmail/<thread number>/` of the download folder. The browser's own download carries
  the Gmail session and follows Gmail's redirect to its attachment host, so no file content passes
  the 1 MiB native-messaging cap and no cookie leaves the browser. Only attachment ids the open
  conversation lists are accepted; the parser lists an id once, because Gmail's print view can show one
  attachment in two rows. The tool starts all downloads at once (one by one, 31 files took about
  20 seconds), waits until 12 seconds after the call arrived, within the host's 15-second request
  limit, and reports a download still running as `in_progress`. Saving files is a separate
  switch from reading, and it needs the `downloads` permission.
- **Gmail draft:** `appdata.gmail.draft` opens Gmail's own compose page (`/mail/u/<n>/?view=cm&fs=1`)
  with `to`, `cc`, `bcc`, `su` and `body` in the URL, as a new active tab beside the account's Gmail
  tab that the user viewed last; Gmail saves it as a draft. It is the only app data tool that opens a tab. The
  user reviews and sends. Gmail's internal compose API is undocumented, and recipient fields filled
  by DOM depend on the display language, so the URL carries the fields. Its cost is length: the tool
  refuses a URL over 8,000 characters, and the body is plain text. Recipients are bare addresses
  without display names, because the fields are joined by commas. Files given with `--file` are
  attached after the tab loads, as for a reply below.
- **Gmail reply:** `appdata.gmail.reply` works in the tab of the open conversation (as
  `appdata.gmail.thread` selects it). An isolated script presses Gmail's reply or reply-all link
  below the conversation (`span.ams.bkH` / `span.ams.bkI`, class names that do not change with the
  display language), waits for the new message body, and types the text with
  `execCommand("insertText")` and `insertLineBreak`. For files it presses the compose window's attach
  button (`div[command="Files"]`), which makes Gmail create its file input, sets the files on that
  input through a `DataTransfer` and fires `change`; the file chooser itself cannot open without a
  user gesture and is not needed. It reports each file as `shown` when its name appears in the
  compose window within 6 seconds. Gmail uploads the files and saves the draft itself.
  Decision: the user chose page scripting over the Gmail API (OAuth client and token outside the
  browser), because the extension already finds the open conversation and its session in the tab.
  The cost is fragility: a Gmail UI change can move these selectors, and the tool then refuses with
  the step that failed. The script dispatches no key event and never touches the send button.
  Recipients of a reply are Gmail's own (sender, or all with `replyAll`). With `from`, the script
  first presses the count bubble that hides the middle messages of a longer conversation
  (`div.adv [role="button"]`) when the sender is not shown, then
  takes the last message list item (`[role="listitem"]`) whose first `[email]` element is that sender,
  presses its header row (`div.kv`, `div.kQ`) to expand it when collapsed, and presses its own reply
  button: the `<button>` whose `aria-label` equals the localized text of the reply link below (read
  even when an open reply hides that link), else `button.DILLkc`. Before typing it checks the new reply's recipient chips
  (`div.afV`, address in `data-hovercard-id`, hidden while the recipient line is collapsed) in the
  nearest ancestor of its body that holds any, and refuses unless the sender is among them, so a wrong
  recipient never gets text.
- **Open a tab:** `browser.tabs.open` (section Browser) opens an `http` or `https` URL in a new active
  tab, in the profile's last focused window or in a `windowId` the caller got from an earlier call;
  any other scheme (`javascript:`, `file:`, `chrome:`) refuses, so the tool cannot run code in a
  page or open browser settings. It needs no site permission and does not read the page it opens.
  The page loads with the profile's session, which is the purpose and the risk: the switch is off by
  default, and the skill tells agents to open only what the user asked for.

## Entry points

| Entry | File |
|---|---|
| Wire protocol | `shared/protocol.ts` |
| Platform endpoint paths | `shared/transport.ts` |
| Meeting tools and pure URL rules | `extension/src/tools/meetings/web/meetingTools.ts`, `extension/src/tools/meetings/web/meetingRules.ts` |
| Native host (Rust) | `host/src/host.rs`; endpoints in `host/src/endpoint.rs`, framing in `host/src/frame.rs`, wire rules in `host/src/protocol.rs` |
| Gate and tool dispatch | `extension/src/dispatcher.ts` |
| Tool registry (the only place that imports concrete tools) | `extension/src/tools/toolRegistry.ts` |
| Slack API validation and isolated request | `extension/src/tools/appdata/slack/slackApi.ts`, `extension/src/tools/appdata/slack/slackApiPage.ts` |
| Page script registration | `extension/src/pageScripts.ts` |
| Outlook mail paths, hook and page request | `extension/src/tools/appdata/outlook/outlookMail.ts`, `outlookHook.ts`, `outlookMailPage.ts` |
| Gmail tab selection, tab reading and print-view parsing | `extension/src/tools/appdata/gmail/gmailTabs.ts`, `gmailThread.ts`, `gmailTabPage.ts`, `gmailThreadPage.ts` |
| Gmail attachment downloads | `extension/src/tools/appdata/gmail/gmailAttachments.ts` |
| Gmail draft (compose link) | `extension/src/tools/appdata/gmail/gmailDraft.ts` |
| Gmail reply, compose filling and attaching | `extension/src/tools/appdata/gmail/gmailReply.ts`, `gmailComposePage.ts`, `fillCompose` in `gmailTabs.ts` |
| File chunks (host send, extension join) | `host/src/host.rs`, `extension/src/connection.ts` |
| Open a tab | `extension/src/tools/browser/tabs/tabsOpen.ts` |
| Icon (rendered to PNG by the build) | `extension/icon.svg`, `scripts/build.mjs` |
| CLI and registration | `cli/browserAgent.ts`, `cli/registration.ts` |
| Profile discovery and JSON line client | `cli/pipeClient.ts` |

## Meeting tools

Only HTTPS URLs match. The host restrictions are checked again by the pure rule module.

| Tool | Optional host permissions | URL rule |
|---|---|---|
| `meetings.web.googleMeet` | `https://meet.google.com/*` | Path matches `^/[a-z]{3}-[a-z]{4}-[a-z]{3}(/\|$)`, case-insensitive |
| `meetings.web.zoom` | `https://*.zoom.us/*` | Hostname ends with `.zoom.us`; path starts with `/wc/`, case-sensitive. Bare `zoom.us` and `/j/` are excluded. |
| `meetings.web.teams` | `https://teams.microsoft.com/*`, `https://teams.cloud.microsoft/*` | Path plus hash matches `/(meetup-join\|meet\|call)\b`, case-insensitive |

The tools take no arguments and return this value, with one entry per matching tab:

```json
{"meetings":[{"key":"meet.google.com/abc-defg-hij","title":"Team meeting","tabId":42,"windowId":1,"audible":true,"lastAccessed":1793310000000}]}
```

The key is URL host plus pathname, followed by the hash for Teams only. Search/query parameters
are excluded. Both key and title are sliced to 300 UTF-16 code units. The title is browser tab text,
not trusted instructions. A tab without a URL or ID is skipped. Missing title, audible state or
access time become an empty string, false or zero; otherwise access time is epoch milliseconds.
An empty array is a successful answer. Tabs are not deduplicated and ordering is not guaranteed.
These URL rules detect meeting candidates, including pre-join and ended meeting pages; neither
audible nor lastAccessed proves participation. A key can collide after truncation. A client tracking
tabs across profiles should also retain profile.instanceId and tabId.

## Client wire format

The CLI is optional. A Python or other local client can speak directly to the native host. The
protocol version remains **4**: adding tools and changing the OS endpoint changes no message shape.

### Discovery and selection

| Platform | Discovery | Connection |
|---|---|---|
| Windows | Enumerate `\\.\pipe\`, keep names starting with `browser-agent-` | Open `\\.\pipe\<name>` as a duplex byte stream. Python can use a Win32 named-pipe library or an unbuffered binary file handle. |
| macOS | Enumerate `~/.browser-agent/run/`, keep `browser-agent-<UUID>.sock` | Python `socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)` with the full path |

The UUID is the full profile instanceId. A missing macOS directory means no running profiles.
Connect to every candidate independently and ask it to describe itself; vanished, stale or slow
endpoints must not prevent other profiles from being discovered. The CLI uses a 3-second discovery
timeout and keeps refusals separate from connected profiles. Profiles with Agent access off are
still described. The describe answer, not its filename, supplies the label and enabled tools.
The CLI resolves a case-insensitive label, then an instanceId prefix of at least 8 characters;
multiple matches refuse with profile_ambiguous. A polling client should identify profiles by the
full instanceId and re-discover when endpoints close or new profiles open.

### Requests and responses

Open a new connection per request. Write exactly one UTF-8 JSON object followed by LF (byte 10).
Read until LF, accumulating partial reads, parse the JSON, then close. The host returns one line
and closes after the client does, or after two seconds; there is no subscription. Native messaging's binary length prefix belongs only to
the browser-host stdio channel and must not be sent to the pipe/socket. No authentication header,
request ID or newline inside the JSON is required; JSON string newlines must be escaped.

```json
{"protocolVersion":4,"op":"describe"}
{"protocolVersion":4,"op":"call","tool":"meetings.web.googleMeet","caller":"meeting-recorder"}
```

These are examples of two separate connections. A call has required nonempty tool and caller
strings, each at most 128 characters. Optional args carries tool-specific JSON; meeting tools
need none. Optional files is an array of at most 20 objects with name (1 to 255 characters) and
data (base64); only tools supporting files accept them. Other tool parameters are documented
in the project-owned skill.

Every successful response has ok true and profile; a call adds value. Every refusal has ok false,
code and message, and may carry profile. An oversized refusal can omit profile. Profile has this shape:

```json
{
  "instanceId": "00000000-0000-4000-8000-000000000000",
  "label": "work",
  "agentAccess": true,
  "extensionVersion": "0.1.0",
  "protocolVersion": 4,
  "tools": [{
    "id": "meetings.web.googleMeet", "section": "meetings", "group": "web",
    "title": "Google Meet: list meeting tabs", "hosts": ["https://meet.google.com/*"],
    "sensitive": false, "enabled": true
  }]
}
```

Label can be null. Tools includes all installed tools and their enabled flags; enabled does not
replace the master switch or the browser's permission check. Quiet is an internal tool property,
not part of profile metadata. Check protocolVersion before accepting a profile or calling its
tools. Handle a mismatch independently for each profile, since profiles may have different builds.

```json
{"ok":false,"code":"tool_denied","message":"work: Enable Google Meet: list meeting tabs in this profile's Browser Agent popup."}
```

Requests are capped at 36 MiB; argument envelopes must fit below 1 MiB and decoded files at
25 MiB. Responses are capped at 900,000 JSON characters and 1 MiB UTF-8, excluding the trailing
LF; allow that extra byte while framing. Host calls time out after 15 seconds, or 30 seconds
with files. Use a client deadline slightly longer than the host's call deadline if the explicit
timeout response matters. An idle incomplete request is disconnected after 15 seconds. A slow
or disconnected profile is not an empty meeting list; retain that distinction in a polling client.

### Refusals

| Code | Meaning |
|---|---|
| `access_off` | Profile master switch is off |
| `tool_unknown` | Tool is not installed |
| `tool_denied` | Tool's switch is off |
| `permission_missing` | Required optional host permission is missing |
| `not_signed_in` | Tool needs a signed-in site session |
| `tab_missing`, `tab_not_ready` | Required page is missing or not ready; meeting tools instead succeed with an empty array when no meeting URL matches |
| `tool_args_invalid` | Invalid arguments/files or request limits exceeded |
| `result_too_large` | Result exceeds the response limits |
| `protocol_mismatch` | Host, extension or client protocol version differs |
| `extension_disconnected` | Host/extension disconnected; the CLI also uses it for socket connection errors |
| `extension_timeout` | No answer within the deadline |
| `extension_error` | Invalid request/response, tool exception or another transport failure |
| `profile_not_found`, `profile_ambiguous`, `no_profiles` | CLI discovery/selection refusals, not tool results |
| `output_required` | CLI requires a file for sensitive output |

The CLI additionally emits usage with exit code 2 for invalid command syntax; other refusals exit 3.
Native hello refusals protocol_mismatch and pipe_busy belong to the browser-host handshake, not
the client response envelope. A client must not enable tools or grant host access on the user's behalf.

## Constraints and trade-offs

- **No caller secret on the local channel.** Processes of the same user are the caller trust boundary.
  macOS adds filesystem permissions to the socket and directory. Revisit authentication if the host ever listens on TCP or a
  second Windows user shares the PC.
- **Windows registration only under the Google Chrome key.** Chrome and Brave both read
  `HKCU\Software\Google\Chrome\NativeMessagingHosts`, so one registration serves both. macOS instead
  writes the host manifest to each browser's NativeMessagingHosts directory. Both manifests name a
  copy of the host binary in the per-user data directory, so the browser needs no launcher script and
  no Node, and a rebuild never meets a binary a running browser holds. No elevated install or
  registry command is used on macOS.
- **The host is a Rust binary, the CLI stays TypeScript.** A host process runs for every open
  profile; Node took 58 to 82 MB per process, the binary about 5 MB. The cost is a second copy of the
  wire rules in `host/src/protocol.rs`; the vitest suite drives the built binary through stdin, stdout
  and real pipes, so both copies are tested against the same behavior.
- **An answered client closes the connection.** The host writes the answer line and then waits up to
  two seconds for the client to close: closing a Windows named pipe at once can discard an answer the
  client has not read.
- **No per-request approval prompt** and no audit file beyond the popup log. A tool whose single use
  needs consent, or a need to reconstruct older requests, would change this.
- **Only running profiles are listed.** Listing profiles whose browser is closed would need a broker.
