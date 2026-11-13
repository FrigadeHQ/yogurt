//! The accessibility tree of a call app, read through AT-SPI on Linux: what yogurt-mac copies with AX on a Mac.
//! Read-only: nothing is clicked or changed in the app. The tree is cut at a depth and a node budget, like the Mac's.

use std::collections::HashMap;
use std::time::{Duration, Instant};

use serde_json::{json, Map, Value};
use zbus::blocking::{connection::Builder, Connection};
use zbus::zvariant::{DynamicDeserialize, OwnedObjectPath, OwnedValue};

const ACCESSIBLE: &str = "org.a11y.atspi.Accessible";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const TEXT: &str = "org.a11y.atspi.Text";
/// how long one call may wait for an app that stopped answering, like the Mac's AX messaging timeout
const TIMEOUT: Duration = Duration::from_millis(300);
/// the longest text copied from one element (the Mac caps it too)
const MAX_TEXT: usize = 300;
/// roles that hold text worth reading; inputs are never read
fn text_role(role: &str) -> bool {
    matches!(role, "static" | "label" | "text" | "paragraph" | "heading" | "caption" | "link" | "list item" | "table cell")
}
/// a Mac calls a window a window; AT-SPI has more than one word for it
pub fn window_role(role: &str) -> bool {
    matches!(role, "frame" | "window" | "dialog")
}

pub struct A11y {
    conn: Connection,
}

/// One application on the accessibility bus: its bus name and root object
pub struct App {
    pub bus: String,
    pub path: OwnedObjectPath,
}

impl A11y {
    /// The accessibility bus: the session bus says where it is (org.a11y.Bus)
    pub fn connect() -> Result<Self, String> {
        let session = Builder::session()
            .map_err(|e| format!("no session bus: {e}"))?
            .method_timeout(TIMEOUT)
            .build()
            .map_err(|e| format!("no session bus: {e}"))?;
        let addr: String = session
            .call_method(Some("org.a11y.Bus"), "/org/a11y/bus", Some("org.a11y.Bus"), "GetAddress", &())
            .map_err(|e| format!("no accessibility bus: {e}"))?
            .body()
            .deserialize()
            .map_err(|e| format!("bad accessibility address: {e}"))?;
        let conn = Builder::address(addr.as_str())
            .map_err(|e| format!("bad accessibility address: {e}"))?
            .method_timeout(TIMEOUT)
            .build()
            .map_err(|e| format!("cannot reach the accessibility bus: {e}"))?;
        Ok(Self { conn })
    }

    /// The applications on the bus now
    pub fn apps(&self) -> Result<Vec<App>, String> {
        let children: Vec<(String, OwnedObjectPath)> = self
            .call("org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root", ACCESSIBLE, "GetChildren", &())
            .map_err(|e| format!("cannot list the accessibility apps: {e}"))?;
        Ok(children.into_iter().map(|(bus, path)| App { bus, path }).collect())
    }

    /// The process id behind an application's bus name
    pub fn pid(&self, bus: &str) -> Option<u32> {
        self.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID", &(bus,))
            .ok()
    }

    /// The name an element shows (its accessible name)
    pub fn name(&self, bus: &str, path: &OwnedObjectPath) -> Option<String> {
        self.props(bus, path).get("Name").and_then(|v| v.downcast_ref::<&str>().ok()).map(str::to_string)
    }

    /// The role AT-SPI gives an element
    pub fn role(&self, bus: &str, path: &OwnedObjectPath) -> Option<String> {
        self.call(bus, path.as_str(), ACCESSIBLE, "GetRoleName", &()).ok()
    }

    /// The elements directly under one
    pub fn children(&self, bus: &str, path: &OwnedObjectPath) -> Vec<(String, OwnedObjectPath)> {
        self.call(bus, path.as_str(), ACCESSIBLE, "GetChildren", &()).unwrap_or_default()
    }

