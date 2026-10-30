//! `browser-agent-host install` and `uninstall`: register this binary as the browsers' native host.
//! The browsers start a per-user copy, so the downloaded or built binary can move or be rebuilt.

use crate::protocol::{HOST_NAME, extension_id};
use serde_json::{Value, json};
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

// Other applications (Meeting Recorder) read the extension folder from this file beside the host.
pub const INSTALL_RECORD: &str = "browser-agent.json";
pub const REGISTRY_KEY: &str = r"HKCU\Software\Google\Chrome\NativeMessagingHosts\com.ludekvodicka.browser_agent";

#[derive(Debug, PartialEq)]
pub struct Plan {
  pub directory: PathBuf,
  pub installed: PathBuf,
  pub manifests: Vec<PathBuf>,
  pub registry_key: Option<&'static str>,
  // Earlier versions started the host through a script here.
  pub legacy_launcher: PathBuf,
}

fn invalid(message: &str) -> io::Error {
  io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// Windows: `TOOLING_DATA_ROOT/browser-agent` when that variable is set, else `%LOCALAPPDATA%\BrowserAgent`.
/// Chrome and Brave both read the Google Chrome registry key.
pub fn windows_plan(tooling_data_root: Option<&str>, local_app_data: Option<&str>) -> io::Result<Plan> {
  let directory = match (
    tooling_data_root.filter(|root| !root.is_empty()),
    local_app_data.filter(|root| !root.is_empty()),
  ) {
    (Some(root), _) => PathBuf::from(root).join("browser-agent"),
    (None, Some(local)) => PathBuf::from(local).join("BrowserAgent"),
    (None, None) => return Err(invalid("LOCALAPPDATA is not set.")),
  };
  if !directory.is_absolute() {
    return Err(invalid("The install directory must be an absolute path."));
  }
  Ok(Plan {
    installed: directory.join("browser-agent-host.exe"),
    manifests: vec![directory.join(format!("{HOST_NAME}.json"))],
    registry_key: Some(REGISTRY_KEY),
    legacy_launcher: directory.join("browser-agent-host.bat"),
    directory,
  })
}

/// macOS: the binary in `~/.browser-agent`, one manifest for Chrome and one for Brave.
pub fn macos_plan(home: Option<&str>) -> io::Result<Plan> {
  let home = PathBuf::from(home.unwrap_or_default());
  if !home.is_absolute() {
    return Err(invalid("HOME must be an absolute path."));
  }
  let directory = home.join(".browser-agent");
  let support = home.join("Library").join("Application Support");
  Ok(Plan {
    installed: directory.join("browser-agent-host"),
    manifests: ["Google/Chrome", "BraveSoftware/Brave-Browser"]
      .iter()
      .map(|browser| support.join(browser).join("NativeMessagingHosts").join(format!("{HOST_NAME}.json")))
      .collect(),
    registry_key: None,
    legacy_launcher: directory.join("browser-agent-host.sh"),
    directory,
  })
}

fn current_plan() -> io::Result<Plan> {
  let variable = |name: &str| std::env::var(name).ok();
  if cfg!(windows) {
    windows_plan(variable("TOOLING_DATA_ROOT").as_deref(), variable("LOCALAPPDATA").as_deref())
  } else if cfg!(target_os = "macos") {
    macos_plan(variable("HOME").as_deref())
  } else {
    Err(invalid("Browser Agent supports Windows and macOS."))
  }
}

pub fn manifest(installed: &Path, extension_id: &str) -> Value {
  json!({
    "name": HOST_NAME,
    "description": "Browser Agent native messaging relay",
    "path": installed,
    "type": "stdio",
    "allowed_origins": [format!("chrome-extension://{extension_id}/")],
  })
}

fn same_file(a: &Path, b: &Path) -> bool {
  matches!((a.canonicalize(), b.canonicalize()), (Ok(a), Ok(b)) if a == b)
}

// Windows cannot overwrite an executable a running host holds, but it can rename it. Earlier copies
// are removed once their hosts have exited.
fn set_aside(installed: &Path) -> io::Result<()> {
  let directory = installed.parent().expect("the binary has a directory");
  for entry in std::fs::read_dir(directory)?.flatten() {
    let name = entry.file_name().to_string_lossy().into_owned();
    if name.starts_with("browser-agent-host.") && name.ends_with(".old.exe") {
      let _ = std::fs::remove_file(entry.path());
    }
  }
  if installed.exists() {
    let stamp = std::time::SystemTime::now()
      .duration_since(std::time::UNIX_EPOCH)
      .unwrap_or_default()
      .as_millis();
    std::fs::rename(installed, directory.join(format!("browser-agent-host.{stamp}.old.exe")))?;
  }
  Ok(())
}

fn copy_binary(source: &Path, installed: &Path) -> io::Result<()> {
  if same_file(source, installed) {
    return Ok(());
  }
  if cfg!(windows) {
    set_aside(installed)?;
    std::fs::copy(source, installed)?;
    return Ok(());
  }
  let staged = installed.with_extension("new");
  std::fs::copy(source, &staged)?;
  #[cfg(unix)]
  {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&staged, std::fs::Permissions::from_mode(0o700))?;
  }
  // A download carries the quarantine attribute, and macOS would refuse to let the browser start it.
  let _ = Command::new("xattr").arg("-d").arg("com.apple.quarantine").arg(&staged).output();
  std::fs::rename(&staged, installed)
}

