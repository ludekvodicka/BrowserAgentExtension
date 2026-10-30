//! The relay: one browser profile on stdin/stdout, many local clients on its endpoint. Each client
//! sends one JSON line and gets one JSON line back.

use crate::endpoint::{self, Listener, Stream};
use crate::frame;
use crate::protocol::{self, FILE_CHUNK_CHARS, MAX_FILE_BYTES, MAX_MESSAGE_BYTES, MAX_REQUEST_BYTES, PROTOCOL_VERSION};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinSet;
use tokio::time::{sleep, timeout};

#[derive(Clone, Copy)]
pub struct Timing {
  pub request: Duration,
  pub request_with_files: Duration,
  pub idle: Duration,
  pub bind_retry: Duration,
}

impl Timing {
  pub const PRODUCTION: Timing = Timing {
    request: Duration::from_secs(15),
    request_with_files: Duration::from_secs(30),
    idle: Duration::from_secs(15),
    bind_retry: Duration::from_millis(500),
  };
}

const BIND_RETRIES: u32 = 5;
// How long a client may take to read its answer, and the stopping host to finish its answers.
const DRAIN: Duration = Duration::from_secs(2);

enum Output {
  Frame(Vec<u8>),
  Flush(oneshot::Sender<()>),
}

struct Pending {
  stopped: bool,
  next_id: u64,
  waiting: HashMap<String, oneshot::Sender<Value>>,
}

struct Shared {
  profile: OnceLock<Value>,
  pending: Mutex<Pending>,
  output: mpsc::UnboundedSender<Output>,
  timing: Timing,
}

impl Shared {
  fn failure(&self, code: &str, message: &str) -> Value {
    protocol::failure(self.profile.get(), code, message)
  }

  fn send(&self, frame: Vec<u8>) {
    let _ = self.output.send(Output::Frame(frame));
  }

  fn finish(&self, id: &str, response: Value) {
    if let Some(waiter) = self.pending.lock().unwrap().waiting.remove(id) {
      let _ = waiter.send(response);
    }
  }

  fn forget(&self, id: &str) {
    self.pending.lock().unwrap().waiting.remove(id);
  }
}

enum Input {
  Message(Value),
  End,
  Invalid,
}

type Binding = Pin<Box<dyn Future<Output = io::Result<Listener>> + Send>>;

