//! When to reopen a stream after the sound devices change (#152). A Bluetooth headset switching between music
//! and hands-free mode (WirePlumber's autoswitch) tears its output down and builds it again, and the defaults
//! flip back and forth for a second or two. Reopening on each change made Yogurt close and open streams all
//! through the switch, and the call app lost its devices. So: wait until the changes stop, then reopen only a
//! stream whose device is really different from the one it was opened on.

use crate::pulse::Snapshot;
use std::time::{Duration, Instant};

/// Quiet this long after the last change before looking again
pub const QUIET: Duration = Duration::from_millis(1000);
/// Never wait longer than this after the first change of a burst, so a device that keeps changing is still followed
pub const CAP: Duration = Duration::from_millis(5000);

/// A trailing wait that restarts on each change, up to CAP after the first one
#[derive(Default, Debug)]
pub struct Settle { first: Option<Instant>, due: Option<Instant> }

impl Settle {
    /// something changed at now
    pub fn poke(&mut self, now: Instant) {
        let first = *self.first.get_or_insert(now);
        self.due = Some((now + QUIET).min(first + CAP));
    }
    /// look right away (a stream that could not be opened, a chosen mic that failed)
    pub fn now(&mut self, now: Instant) { self.first.get_or_insert(now); self.due = Some(now) }
    pub fn deadline(&self) -> Option<Instant> { self.due }
    /// true once, when the wait is over
    pub fn take(&mut self, now: Instant) -> bool {
        if self.due.is_none_or(|d| d > now) { return false }
        *self = Settle::default();
        true
    }
}

/// The device a stream was opened on: its name, and the server's index for it then (a device built again gets a new one)
#[derive(Clone, Debug, PartialEq)]
pub struct On { pub name: String, pub index: Option<u32> }

impl On {
    pub fn of(name: &str, snap: &Snapshot) -> On { On { name: name.to_string(), index: snap.index_of(name) } }
}

/// Whether the stream opened on `open` (None: none is open) has to be opened again to record from `want`
/// (None: nothing to record from, so trying is pointless).
pub fn reopen(open: Option<&On>, want: Option<&str>, snap: &Snapshot) -> bool {
    let Some(want) = want else { return false };
    let Some(open) = open else { return true };
    if open.name != want { return true }
    snap.ready && snap.index_of(want) != open.index
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pulse::Source;

    fn src(name: &str, index: u32) -> Source { Source { name: name.into(), description: name.into(), monitor: name.ends_with(".monitor"), index } }
    fn snap(sources: Vec<Source>) -> Snapshot { Snapshot { ready: true, default_sink: None, default_source: None, sources } }
    fn ms(t: Instant, n: u64) -> Instant { t + Duration::from_millis(n) }

    #[test]
    fn a_burst_of_changes_gives_one_look_after_it_settles() {
        let t = Instant::now();
        let mut s = Settle::default();
        assert!(!s.take(t));
        // five changes 300 ms apart, like the headset switching to hands-free and back
        for i in 0..5 { s.poke(ms(t, i * 300)); assert!(!s.take(ms(t, i * 300 + 299))) }
        assert_eq!(s.deadline(), Some(ms(t, 1200 + 1000)));
        assert!(!s.take(ms(t, 2199)));
        assert!(s.take(ms(t, 2200)));
        // once only
        assert!(!s.take(ms(t, 2300)));
        assert_eq!(s.deadline(), None);
    }

    #[test]
    fn changes_that_never_stop_are_still_followed() {
        let t = Instant::now();
        let mut s = Settle::default();
        let mut looks = 0;
        for i in 0..100 {
            let now = ms(t, i * 200);
            if s.take(now) { looks += 1 }
            s.poke(now);
        }
        // 20 s of a change every 200 ms: a look every 5 s, not one per change and not never
        assert_eq!(looks, 3);
        // a new burst after a look starts its own wait
        let mut s = Settle::default();
        s.poke(t);
        assert!(s.take(ms(t, 1000)));
        s.poke(ms(t, 1500));
        assert_eq!(s.deadline(), Some(ms(t, 2500)));
    }

    #[test]
    fn looking_now_does_not_wait() {
        let t = Instant::now();
        let mut s = Settle::default();
        s.poke(t);
        s.now(ms(t, 10));
        assert!(s.take(ms(t, 10)));
    }

    #[test]
    fn the_same_device_is_kept() {
        let a = snap(vec![src("bluez_output.AA.1.monitor", 40), src("bluez_input.AA", 41)]);
        let on = On::of("bluez_output.AA.1.monitor", &a);
        assert_eq!(on.index, Some(40));
        // the defaults flipped and came back: same device, same index, nothing to do
        assert!(!reopen(Some(&on), Some("bluez_output.AA.1.monitor"), &a));
    }

    #[test]
    fn a_device_built_again_or_a_new_default_is_reopened() {
        let a = snap(vec![src("bluez_output.AA.1.monitor", 40)]);
        let on = On::of("bluez_output.AA.1.monitor", &a);
        // the headset's output torn down and built again under the same name
        let rebuilt = snap(vec![src("bluez_output.AA.1.monitor", 57)]);
        assert!(reopen(Some(&on), Some("bluez_output.AA.1.monitor"), &rebuilt));
        // gone
        assert!(reopen(Some(&on), Some("bluez_output.AA.1.monitor"), &snap(vec![])));
        // a different default output
        let other = snap(vec![src("bluez_output.AA.1.monitor", 40), src("speakers.monitor", 3)]);
        assert!(reopen(Some(&on), Some("speakers.monitor"), &other));
        // nothing open (the stream broke, or never opened)
        assert!(reopen(None, Some("speakers.monitor"), &other));
    }

    #[test]
    fn nothing_to_record_from_or_no_answer_changes_nothing() {
        let a = snap(vec![src("mic", 5)]);
        let on = On::of("mic", &a);
        assert!(!reopen(None, None, &a));
        assert!(!reopen(Some(&on), None, &a));
        // the server is reconnecting: wait for its answer (a broken stream says so on its own)
        assert!(!reopen(Some(&on), Some("mic"), &Snapshot::default()));
        // a name the server has no list entry for (@DEFAULT_MONITOR@ when there was no default output)
        let none = On::of("@DEFAULT_MONITOR@", &a);
        assert_eq!(none.index, None);
        assert!(!reopen(Some(&none), Some("@DEFAULT_MONITOR@"), &a));
    }
}
