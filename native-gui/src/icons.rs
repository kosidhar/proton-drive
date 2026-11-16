//! The app's icons, named by what they mean: Phosphor glyphs (egui-phosphor, MIT), drawn as text in their own font
//! family (`font`). One glyph means one thing everywhere (#276).
//!
//! Never in the proportional family: Inter, the app's font, has glyphs of its own at many private-use code points,
//! Phosphor's among them, and would draw those instead (#278).
#![cfg_attr(not(test), allow(dead_code, reason = "a vocabulary: each screen takes the names it needs"))]

use std::sync::Arc;

use egui_phosphor::regular as ph;

/// The icons' font family: Phosphor's regular weight alone.
const FAMILY: &str = "icons";

/// The font to draw an icon in, at `size` points.
pub fn font(size: f32) -> egui::FontId {
    egui::FontId::new(size, egui::FontFamily::Name(FAMILY.into()))
}

/// Adds Phosphor to `fonts`, as the icons' family only.
pub fn add_to_fonts(fonts: &mut egui::FontDefinitions) {
    fonts.font_data.insert("phosphor".into(), Arc::new(egui_phosphor::Variant::Regular.font_data()));
    fonts.families.insert(egui::FontFamily::Name(FAMILY.into()), vec!["phosphor".into()]);
}

// Sections
pub const HOME: &str = ph::HOUSE;
/// The Shared section, with Proton's chain for it
pub const SHARED: &str = ph::LINK;
pub const ACTIVITY: &str = ph::CLOCK_COUNTER_CLOCKWISE;
pub const SETTINGS: &str = ph::GEAR;

// Actions
/// Open in Files, Show in Files, Browse... for a folder
pub const FOLDER_OPEN: &str = ph::FOLDER_OPEN;
pub const TRASH: &str = ph::TRASH;
/// Sync now: send and fetch what changed
pub const SYNC: &str = ph::ARROWS_CLOCKWISE;
/// Load again, try again: Shared's Refresh and Retry, a stopped move's Try again
pub const REFRESH: &str = ph::ARROW_CLOCKWISE;
pub const PAUSE: &str = ph::PAUSE;
pub const RESUME: &str = ph::PLAY;
/// An item's share link (a straight link, unlike the Shared section's chain)
pub const LINK: &str = ph::LINK_SIMPLE_HORIZONTAL;
/// Stop sharing, an expired link
pub const LINK_BROKEN: &str = ph::LINK_SIMPLE_HORIZONTAL_BREAK;
/// Copy link
pub const COPY: &str = ph::COPY;
/// Manage… a share: its link and who has access
pub const MANAGE: &str = ph::USER_GEAR;
/// Open on the web
pub const WEB: &str = ph::GLOBE;
pub const SEARCH: &str = ph::MAGNIFYING_GLASS;
pub const SIGN_OUT: &str = ph::SIGN_OUT;
pub const SIGN_IN: &str = ph::SIGN_IN;
/// Remove someone from a share
pub const REMOVE: &str = ph::X;
/// Free up space, Keep online-only: a file kept in Proton Drive alone
pub const ONLINE_ONLY: &str = ph::CLOUD;
/// Mount again: put the drive back
pub const MOUNT: &str = ph::HARD_DRIVES;
/// Start fresh with this account
pub const RESTART: &str = ph::ARROW_COUNTER_CLOCKWISE;
/// Move files back
pub const MOVE_BACK: &str = ph::ARROW_U_UP_LEFT;
/// Keep Both: the two versions of a file
pub const KEEP_BOTH: &str = ph::FILES;
/// Keep Local: this computer's version
pub const KEEP_LOCAL: &str = ph::DESKTOP;
/// Keep Remote: the Proton Drive version
pub const KEEP_REMOTE: &str = ph::CLOUD_ARROW_DOWN;

// States and things
/// Up to date, done
pub const CHECK: &str = ph::CHECK_CIRCLE;
pub const WARNING: &str = ph::WARNING;
pub const OFFLINE: &str = ph::CLOUD_SLASH;
/// A password on a link
pub const LOCK: &str = ph::LOCK;
/// An expiry date
pub const CLOCK: &str = ph::CLOCK;
/// The people a share is with
pub const PEOPLE: &str = ph::USERS;
pub const PERSON: &str = ph::USER;
pub const INFO: &str = ph::INFO;
pub const FOLDER: &str = ph::FOLDER;
pub const FILE: &str = ph::FILE;

/// Every icon, for the tests
#[cfg(test)]
pub const ALL: [&str; 36] = [
    HOME, SHARED, ACTIVITY, SETTINGS, FOLDER_OPEN, TRASH, SYNC, PAUSE, RESUME, CHECK, WARNING, OFFLINE, LINK,
    LINK_BROKEN, LOCK, CLOCK, PEOPLE, COPY, MANAGE, WEB, REFRESH, SEARCH, INFO, SIGN_OUT, SIGN_IN, REMOVE, FOLDER, FILE,
    ONLINE_ONLY, MOUNT, RESTART, MOVE_BACK, KEEP_BOTH, KEEP_LOCAL, KEEP_REMOTE, PERSON,
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_icon_is_drawn_from_the_icon_font_and_means_one_thing() {
        let ctx = egui::Context::default();
        crate::configure_proton_theme(&ctx);
        let _ = ctx.run(egui::RawInput::default(), |_| {}); // the fonts load with the first frame
        let font = font(16.0);
        for (i, icon) in ALL.iter().enumerate() {
            assert!(ctx.fonts(|f| f.has_glyphs(&font, icon)), "{icon:?} has no glyph");
            assert!(!ALL[..i].contains(icon), "{icon:?} is used for two things");
        }
    }
}