pub async fn run(
  mut input: impl AsyncRead + Unpin + Send + 'static,
  mut output: impl AsyncWrite + Unpin + Send + 'static,
  home: Option<PathBuf>,
  timing: Timing,
  shutdown: impl Future<Output = ()>,
) -> i32 {
  let (output_tx, mut output_rx) = mpsc::unbounded_channel::<Output>();
  let (stop_tx, mut stop_rx) = mpsc::unbounded_channel::<i32>();
  let writer_stop = stop_tx.clone();
  let writer = tokio::spawn(async move {
    while let Some(item) = output_rx.recv().await {
      match item {
        Output::Frame(frame) => {
          if output.write_all(&frame).await.is_err() || output.flush().await.is_err() {
            let _ = writer_stop.send(1);
            return;
          }
        }
        Output::Flush(done) => {
          let _ = done.send(());
        }
      }
    }
  });
  // Reading stdin in its own task keeps a frame whole when another select branch wins.
  let (input_tx, mut input_rx) = mpsc::unbounded_channel::<Input>();
  let reader = tokio::spawn(async move {
    loop {
      let item = match frame::read(&mut input).await {
        Ok(Some(message)) => Input::Message(message),
        Ok(None) => Input::End,
        Err(_) => Input::Invalid,
      };
      let last = !matches!(item, Input::Message(_));
      if input_tx.send(item).is_err() || last {
        return;
      }
    }
  });

  let shared = Arc::new(Shared {
    profile: OnceLock::new(),
    pending: Mutex::new(Pending {
      stopped: false,
      next_id: 0,
      waiting: HashMap::new(),
    }),
    output: output_tx,
    timing,
  });
  let (stopping_tx, stopping_rx) = watch::channel(false);
  let mut clients = JoinSet::new();
  let mut listener: Option<Listener> = None;
  let mut binding: Option<Binding> = None;
  let mut pipe = String::new();
  tokio::pin!(shutdown);

  let code = loop {
    tokio::select! {
      item = input_rx.recv() => match item {
        Some(Input::Message(message)) if shared.profile.get().is_none() => {
          if message["type"] != "hello" || !protocol::is_profile(&message["profile"]) {
            break 1;
          }
          let profile = message["profile"].clone();
          if protocol::integer(&profile["protocolVersion"]) != Some(PROTOCOL_VERSION) {
            send_json(&shared, &json!({ "type": "refused", "code": "protocol_mismatch",
              "message": "Update the extension and browser-agent CLI together." }));
            break 1;
          }
          let instance_id = profile["instanceId"].as_str().unwrap_or_default().to_owned();
          let _ = shared.profile.set(profile);
          match endpoint::endpoint(&instance_id, home.as_deref()).and_then(|path| endpoint::prepare(&path).map(|()| path)) {
            Ok(path) => {
              pipe = path.clone();
              binding = Some(Box::pin(bind(path, timing)));
            }
            Err(_) => break 1,
          }
        }
        Some(Input::Message(message)) => {
          let id = message.get("id").and_then(Value::as_str).map(str::to_owned);
          match id {
            Some(id) if listener.is_some() && protocol::is_response(&message) => {
              let mut response = message;
              response.as_object_mut().expect("a response is an object").remove("id");
              shared.finish(&id, response);
            }
            _ => break 1,
          }
        }
        Some(Input::Invalid) => break 1,
        Some(Input::End) | None => break 0,
      },
      bound = async { binding.as_mut().expect("guarded by the branch condition").await }, if binding.is_some() => {
        binding = None;
        match bound {
          Ok(bound) => {
            let restricted = bound.restrict();
            listener = Some(bound);
            if restricted.is_err() {
              break 1;
            }
            send_json(&shared, &json!({ "type": "ready", "pipe": pipe }));
          }
          Err(_) => {
            send_json(&shared, &json!({ "type": "refused", "code": "pipe_busy",
              "message": "Profile pipe is unavailable. Close and reopen this browser profile." }));
            break 1;
          }
        }
      },
      accepted = async { listener.as_mut().expect("guarded by the branch condition").accept().await }, if listener.is_some() => {
        match accepted {
          Ok(stream) => {
            clients.spawn(serve(stream, shared.clone(), stopping_rx.clone()));
          }
          // A client that left before the connection completed; the listener keeps serving.
          Err(_) => sleep(Duration::from_millis(50)).await,
        }
      },
      Some(_) = clients.join_next(), if !clients.is_empty() => {},
      Some(code) = stop_rx.recv() => break code,
      () = &mut shutdown => break 0,
    }
  };

  let waiting: Vec<_> = {
    let mut pending = shared.pending.lock().unwrap();
    pending.stopped = true;
    pending.waiting.drain().map(|(_, waiter)| waiter).collect()
  };
  for waiter in waiting {
    let _ = waiter.send(shared.failure(
      "extension_disconnected",
      "Extension disconnected. Open the browser and reload the extension.",
    ));
  }
  let _ = stopping_tx.send(true);
  if let Some(listener) = listener {
    listener.close();
  }
  let _ = timeout(DRAIN, async { while clients.join_next().await.is_some() {} }).await;
  let (flushed_tx, flushed_rx) = oneshot::channel();
  if shared.output.send(Output::Flush(flushed_tx)).is_ok() {
    let _ = timeout(DRAIN, flushed_rx).await;
  }
  reader.abort();
  writer.abort();
  code
}

fn send_json(shared: &Shared, value: &Value) {
  if let Ok(frame) = frame::encode(value) {
    shared.send(frame);
  }
}

async fn bind(path: String, timing: Timing) -> io::Result<Listener> {
  let mut retries = 0;
  loop {
    match Listener::bind(&path) {
      Ok(listener) => return Ok(listener),
      Err(error) if endpoint::in_use(&error) && retries < BIND_RETRIES => {
        retries += 1;
        endpoint::clear_stale(&path).await;
        sleep(timing.bind_retry).await;
      }
      Err(error) => return Err(error),
    }
  }
}

enum Line {
  Complete(Vec<u8>),
  TooLarge,
  Closed,
}

async fn read_line(reader: &mut ReadHalf<Stream>) -> Line {
  let mut bytes = Vec::new();
  let mut chunk = vec![0u8; 64 * 1024];
  loop {
    let read = match reader.read(&mut chunk).await {
      Ok(0) | Err(_) => return Line::Closed,
      Ok(read) => read,
    };
    let start = bytes.len();
    bytes.extend_from_slice(&chunk[..read]);
    if bytes.len() > MAX_REQUEST_BYTES {
      return Line::TooLarge;
    }
    if let Some(newline) = bytes[start..].iter().position(|&byte| byte == b'\n') {
      bytes.truncate(start + newline);
      return Line::Complete(bytes);
    }
  }
}

async fn closed(reader: &mut ReadHalf<Stream>) {
  let mut chunk = vec![0u8; 64 * 1024];
  while let Ok(read) = reader.read(&mut chunk).await {
    if read == 0 {
      return;
    }
  }
}

