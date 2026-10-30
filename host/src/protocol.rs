//! The wire rules of `shared/protocol.ts` that the host enforces. Keep both in step: the extension,
//! the CLI and Meeting Recorder read the TypeScript version.

use base64::Engine;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

pub const PROTOCOL_VERSION: i64 = 4;
pub const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
pub const MAX_FILE_BYTES: usize = 25 * 1024 * 1024;
pub const MAX_REQUEST_BYTES: usize = 36 * 1024 * 1024;
// The browser caps a host-to-extension message at 1 MiB, so file data goes in chunks of whole base64 groups.
pub const FILE_CHUNK_CHARS: usize = 800_000;
pub const PIPE_PREFIX: &str = "browser-agent-";
pub const HOST_NAME: &str = "com.ludekvodicka.browser_agent";

const ERROR_CODES: [&str; 17] = [
  "access_off",
  "tool_unknown",
  "tool_denied",
  "permission_missing",
  "not_signed_in",
  "protocol_mismatch",
  "extension_disconnected",
  "extension_timeout",
  "extension_error",
  "profile_not_found",
  "profile_ambiguous",
  "no_profiles",
  "output_required",
  "tab_missing",
  "tab_not_ready",
  "tool_args_invalid",
  "result_too_large",
];

pub fn extension_id_from_key(key: &str) -> Option<String> {
  if key.is_empty() || !is_base64(key) {
    return None;
  }
  let der = base64::engine::general_purpose::STANDARD.decode(key).ok()?;
  let digest = Sha256::digest(der);
  Some(
    digest[..16]
      .iter()
      .flat_map(|byte| [byte >> 4, byte & 15])
      .map(|nibble| (b'a' + nibble) as char)
      .collect(),
  )
}

pub fn extension_id() -> String {
  let manifest: Value = serde_json::from_str(include_str!("../../extension/manifest.json")).expect("extension manifest is JSON");
  extension_id_from_key(manifest["key"].as_str().unwrap_or("")).expect("extension manifest has a valid public key")
}

