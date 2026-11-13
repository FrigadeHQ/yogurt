//! Who talks in a Teams for Linux call, as Teams for Linux itself reports it over its opt-in D-Bus control
//! (dbusControl.enabled and dbusControl.callParticipants in its config.json). Teams marks the person talking only with
//! a ring, which the accessibility tree does not carry; Teams for Linux reads that ring from the meeting stage and
//! lists the remote people with a speaking flag in GetState's `callParticipants`. call-watch adds that list to the
//! reading of the accessibility tree. With the control off, the line is left as it was.

use std::time::Duration;

use serde_json::{json, Value};
use zbus::blocking::{connection::Builder, Connection};

/// the bus name of the Flatpak and the native build alike (a custom dbusControl.busName is not looked for)
const BUS: &str = "com.github.IsmaelMartinez.teams_for_linux";
const PATH: &str = "/com/github/IsmaelMartinez/teams_for_linux";
const IFACE: &str = "com.github.IsmaelMartinez.teams_for_linux.Control";
/// the ids Yogurt watches Teams for Linux by: its program name and its Flatpak app id
const IDS: &[&str] = &["teams-for-linux", BUS];
/// a Teams for Linux that stopped answering must not hold the watch
const TIMEOUT: Duration = Duration::from_millis(300);

/// The session bus, when one of the ids asked about is Teams for Linux
pub struct T4l {
    conn: Connection,
    id: String,
}

impl T4l {
    pub fn connect(ids: &[String]) -> Option<Self> {
        let id = ids.iter().find(|i| IDS.contains(&i.as_str()))?.clone();
        let conn = Builder::session().ok()?.method_timeout(TIMEOUT).build().ok()?;
        Some(Self { conn, id })
    }

    /// GetState's JSON; None when Teams for Linux is not running or its control is off
    fn state(&self) -> Option<String> {
        self.conn.call_method(Some(BUS), PATH, Some(IFACE), "GetState", &()).ok()?.body().deserialize().ok()
    }

    /// The line with what Teams for Linux reports added, or the line as it was
    pub fn enrich(&self, line: Value) -> Value {
        match self.state().as_deref().and_then(reported) {
            Some(r) => merged(line, &self.id, r),
            None => line,
        }
    }
}

/// `{speaking, participants}` from GetState's JSON: the remote people on the stage and who of them talks. None outside
/// a call (null), with the option off or an older Teams for Linux (missing), or when nobody can be named.
fn reported(state: &str) -> Option<Value> {
    let v: Value = serde_json::from_str(state).ok()?;
    let mut speaking = Vec::new();
    let mut participants = Vec::new();
    for p in v.get("callParticipants")?.as_array()? {
        let Some(name) = p.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()) else { continue };
        let talks = p.get("speaking").and_then(Value::as_bool) == Some(true);
        // a tile in transition shows "Leaving..." or "Connecting…" for a name (Teams for Linux skips them too)
        if !talks && (name.ends_with("...") || name.ends_with('…')) {
            continue;
        }
        if talks {
            speaking.push(name);
        }
        participants.push(name);
    }
    (!participants.is_empty()).then(|| json!({ "speaking": speaking, "participants": participants }))
}

/// The report goes on the reading of Teams for Linux's windows. When the windows could not be read (no call window,
/// no accessibility), the report alone is the reading. A line about another app is kept as it is.
fn merged(mut line: Value, id: &str, reported: Value) -> Value {
    if line.get("error").is_some() {
        return json!({ "t": line["t"], "app": id, "reported": reported });
    }
    let ours = line.get("app").and_then(Value::as_str).is_some_and(|a| IDS.contains(&a));
    if ours {
        line["reported"] = reported;
    }
    line
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_people_and_who_talks() {
        let state = r#"{"inCall":true,"callParticipants":[{"name":"Ada","speaking":true},{"name":"Grace","speaking":false}]}"#;
        assert_eq!(reported(state), Some(json!({ "speaking": ["Ada"], "participants": ["Ada", "Grace"] })));
    }

    #[test]
    fn nothing_outside_a_call_or_with_the_option_off() {
        assert_eq!(reported(r#"{"inCall":false,"callParticipants":null}"#), None);
        assert_eq!(reported(r#"{"inCall":true}"#), None);
        assert_eq!(reported(r#"{"callParticipants":[]}"#), None);
        assert_eq!(reported(r#"{"callParticipants":"x"}"#), None);
        assert_eq!(reported("not json"), None);
    }

    #[test]
    fn bad_entries_are_skipped() {
        let state = r#"{"callParticipants":[{"name":"  "},{"speaking":true},{"name":" Ada ","speaking":"yes"},7]}"#;
        assert_eq!(reported(state), Some(json!({ "speaking": [], "participants": ["Ada"] })));
    }

    #[test]
    fn a_status_in_place_of_a_name_is_no_person_unless_it_talks() {
        let state = r#"{"callParticipants":[{"name":"Leaving...","speaking":false},{"name":"Connecting…","speaking":false},{"name":"Ada","speaking":false}]}"#;
        assert_eq!(reported(state), Some(json!({ "speaking": [], "participants": ["Ada"] })));
        let state = r#"{"callParticipants":[{"name":"Grace...","speaking":true}]}"#;
        assert_eq!(reported(state), Some(json!({ "speaking": ["Grace..."], "participants": ["Grace..."] })));
    }

    #[test]
    fn two_people_with_one_name_stay_two() {
        let state = r#"{"callParticipants":[{"name":"John Smith","speaking":true},{"name":"John Smith","speaking":false}]}"#;
        assert_eq!(reported(state).unwrap()["participants"], json!(["John Smith", "John Smith"]));
    }

    #[test]
    fn the_report_goes_on_the_windows_of_teams_for_linux() {
        let r = json!({ "speaking": ["Ada"], "participants": ["Ada"] });
        let line = json!({ "t": 5, "app": "teams-for-linux", "windows": [] });
        assert_eq!(merged(line, "teams-for-linux", r.clone()), json!({ "t": 5, "app": "teams-for-linux", "windows": [], "reported": r }));
    }

    #[test]
    fn with_no_window_read_the_report_is_the_reading() {
        let r = json!({ "speaking": [], "participants": ["Ada"] });
        for error in ["no-call-window", "no-accessibility"] {
            let line = json!({ "t": 5, "error": error });
            assert_eq!(merged(line, BUS, r.clone()), json!({ "t": 5, "app": BUS, "reported": r }));
        }
    }

    #[test]
    fn a_line_about_another_app_is_kept() {
        let line = json!({ "t": 5, "app": "us.zoom.xos", "windows": [] });
        assert_eq!(merged(line.clone(), BUS, json!({ "speaking": [], "participants": ["Ada"] })), line);
    }
}