// The client closes after reading its line; waiting for that keeps a named pipe from discarding the answer.
async fn reply(mut reader: ReadHalf<Stream>, mut writer: WriteHalf<Stream>, response: Value) {
  let mut line = serde_json::to_vec(&response).expect("a JSON value serializes");
  line.push(b'\n');
  if writer.write_all(&line).await.is_ok() && writer.flush().await.is_ok() {
    let _ = writer.shutdown().await;
    let _ = timeout(DRAIN, closed(&mut reader)).await;
  }
}

struct Relay {
  id: String,
  answer: oneshot::Receiver<Value>,
  limit: Duration,
}

async fn serve(stream: Stream, shared: Arc<Shared>, mut stopping: watch::Receiver<bool>) {
  let (mut reader, writer) = tokio::io::split(stream);
  let line = tokio::select! {
    line = timeout(shared.timing.idle, read_line(&mut reader)) => line,
    _ = stopping.wait_for(|stopped| *stopped) => return,
  };
  let relay = match line {
    Ok(Line::Complete(line)) => relay(&line, &shared),
    Ok(Line::TooLarge) => Err(shared.failure("extension_error", "Request too large. Update the browser-agent CLI.")),
    Ok(Line::Closed) | Err(_) => return,
  };
  let Relay { id, answer, limit } = match relay {
    Ok(relay) => relay,
    Err(failure) => return reply(reader, writer, failure).await,
  };
  let response = tokio::select! {
    answer = answer => answer.unwrap_or_else(|_| shared.failure("extension_disconnected",
      "Extension disconnected. Open the browser and reload the extension.")),
    () = sleep(limit) => {
      shared.forget(&id);
      shared.failure("extension_timeout",
        &format!("Extension did not answer within {} seconds. Reload it in the browser.", limit.as_secs()))
    }
    () = closed(&mut reader) => {
      shared.forget(&id);
      return;
    }
  };
  reply(reader, writer, response).await;
}

fn relay(line: &[u8], shared: &Shared) -> Result<Relay, Value> {
  let invalid = || shared.failure("extension_error", "Invalid request. Update the browser-agent CLI.");
  let request: Value = serde_json::from_slice(line).map_err(|_| invalid())?;
  if !protocol::is_request(&request) {
    return Err(invalid());
  }
  if protocol::integer(&request["protocolVersion"]) != Some(PROTOCOL_VERSION) {
    return Err(shared.failure(
      "protocol_mismatch",
      "Protocol mismatch. Update the extension and browser-agent CLI together.",
    ));
  }
  let mut relayed = request;
  let files = relayed.as_object_mut().expect("a request is an object").remove("files");
  let files = files.as_ref().and_then(Value::as_array).cloned().unwrap_or_default();
  let file_bytes: f64 = files
    .iter()
    .map(|file| file["data"].as_str().unwrap_or_default().len() as f64 * 3.0 / 4.0)
    .sum();
  let relayed_bytes = serde_json::to_vec(&relayed).map_err(|_| invalid())?.len();
  if relayed_bytes > MAX_MESSAGE_BYTES - 1024 || file_bytes > MAX_FILE_BYTES as f64 {
    return Err(shared.failure("tool_args_invalid", "Request too large: arguments over 1 MiB or files over 25 MB."));
  }

  let (waiter, answer) = oneshot::channel();
  let id = {
    let mut pending = shared.pending.lock().unwrap();
    if pending.stopped {
      return Err(shared.failure(
        "extension_disconnected",
        "Extension disconnected. Open the browser and reload the extension.",
      ));
    }
    pending.next_id += 1;
    let id = pending.next_id.to_string();
    pending.waiting.insert(id.clone(), waiter);
    id
  };
  let mut frames = Vec::new();
  for (index, file) in files.iter().enumerate() {
    let data = file["data"].as_str().unwrap_or_default();
    let mut offset = 0;
    // An empty file still sends one chunk, so the extension knows it exists.
    loop {
      let end = (offset + FILE_CHUNK_CHARS).min(data.len());
      frames.push(frame::encode(
        &json!({ "type": "fileChunk", "id": id, "index": index, "name": file["name"], "data": &data[offset..end] }),
      ));
      offset = end;
      if offset >= data.len() {
        break;
      }
    }
  }
  relayed["id"] = id.clone().into();
  frames.push(frame::encode(&relayed));
  let frames: Result<Vec<_>, _> = frames.into_iter().collect();
  let Ok(frames) = frames else {
    shared.forget(&id);
    return Err(invalid());
  };
  for frame in frames {
    shared.send(frame);
  }
  let limit = if files.is_empty() {
    shared.timing.request
  } else {
    shared.timing.request_with_files
  };
  Ok(Relay { id, answer, limit })
}

#[cfg(test)]
mod tests {
  use super::*;
  use tokio::io::{AsyncBufReadExt, BufReader, DuplexStream, duplex};