fn reg(arguments: &[&str]) -> io::Result<bool> {
  Ok(Command::new("reg.exe").args(arguments).output()?.status.success())
}

fn copy_tree(from: &Path, to: &Path) -> io::Result<()> {
  std::fs::create_dir_all(to)?;
  for entry in std::fs::read_dir(from)? {
    let entry = entry?;
    if entry.file_type()?.is_dir() {
      copy_tree(&entry.path(), &to.join(entry.file_name()))?;
    } else {
      std::fs::copy(entry.path(), to.join(entry.file_name()))?;
    }
  }
  Ok(())
}

/// The folder the user loads as the unpacked extension: the one named on the command line, or a
/// copy of the release package's `extension` folder beside this binary, so the download can be deleted.
pub fn install_extension(directory: &Path, named: Option<&Path>, executable: &Path) -> io::Result<Option<PathBuf>> {
  if let Some(folder) = named {
    if !folder.join("manifest.json").is_file() {
      return Err(invalid("--extension must name a folder that holds manifest.json."));
    }
    return Ok(Some(std::path::absolute(folder)?));
  }
  let packaged = executable.parent().expect("the binary has a directory").join("extension");
  if !packaged.join("manifest.json").is_file() {
    return Ok(None);
  }
  let installed = directory.join("extension");
  if !same_file(&packaged, &installed) {
    if installed.exists() {
      std::fs::remove_dir_all(&installed)?;
    }
    copy_tree(&packaged, &installed)?;
  }
  Ok(Some(installed))
}

pub fn write_record(directory: &Path, extension: Option<&Path>) -> io::Result<()> {
  let record = directory.join(INSTALL_RECORD);
  match extension {
    Some(folder) => std::fs::write(record, serde_json::to_string_pretty(&json!({ "extension": folder }))? + "\n"),
    None => match std::fs::remove_file(record) {
      Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
      _ => Ok(()),
    },
  }
}

pub fn install(extension: Option<&Path>) -> io::Result<Value> {
  let plan = current_plan()?;
  let extension_id = extension_id();
  std::fs::create_dir_all(&plan.directory)?;
  let executable = std::env::current_exe()?;
  let extension = install_extension(&plan.directory, extension, &executable)?;
  write_record(&plan.directory, extension.as_deref())?;
  copy_binary(&executable, &plan.installed)?;
  let _ = std::fs::remove_file(&plan.legacy_launcher);
  let text = serde_json::to_string_pretty(&manifest(&plan.installed, &extension_id))? + "\n";
  for path in &plan.manifests {
    std::fs::create_dir_all(path.parent().expect("a manifest has a directory"))?;
    std::fs::write(path, &text)?;
  }
  if let Some(key) = plan.registry_key {
    let manifest = plan.manifests[0].to_string_lossy();
    if !reg(&["add", key, "/ve", "/t", "REG_SZ", "/d", &manifest, "/f"])? {
      return Err(io::Error::other("reg.exe could not write the native host registration."));
    }
  }
  Ok(
    json!({ "ok": true, "extensionId": extension_id, "host": plan.installed, "hostManifests": plan.manifests,
    "registryKey": plan.registry_key, "extension": extension }),
  )
}

pub fn uninstall() -> io::Result<Value> {
  let plan = current_plan()?;
  if let Some(key) = plan.registry_key {
    // A key that is already gone is the wanted state.
    reg(&["delete", key, "/f"])?;
  }
  for path in &plan.manifests {
    if path.exists() {
      std::fs::remove_file(path)?;
    }
  }
  let _ = std::fs::remove_file(&plan.legacy_launcher);
  write_record(&plan.directory, None)?;
  let copied = plan.directory.join("extension");
  if copied.exists() {
    std::fs::remove_dir_all(&copied)?;
  }
  // A host the browser still runs keeps its Windows binary; it is set aside instead.
  if plan.installed.exists() && std::fs::remove_file(&plan.installed).is_err() {
    set_aside(&plan.installed)?;
  }
  Ok(json!({ "ok": true, "removed": plan.manifests, "host": plan.installed }))
}