pub fn is_instance_id(value: &str) -> bool {
  let groups: Vec<&str> = value.split('-').collect();
  groups.len() == 5
    && groups
      .iter()
      .zip([8, 4, 4, 4, 12])
      .all(|(group, length)| group.len() == length && group.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn is_base64(value: &str) -> bool {
  let body = value.trim_end_matches('=');
  value.len() - body.len() <= 2 && body.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'+' || b == b'/')
}

// JavaScript's Number.isInteger accepts 4.0 as well as 4.
fn is_integer(value: &Value) -> bool {
  value.is_i64() || value.is_u64() || value.as_f64().is_some_and(|number| number.is_finite() && number.fract() == 0.0)
}

pub fn integer(value: &Value) -> Option<i64> {
  if !is_integer(value) {
    return None;
  }
  value.as_i64().or_else(|| value.as_f64().map(|number| number as i64))
}

// JavaScript string length counts UTF-16 code units.
fn js_length(value: &str) -> usize {
  value.encode_utf16().count()
}

fn is_string(value: &Value) -> bool {
  value.is_string()
}

fn is_tool(value: &Value) -> bool {
  let Some(tool) = value.as_object() else { return false };
  ["id", "section", "group", "title"]
    .iter()
    .all(|key| tool.get(*key).is_some_and(is_string))
    && tool
      .get("hosts")
      .and_then(Value::as_array)
      .is_some_and(|hosts| hosts.iter().all(is_string))
    && tool.get("sensitive").is_some_and(Value::is_boolean)
    && tool.get("enabled").is_some_and(Value::is_boolean)
}

pub fn is_profile(value: &Value) -> bool {
  let Some(profile) = value.as_object() else { return false };
  profile.get("instanceId").and_then(Value::as_str).is_some_and(is_instance_id)
    && profile.get("label").is_some_and(|label| label.is_null() || label.is_string())
    && profile.get("agentAccess").is_some_and(Value::is_boolean)
    && profile.get("extensionVersion").is_some_and(is_string)
    && profile.get("protocolVersion").is_some_and(is_integer)
    && profile
      .get("tools")
      .and_then(Value::as_array)
      .is_some_and(|tools| tools.iter().all(is_tool))
}

pub fn is_tool_file(value: &Value) -> bool {
  let Some(file) = value.as_object() else { return false };
  file
    .get("name")
    .and_then(Value::as_str)
    .is_some_and(|name| (1..=255).contains(&js_length(name)))
    && file.get("data").and_then(Value::as_str).is_some_and(is_base64)
}

fn is_short_text(value: Option<&Value>) -> bool {
  value
    .and_then(Value::as_str)
    .is_some_and(|text| (1..=128).contains(&js_length(text)))
}

pub fn is_request(value: &Value) -> bool {
  let Some(request) = value.as_object() else { return false };
  if !request.get("protocolVersion").is_some_and(is_integer) {
    return false;
  }
  match request.get("op").and_then(Value::as_str) {
    Some("describe") => true,
    Some("call") => {
      is_short_text(request.get("tool"))
        && is_short_text(request.get("caller"))
        && match request.get("files") {
          None => true,
          Some(files) => files
            .as_array()
            .is_some_and(|files| files.len() <= 20 && files.iter().all(is_tool_file)),
        }
    }
    _ => false,
  }
}

pub fn is_response(value: &Value) -> bool {
  let Some(response) = value.as_object() else { return false };
  match response.get("ok").and_then(Value::as_bool) {
    Some(true) => response.get("profile").is_some_and(is_profile),
    Some(false) => {
      response
        .get("code")
        .and_then(Value::as_str)
        .is_some_and(|code| ERROR_CODES.contains(&code))
        && response.get("message").is_some_and(is_string)
        && response.get("profile").is_none_or(is_profile)
    }
    None => false,
  }
}

pub fn failure(profile: Option<&Value>, code: &str, message: &str) -> Value {
  let name = profile
    .and_then(|profile| {
      profile["label"]
        .as_str()
        .filter(|label| !label.is_empty())
        .or_else(|| profile["instanceId"].as_str())
    })
    .unwrap_or("Browser profile");
  let mut response = Map::new();
  response.insert("ok".into(), Value::Bool(false));
  response.insert("code".into(), code.into());
  response.insert("message".into(), format!("{name}: {message}").into());
  if let Some(profile) = profile {
    response.insert("profile".into(), profile.clone());
  }
  Value::Object(response)
}

#[cfg(test)]
mod tests {
  use super::*;
  use serde_json::json;

  fn profile() -> Value {
    json!({ "instanceId": "00000000-0000-4000-8000-000000000000", "label": "fixture", "agentAccess": true,
      "extensionVersion": "0.1.0", "protocolVersion": 4,
      "tools": [{ "id": "a.b.c", "section": "a", "group": "b", "title": "C", "hosts": [], "sensitive": false, "enabled": true }] })
  }

  #[test]
  fn derives_the_chromium_extension_id_from_the_manifest_key() {
    let id = extension_id();
    assert_eq!(id.len(), 32);
    assert!(id.bytes().all(|b| (b'a'..=b'p').contains(&b)));
    assert_eq!(extension_id_from_key(""), None);
    assert_eq!(extension_id_from_key("not base64!"), None);
  }

  #[test]
  fn validates_profiles_like_the_typescript_protocol() {
    assert!(is_profile(&profile()));
    let mut bad = profile();
    bad["instanceId"] = "not-a-uuid".into();
    assert!(!is_profile(&bad));
    let mut bad = profile();
    bad["tools"][0]["enabled"] = "yes".into();
    assert!(!is_profile(&bad));
    let mut floating = profile();
    floating["protocolVersion"] = json!(4.0);
    assert!(is_profile(&floating));
  }

  #[test]
  fn validates_requests() {
    assert!(is_request(&json!({ "op": "describe", "protocolVersion": 4 })));
    assert!(is_request(
      &json!({ "op": "call", "protocolVersion": 4, "tool": "t", "caller": "c", "files": [{ "name": "a", "data": "QUJD" }] })
    ));
    assert!(!is_request(
      &json!({ "op": "call", "protocolVersion": 4, "tool": "", "caller": "c" })
    ));
    assert!(!is_request(
      &json!({ "op": "call", "protocolVersion": 4, "tool": "t".repeat(129), "caller": "c" })
    ));
    assert!(!is_request(
      &json!({ "op": "call", "protocolVersion": 4, "tool": "t", "caller": "c", "files": [{ "name": "a", "data": "@@" }] })
    ));
    assert!(!is_request(&json!({ "op": "watch", "protocolVersion": 4 })));
    assert!(!is_request(&json!({ "op": "describe", "protocolVersion": 4.5 })));
    assert!(!is_request(&json!([])));
  }

  #[test]
  fn validates_responses() {
    assert!(is_response(&json!({ "ok": true, "profile": profile(), "value": 1 })));
    assert!(is_response(&json!({ "ok": false, "code": "tool_denied", "message": "no" })));
    assert!(!is_response(&json!({ "ok": false, "code": "invented", "message": "no" })));
    assert!(!is_response(&json!({ "ok": true })));
  }

  #[test]
  fn names_the_profile_in_failures() {
    let labelled = profile();
    assert_eq!(failure(Some(&labelled), "extension_timeout", "late")["message"], "fixture: late");
    let mut unlabelled = profile();
    unlabelled["label"] = "".into();
    assert_eq!(
      failure(Some(&unlabelled), "extension_timeout", "late")["message"],
      "00000000-0000-4000-8000-000000000000: late"
    );
    assert_eq!(
      failure(None, "extension_error", "bad"),
      json!({ "ok": false, "code": "extension_error", "message": "Browser profile: bad" })
    );
  }
}
