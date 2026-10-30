//! Browser Agent native messaging host. The browser starts one per profile with the calling
//! extension's origin as the first argument; `install` and `uninstall` register this binary.

mod endpoint;
mod frame;
mod host;
mod install;
mod protocol;

use std::path::PathBuf;

fn main() {
  let first = std::env::args().nth(1).unwrap_or_default();
  let arguments: Vec<String> = std::env::args().skip(2).collect();
  let result = match (first.as_str(), arguments.as_slice()) {
    ("install", []) => Some(install::install(None)),
    ("install", [flag, folder]) if flag == "--extension" => Some(install::install(Some(std::path::Path::new(folder)))),
    ("install", _) => Some(Err(std::io::Error::new(
      std::io::ErrorKind::InvalidInput,
      "usage: install [--extension <folder>]",
    ))),
    ("uninstall", []) => Some(install::uninstall()),
    _ => None,
  };
  if let Some(result) = result {
    match result {
      Ok(result) => println!("{result}"),
      Err(error) => {
        println!("{}", serde_json::json!({ "ok": false, "message": error.to_string() }));
        std::process::exit(1);
      }
    }
    return;
  }
  if first != format!("chrome-extension://{}/", protocol::extension_id()) {
    std::process::exit(1);
  }
  let runtime = tokio::runtime::Builder::new_current_thread()
    .enable_all()
    .build()
    .expect("the async runtime starts");
  let home = std::env::var_os("HOME").map(PathBuf::from);
  let code = runtime.block_on(host::run(
    tokio::io::stdin(),
    tokio::io::stdout(),
    home,
    host::Timing::PRODUCTION,
    shutdown(),
  ));
  // Exiting directly: the runtime would otherwise wait for the blocking stdin read on shutdown.
  std::process::exit(code);
}

async fn shutdown() {
  #[cfg(unix)]
  {
    let mut terminate = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()).expect("SIGTERM handler installs");
    tokio::select! {
      _ = tokio::signal::ctrl_c() => {}
      _ = terminate.recv() => {}
    }
  }
  #[cfg(windows)]
  let _ = tokio::signal::ctrl_c().await;
}