#[cfg(test)]
mod tests {
  use super::*;

  #[cfg(windows)]
  #[test]
  fn plans_windows_under_the_data_root_or_local_app_data() {
    let plan = windows_plan(Some(r"D:\Data"), Some(r"C:\Users\u\AppData\Local")).unwrap();
    assert_eq!(plan.installed, PathBuf::from(r"D:\Data\browser-agent\browser-agent-host.exe"));
    assert_eq!(
      plan.manifests,
      vec![PathBuf::from(r"D:\Data\browser-agent\com.ludekvodicka.browser_agent.json")]
    );
    assert_eq!(plan.registry_key, Some(REGISTRY_KEY));
    let plan = windows_plan(None, Some(r"C:\Users\u\AppData\Local")).unwrap();
    assert_eq!(
      plan.installed,
      PathBuf::from(r"C:\Users\u\AppData\Local\BrowserAgent\browser-agent-host.exe")
    );
    assert!(windows_plan(Some(""), None).is_err());
  }

  #[cfg(unix)]
  #[test]
  fn plans_macos_manifests_for_chrome_and_brave() {
    let plan = macos_plan(Some("/Users/test")).unwrap();
    assert_eq!(plan.installed, PathBuf::from("/Users/test/.browser-agent/browser-agent-host"));
    assert_eq!(
      plan.manifests,
      vec![
        PathBuf::from("/Users/test/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.ludekvodicka.browser_agent.json"),
        PathBuf::from(
          "/Users/test/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.ludekvodicka.browser_agent.json"
        ),
      ]
    );
    assert_eq!(plan.registry_key, None);
    assert!(macos_plan(Some("relative")).is_err());
    assert!(macos_plan(None).is_err());
  }

  fn temporary(name: &str) -> PathBuf {
    let directory = std::env::temp_dir().join(format!("browser-agent-install-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir_all(&directory).unwrap();
    directory
  }

  #[test]
  fn copies_the_packaged_extension_and_records_it() {
    let root = temporary("packaged");
    let download = root.join("download");
    std::fs::create_dir_all(download.join("extension/hooks")).unwrap();
    std::fs::write(download.join("extension/manifest.json"), "{}").unwrap();
    std::fs::write(download.join("extension/hooks/a.js"), "x").unwrap();
    let directory = root.join("install");
    std::fs::create_dir_all(&directory).unwrap();
    let folder = install_extension(&directory, None, &download.join("browser-agent-host"))
      .unwrap()
      .unwrap();
    assert_eq!(folder, directory.join("extension"));
    assert!(folder.join("hooks/a.js").is_file());
    write_record(&directory, Some(&folder)).unwrap();
    let record: Value = serde_json::from_str(&std::fs::read_to_string(directory.join(INSTALL_RECORD)).unwrap()).unwrap();
    assert_eq!(record["extension"], json!(folder));
    // Run again from the installed copy: the folder stays where it is.
    assert_eq!(
      install_extension(&directory, None, &directory.join("browser-agent-host")).unwrap(),
      Some(folder)
    );
    write_record(&directory, None).unwrap();
    write_record(&directory, None).unwrap();
    assert!(!directory.join(INSTALL_RECORD).exists());
    std::fs::remove_dir_all(&root).unwrap();
  }

  #[test]
  fn records_a_named_folder_without_copying_and_none_without_a_package() {
    let root = temporary("named");
    std::fs::create_dir_all(root.join("dist")).unwrap();
    assert!(install_extension(&root, Some(&root.join("dist")), &root.join("bin/host")).is_err());
    std::fs::write(root.join("dist/manifest.json"), "{}").unwrap();
    assert_eq!(
      install_extension(&root, Some(&root.join("dist")), &root.join("bin/host")).unwrap(),
      Some(root.join("dist"))
    );
    assert!(!root.join("extension").exists());
    assert_eq!(install_extension(&root, None, &root.join("bin/host")).unwrap(), None);
    std::fs::remove_dir_all(&root).unwrap();
  }

  #[test]
  fn registers_under_the_host_name() {
    assert!(REGISTRY_KEY.ends_with(&format!(r"\{HOST_NAME}")));
  }

  #[test]
  fn allows_exactly_the_extension_origin() {
    let manifest = manifest(Path::new("/x/browser-agent-host"), "abc");
    assert_eq!(manifest["allowed_origins"], json!(["chrome-extension://abc/"]));
    assert_eq!(manifest["type"], "stdio");
    assert_eq!(manifest["path"], "/x/browser-agent-host");
  }
}
