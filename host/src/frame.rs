//! Native messaging framing: a little-endian u32 length, then that many bytes of UTF-8 JSON.

use crate::protocol::MAX_MESSAGE_BYTES;
use serde_json::Value;
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt};

pub fn encode(value: &Value) -> io::Result<Vec<u8>> {
  let body = serde_json::to_vec(value)?;
  if body.is_empty() || body.len() > MAX_MESSAGE_BYTES {
    return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid native frame length."));
  }
  let mut frame = (body.len() as u32).to_le_bytes().to_vec();
  frame.extend(body);
  Ok(frame)
}

/// The next message, or `None` when the browser closed the stream between frames.
pub async fn read(input: &mut (impl AsyncRead + Unpin)) -> io::Result<Option<Value>> {
  let mut header = [0u8; 4];
  match input.read_exact(&mut header).await {
    Ok(_) => {}
    Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
    Err(error) => return Err(error),
  }
  let length = u32::from_le_bytes(header) as usize;
  if length == 0 || length > MAX_MESSAGE_BYTES {
    return Err(io::Error::new(io::ErrorKind::InvalidData, "Invalid native frame length."));
  }
  let mut body = vec![0u8; length];
  input.read_exact(&mut body).await?;
  Ok(Some(serde_json::from_slice(&body)?))
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  #[tokio::test]
  async fn decodes_consecutive_utf8_frames() {
    let mut bytes = encode(&json!({ "text": "čau" })).unwrap();
    bytes.extend(encode(&json!({ "n": 2 })).unwrap());
    let mut input = bytes.as_slice();
    assert_eq!(read(&mut input).await.unwrap(), Some(json!({ "text": "čau" })));
    assert_eq!(read(&mut input).await.unwrap(), Some(json!({ "n": 2 })));
    assert_eq!(read(&mut input).await.unwrap(), None);
  }

  #[tokio::test]
  async fn rejects_oversized_zero_and_malformed_frames() {
    let mut oversized: &[u8] = &((MAX_MESSAGE_BYTES as u32 + 1).to_le_bytes());
    assert!(read(&mut oversized).await.is_err());
    let mut zero: &[u8] = &[0, 0, 0, 0];
    assert!(read(&mut zero).await.is_err());
    let mut malformed: &[u8] = &[1, 0, 0, 0, b'{'];
    assert!(read(&mut malformed).await.is_err());
    assert!(encode(&json!("x".repeat(MAX_MESSAGE_BYTES))).is_err());
  }
}
