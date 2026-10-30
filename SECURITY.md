# Security

## Reporting

Report a vulnerability privately through GitHub's "Report a vulnerability" button on this
repository's Security tab. Do not open a public issue for it.

## Trust model

- **Same-user boundary.** The native host serves a Windows named pipe (remote clients refused) or a
  macOS Unix socket (mode 0600 in a 0700 directory). Any process of the same OS user can call it;
  there is no caller secret. Treat that user account as the trust boundary.
- **No network listener.** Nothing listens on TCP, so a web page cannot reach the host.
- **Per-profile consent.** Agent access and every tool are off by default in each browser profile.
  Enabling a tool asks the browser for that tool's site permission.
- **Credentials stay out of output.** A tool marked `sensitive` returns its value only into a file
  named by the caller; the CLI and the popup log never show it.
- **Unsigned binaries.** Release host binaries are not code-signed (macOS: ad-hoc signature only).
  Compare a download with `SHA256SUMS.txt` from the release, or build from source.