    /// One element and what is under it, in the shape src/main/callNames/parse.ts reads (AxNode). Stops at `deadline`,
    /// so an app that stopped answering cannot hold the watch for minutes.
    pub fn node(&self, bus: &str, path: &OwnedObjectPath, depth: usize, max_depth: usize, budget: &mut i32, deadline: Instant) -> Value {
        if Instant::now() >= deadline {
            return Value::Object(Map::new());
        }
        *budget -= 1;
        let role = self.role(bus, path).unwrap_or_default();
        let props = self.props(bus, path);
        let mut n = Map::new();
        n.insert("r".into(), json!(role));
        let name = props.get("Name").and_then(|v| v.downcast_ref::<&str>().ok()).filter(|s| !s.is_empty());
        if let Some(x) = props.get("Description").and_then(|v| v.downcast_ref::<&str>().ok()).filter(|s| !s.is_empty()) {
            n.insert("d".into(), json!(clip(x)));
        }
        if let Some(x) = name {
            n.insert("t".into(), json!(clip(x)));
        }
        // what someone types is never copied
        if text_role(&role) {
            if let Some(x) = self.text(bus, path).filter(|x| !x.is_empty() && Some(x.as_str()) != name) {
                n.insert("v".into(), json!(clip(&x)));
            }
        }
        let attrs = self.attrs(bus, path);
        if let Some(x) = attrs.get("id").filter(|s| !s.is_empty()) {
            n.insert("i".into(), json!(x));
        }
        if let Some(x) = attrs.get("class") {
            let classes: Vec<&str> = x.split_whitespace().take(20).collect();
            if !classes.is_empty() {
                n.insert("c".into(), json!(classes));
            }
        }
        if depth < max_depth && *budget > 0 && Instant::now() < deadline {
            let mut kids = Vec::new();
            for (b, p) in self.children(bus, path) {
                if *budget <= 0 || Instant::now() >= deadline {
                    break;
                }
                kids.push(self.node(&b, &p, depth + 1, max_depth, budget, deadline));
            }
            if !kids.is_empty() {
                n.insert("k".into(), json!(kids));
            }
        }
        Value::Object(n)
    }

    fn props(&self, bus: &str, path: &OwnedObjectPath) -> HashMap<String, OwnedValue> {
        // Qt's AT-SPI adaptor (Zoom) does not implement GetAll and crashes when asked; the two properties are
        // asked for one at a time, which every app answers
        let mut out = HashMap::new();
        for key in ["Name", "Description"] {
            if let Ok(v) = self.call(bus, path.as_str(), PROPERTIES, "Get", &(ACCESSIBLE, key)) {
                out.insert(key.to_string(), v);
            }
        }
        out
    }

    fn attrs(&self, bus: &str, path: &OwnedObjectPath) -> HashMap<String, String> {
        self.call(bus, path.as_str(), ACCESSIBLE, "GetAttributes", &()).unwrap_or_default()
    }

    fn text(&self, bus: &str, path: &OwnedObjectPath) -> Option<String> {
        self.call(bus, path.as_str(), TEXT, "GetText", &(0i32, -1i32)).ok()
    }

    fn call<B, R>(&self, dest: &str, path: &str, iface: &str, method: &str, body: &B) -> Result<R, String>
    where
        B: serde::ser::Serialize + zbus::zvariant::DynamicType,
        R: for<'de> DynamicDeserialize<'de>,
    {
        let reply = self
            .conn
            .call_method(Some(dest), path, Some(iface), method, body)
            .map_err(|e| e.to_string())?;
        reply.body().deserialize().map_err(|e| e.to_string())
    }
}

fn clip(s: &str) -> String {
    let s = s.trim();
    match s.char_indices().nth(MAX_TEXT) {
        Some((i, _)) => s[..i].to_string(),
        None => s.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inputs_are_never_read_but_labels_are() {
        for role in ["static", "label", "text", "paragraph", "heading", "link"] {
            assert!(text_role(role), "{role}");
        }
        for role in ["entry text", "password text", "text field", "combo box", "document web", "push button"] {
            assert!(!text_role(role), "{role}");
        }
    }

    #[test]
    fn a_window_is_a_frame_window_or_dialog() {
        for role in ["frame", "window", "dialog"] {
            assert!(window_role(role), "{role}");
        }
        for role in ["panel", "section", "page tab"] {
            assert!(!window_role(role), "{role}");
        }
    }

    #[test]
    fn long_text_is_cut_like_the_mac_helper() {
        assert_eq!(clip("  hi  "), "hi");
        let long = "a".repeat(400);
        assert_eq!(clip(&long).chars().count(), MAX_TEXT);
    }
}
