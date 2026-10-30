# Third-party software

The extension bundle contains only this project's code. The npm packages in `package.json` are build
and test tools and are not shipped.

The native host binary (`browser-agent-host`) statically links these Rust crates. Each is used under
the license named here (for a dual license, the MIT option); their texts are in each crate's source on
crates.io.

| Crate | License |
|---|---|
| base64 | MIT OR Apache-2.0 |
| block-buffer | MIT OR Apache-2.0 |
| bytes | MIT |
| cfg-if | MIT OR Apache-2.0 |
| cpufeatures | MIT OR Apache-2.0 |
| crypto-common | MIT OR Apache-2.0 |
| digest | MIT OR Apache-2.0 |
| equivalent | Apache-2.0 OR MIT |
| errno (macOS) | MIT OR Apache-2.0 |
| foldhash | Zlib |
| generic-array | MIT |
| hashbrown | MIT OR Apache-2.0 |
| indexmap | Apache-2.0 OR MIT |
| itoa | MIT OR Apache-2.0 |
| libc (macOS) | MIT OR Apache-2.0 |
| memchr | Unlicense OR MIT |
| mio | MIT |
| pin-project-lite | Apache-2.0 OR MIT |
| serde_core | MIT OR Apache-2.0 |
| serde_json | MIT OR Apache-2.0 |
| sha2 | MIT OR Apache-2.0 |
| signal-hook-registry (macOS) | MIT OR Apache-2.0 |
| socket2 | MIT OR Apache-2.0 |
| tokio | MIT |
| typenum | MIT OR Apache-2.0 |
| windows-link (Windows) | MIT OR Apache-2.0 |
| windows-sys (Windows) | MIT OR Apache-2.0 |
| zmij | MIT |

`proc-macro2`, `quote`, `syn`, `tokio-macros` and `unicode-ident` run only at compile time.
`host/Cargo.lock` pins the exact versions.
