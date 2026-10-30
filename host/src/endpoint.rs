//! The profile's local endpoint: a Windows named pipe, or a Unix domain socket on macOS.

use crate::protocol::PIPE_PREFIX;
use std::io;
use std::path::Path;

#[cfg(windows)]
pub use windows::*;

#[cfg(unix)]
pub use unix::*;

#[cfg(windows)]
mod windows {
  use super::*;
  use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

  pub type Stream = NamedPipeServer;

  const ERROR_ACCESS_DENIED: i32 = 5;
  const ERROR_PIPE_BUSY: i32 = 231;

  pub fn endpoint(instance_id: &str, _home: Option<&Path>) -> io::Result<String> {
    Ok(format!(r"\\.\pipe\{PIPE_PREFIX}{instance_id}"))
  }

  pub fn prepare(_path: &str) -> io::Result<()> {
    Ok(())
  }

  pub fn in_use(error: &io::Error) -> bool {
    matches!(error.raw_os_error(), Some(ERROR_ACCESS_DENIED | ERROR_PIPE_BUSY))
  }

  pub async fn clear_stale(_path: &str) {}

  pub struct Listener {
    path: String,
    next: NamedPipeServer,
  }

  impl Listener {
    // The first instance fails when another host already serves this profile.
    pub fn bind(path: &str) -> io::Result<Self> {
      let next = ServerOptions::new()
        .first_pipe_instance(true)
        .reject_remote_clients(true)
        .create(path)?;
      Ok(Self {
        path: path.to_owned(),
        next,
      })
    }

    pub fn restrict(&self) -> io::Result<()> {
      Ok(())
    }

    pub async fn accept(&mut self) -> io::Result<Stream> {
      let connected = self.next.connect().await;
      let fresh = ServerOptions::new().reject_remote_clients(true).create(&self.path)?;
      let stream = std::mem::replace(&mut self.next, fresh);
      connected.map(|()| stream)
    }

    pub fn close(self) {}
  }
}

#[cfg(unix)]
mod unix {
  use super::*;
  use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
  use std::path::PathBuf;
  use tokio::net::{UnixListener, UnixStream};

  pub type Stream = UnixStream;

  // macOS truncates longer socket paths silently, so a host would listen somewhere else.
  const MAX_SOCKET_PATH_BYTES: usize = 104;

  pub fn endpoint(instance_id: &str, home: Option<&Path>) -> io::Result<String> {
    let home = home
      .filter(|home| home.is_absolute())
      .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "The socket directory requires an absolute home path."))?;
    let path = directory(home).join(format!("{PIPE_PREFIX}{instance_id}.sock"));
    let path = path
      .to_str()
      .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "The socket path is not UTF-8."))?;
    if path.len() >= MAX_SOCKET_PATH_BYTES {
      return Err(io::Error::new(
        io::ErrorKind::InvalidInput,
        "Browser Agent socket path must be shorter than 104 UTF-8 bytes.",
      ));
    }
    Ok(path.to_owned())
  }

  fn directory(home: &Path) -> PathBuf {
    home.join(".browser-agent").join("run")
  }

  pub fn prepare(path: &str) -> io::Result<()> {
    let directory = Path::new(path).parent().expect("socket path has a directory");
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(directory)?;
    std::fs::set_permissions(directory, std::fs::Permissions::from_mode(0o700))
  }

  pub fn in_use(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::AddrInUse
  }

  // A socket file outlives a host that was killed, and the instanceId never changes, so the profile
  // would stay unreachable. A file that refuses connections has no listener; a live host's file stays.
  pub async fn clear_stale(path: &str) {
    if let Err(error) = UnixStream::connect(path).await
      && error.kind() == io::ErrorKind::ConnectionRefused
    {
      // When removal fails, the next bind reports the path in use again and the retry limit applies.
      let _ = std::fs::remove_file(path);
    }
  }

  pub struct Listener {
    path: String,
    listener: UnixListener,
  }

  impl Listener {
    pub fn bind(path: &str) -> io::Result<Self> {
      Ok(Self {
        path: path.to_owned(),
        listener: UnixListener::bind(path)?,
      })
    }

    pub fn restrict(&self) -> io::Result<()> {
      std::fs::set_permissions(&self.path, std::fs::Permissions::from_mode(0o600))
    }

    pub async fn accept(&mut self) -> io::Result<Stream> {
      self.listener.accept().await.map(|(stream, _)| stream)
    }

    pub fn close(self) {
      drop(self.listener);
      let _ = std::fs::remove_file(&self.path);
    }
  }

  #[cfg(test)]
  mod tests {
    use super::*;

    #[test]
    fn places_the_socket_under_the_home_run_directory() {
      let id = "00000000-0000-4000-8000-000000000000";
      assert_eq!(
        endpoint(id, Some(Path::new("/Users/test"))).unwrap(),
        format!("/Users/test/.browser-agent/run/browser-agent-{id}.sock")
      );
      assert!(endpoint(id, Some(Path::new("relative"))).is_err());
      assert!(endpoint(id, None).is_err());
      assert!(endpoint(id, Some(Path::new(&format!("/Users/{}", "a".repeat(50))))).is_err());
    }

    #[tokio::test]
    async fn replaces_a_stale_socket_but_keeps_a_live_one() {
      let directory = std::env::temp_dir().join(format!("browser-agent-test-{}", std::process::id()));
      std::fs::create_dir_all(&directory).unwrap();
      let path = directory.join("stale.sock").to_str().unwrap().to_owned();
      drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
      assert!(in_use(&Listener::bind(&path).err().unwrap()));
      clear_stale(&path).await;
      let live = Listener::bind(&path).unwrap();
      clear_stale(&path).await;
      assert!(Path::new(&path).exists());
      live.close();
      assert!(!Path::new(&path).exists());
      std::fs::remove_dir_all(&directory).unwrap();
    }
  }
}
