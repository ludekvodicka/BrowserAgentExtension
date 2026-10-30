# Contributing

Issues and pull requests are welcome.

- Build and test as described in README.md, "Development". CI runs the same checks on Windows and
  macOS.
- A new tool follows "Add a tool" in README.md. The dispatcher, popup and CLI must not name concrete
  tools; only `extension/src/tools/toolRegistry.ts` imports them.
- A wire protocol change updates `shared/protocol.ts` and `host/src/protocol.rs` together and raises
  `protocolVersion` when old peers would misread it.
- Never put a cookie, token or other credential into a test, fixture, log or the popup.
- Keep `extension/manifest.json`'s `key`: the native host registration and every profile's grants
  depend on the extension ID it produces.