  const SHORT: Timing = Timing {
    request: Duration::from_millis(300),
    request_with_files: Duration::from_millis(300),
    idle: Duration::from_millis(300),
    bind_retry: Duration::from_millis(10),
  };

  struct Browser {
    stdin: DuplexStream,
    stdout: DuplexStream,
    profile: Value,
  }

  impl Browser {
    async fn send(&mut self, value: Value) {
      self.stdin.write_all(&frame::encode(&value).unwrap()).await.unwrap();
    }

    async fn next(&mut self) -> Value {
      frame::read(&mut self.stdout).await.unwrap().expect("a frame")
    }
  }

  static NEXT_PROFILE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

  fn start() -> (Browser, tokio::task::JoinHandle<i32>) {
    let (stdin, host_in) = duplex(4 * 1024 * 1024);
    let (host_out, stdout) = duplex(4 * 1024 * 1024);
    let pid = std::process::id();
    // The macOS temporary directory is too deep for the 104-byte socket path limit.
    let home = PathBuf::from(format!("/tmp/ba-{pid}"));
    let serial = NEXT_PROFILE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let id = format!("00000000-0000-4000-{:04x}-{pid:012x}", serial);
    let profile = json!({ "instanceId": id, "label": "fixture", "agentAccess": true, "extensionVersion": "0.1.0",
      "protocolVersion": PROTOCOL_VERSION, "tools": [] });
    let task = tokio::spawn(run(host_in, host_out, Some(home), SHORT, std::future::pending()));
    (Browser { stdin, stdout, profile }, task)
  }

  async fn ready(browser: &mut Browser) -> String {
    let profile = browser.profile.clone();
    browser.send(json!({ "type": "hello", "profile": profile })).await;
    let ready = browser.next().await;
    assert_eq!(ready["type"], "ready");
    ready["pipe"].as_str().unwrap().to_owned()
  }

  #[cfg(windows)]
  async fn connect(pipe: &str) -> tokio::net::windows::named_pipe::NamedPipeClient {
    tokio::net::windows::named_pipe::ClientOptions::new().open(pipe).unwrap()
  }

  #[cfg(unix)]
  async fn connect(pipe: &str) -> tokio::net::UnixStream {
    tokio::net::UnixStream::connect(pipe).await.unwrap()
  }

  async fn ask(pipe: &str) -> BufReader<impl AsyncRead + AsyncWrite + Unpin> {
    let mut client = BufReader::new(connect(pipe).await);
    client
      .get_mut()
      .write_all(b"{\"op\":\"describe\",\"protocolVersion\":4}\n")
      .await
      .unwrap();
    client
  }

  async fn answer(client: &mut BufReader<impl AsyncRead + AsyncWrite + Unpin>) -> Value {
    let mut line = String::new();
    client.read_line(&mut line).await.unwrap();
    serde_json::from_str(&line).unwrap()
  }

  #[tokio::test]
  async fn times_out_a_silent_extension_and_drops_its_late_answer() {
    let (mut browser, task) = start();
    let pipe = ready(&mut browser).await;
    let mut client = ask(&pipe).await;
    let request = browser.next().await;
    assert_eq!(answer(&mut client).await["code"], "extension_timeout");
    let profile = browser.profile.clone();
    browser.send(json!({ "id": request["id"], "ok": true, "profile": profile })).await;
    drop(browser.stdin);
    assert_eq!(task.await.unwrap(), 0);
  }

  #[tokio::test]
  async fn closes_an_idle_client_without_an_answer() {
    let (mut browser, task) = start();
    let pipe = ready(&mut browser).await;
    let mut client = BufReader::new(connect(&pipe).await);
    let mut line = String::new();
    assert_eq!(client.read_line(&mut line).await.unwrap_or(0), 0);
    drop(browser.stdin);
    assert_eq!(task.await.unwrap(), 0);
  }

  #[tokio::test]
  async fn forgets_a_request_whose_client_left() {
    let (mut browser, task) = start();
    let pipe = ready(&mut browser).await;
    let client = ask(&pipe).await;
    let request = browser.next().await;
    drop(client);
    sleep(Duration::from_millis(50)).await;
    let profile = browser.profile.clone();
    browser.send(json!({ "id": request["id"], "ok": true, "profile": profile })).await;
    let mut second = ask(&pipe).await;
    let next = browser.next().await;
    assert_ne!(next["id"], request["id"]);
    let profile = browser.profile.clone();
    browser
      .send(json!({ "id": next["id"], "ok": true, "profile": profile, "value": 2 }))
      .await;
    assert_eq!(answer(&mut second).await["value"], 2);
    drop(browser.stdin);
    assert_eq!(task.await.unwrap(), 0);
  }
}
