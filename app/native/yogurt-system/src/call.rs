//! What Linux's and Windows's call watches share: which app a call is in, which windows can hold it, and whether a
//! window's tree is a call (Teams keeps its calendar and chat in windows shaped like the call's).

use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

/// what kind of window a call app has, from its id (detect.ts's names carry the app)
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Zoom,
    Teams,
    Meet,
}

pub fn kind(id: &str) -> Kind {
    let id = id.to_ascii_lowercase();
    if id.contains("zoom") {
        Kind::Zoom
    } else if id.contains("teams") {
        Kind::Teams
    } else {
        Kind::Meet
    }
}

/// the controls only a call window has: the calendar and chat views have none
pub const CALL_CONTROLS: &[&str] = &["leave", "leave call", "hang up", "end call", "mute mic", "unmute mic", "close participants pane"];

/// A button's label without the shortcut it can carry: "Leave (Ctrl+Shift+H)" is "leave", as on the Mac (#83)
fn control_label(s: &str) -> String {
    let s = s.trim();
    let s = match (s.ends_with(')'), s.rfind('(')) {
        (true, Some(i)) => &s[..i],
        _ => s,
    };
    s.trim().to_ascii_lowercase()
}

/// Whether a tree has a call control: the calendar and chat views have no Leave or Mute, the call window always does
pub fn is_call_tree(tree: &Value) -> bool {
    fn walk(n: &Value) -> bool {
        let Some(o) = n.as_object() else { return false };
        let role = o.get("r").and_then(Value::as_str).unwrap_or("");
        if matches!(role, "button" | "push button" | "toggle button" | "menu item") {
            for key in ["t", "d"] {
                if let Some(s) = o.get(key).and_then(Value::as_str) {
                    if CALL_CONTROLS.contains(&control_label(s).as_str()) {
                        return true;
                    }
                }
            }
        }
        o.get("k").and_then(Value::as_array).is_some_and(|kids| kids.iter().any(walk))
    }
    walk(tree)
}

/// Whether a window may hold the call: a browser only when its front tab is a Meet call, Zoom only a meeting, Teams
/// any window (its calendar and chat views look like the call's; is_call_tree tells them apart)
pub fn call_window(kind: Kind, title: &str) -> bool {
    match kind {
        Kind::Teams => true,
        Kind::Zoom => title.starts_with("Zoom Meeting") || title.starts_with("Zoom Webinar") || title == "Meeting",
        Kind::Meet => has_word(title, "meet"),
    }
}

/// "Meet - abc-defg-hij" has the word; "Meeting notes" does not
pub fn has_word(title: &str, word: &str) -> bool {
    title.split(|c: char| !c.is_alphanumeric()).any(|w| w.eq_ignore_ascii_case(word))
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_kind_comes_from_the_id() {
        assert_eq!(kind("us.zoom.xos"), Kind::Zoom);
        assert_eq!(kind("zoom"), Kind::Zoom);
        assert_eq!(kind("com.microsoft.teams2"), Kind::Teams);
        assert_eq!(kind("teams-for-linux"), Kind::Teams);
        assert_eq!(kind("com.github.IsmaelMartinez.teams_for_linux"), Kind::Teams);
        assert_eq!(kind("com.google.Chrome"), Kind::Meet);
        assert_eq!(kind("firefox"), Kind::Meet);
        // Windows: the program's file name, lowercased
        assert_eq!(kind("zoom.exe"), Kind::Zoom);
        assert_eq!(kind("ms-teams.exe"), Kind::Teams);
        assert_eq!(kind("msedge.exe"), Kind::Meet);
    }

    #[test]
    fn a_browser_window_is_a_call_only_with_the_word_meet() {
        assert!(call_window(Kind::Meet, "Meet - abc-defg-hij - Google Chrome"));
        assert!(call_window(Kind::Meet, "meet.google.com"));
        assert!(call_window(Kind::Meet, "Meet – abc-defg-hij and 1 more page - Work - Microsoft Edge"));
        assert!(!call_window(Kind::Meet, "Meeting notes - Google Chrome"));
        assert!(call_window(Kind::Zoom, "Zoom Meeting"));
        assert!(call_window(Kind::Zoom, "Meeting"));
        assert!(call_window(Kind::Zoom, "Zoom Webinar - 123"));
        assert!(!call_window(Kind::Zoom, "Zoom Workplace"));
    }

    #[test]
    fn only_a_tree_with_call_controls_is_a_call() {
        let call = json!({ "r": "frame", "k": [
            { "r": "static", "t": "Calendar | Meeting with Dana Smith | Microsoft Teams" },
            { "r": "button", "t": "Mute mic" },
            { "r": "button", "t": "Leave" }
        ] });
        assert!(is_call_tree(&call));
        let calendar = json!({ "r": "frame", "k": [
            { "r": "static", "t": "Calendar | Meeting with Dana Smith | Microsoft Teams" },
            { "r": "button", "t": "Go to today November 12, 2026" }
        ] });
        assert!(!is_call_tree(&calendar));
        assert!(!is_call_tree(&json!({})));
    }

    #[test]
    fn a_control_label_can_carry_its_shortcut() {
        // Teams on Windows names its buttons with the shortcut, as the Mac reader already allows (#83)
        let call = json!({ "r": "frame", "k": [{ "r": "button", "t": "Leave (Ctrl+Shift+H)" }] });
        assert!(is_call_tree(&call));
        let muted = json!({ "r": "frame", "k": [{ "r": "toggle button", "t": "Unmute mic (Ctrl+Shift+M)" }] });
        assert!(is_call_tree(&muted));
        assert!(!is_call_tree(&json!({ "r": "frame", "k": [{ "r": "button", "t": "Leave chat (Ctrl+Shift+L)" }] })));
    }
}
