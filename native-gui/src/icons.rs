//! The app's icons, named by what they mean: Phosphor glyphs (egui-phosphor, MIT), drawn as text in any
//! proportional font, which falls back to Phosphor for them. One glyph means one thing everywhere (#276).
#![cfg_attr(not(test), allow(dead_code, reason = "a vocabulary: each screen takes the names it needs"))]

use egui_phosphor::regular as ph;

// Sections
pub const HOME: &str = ph::HOUSE;
/// The Shared section, with Proton's chain for it
pub const SHARED: &str = ph::LINK;
pub const ACTIVITY: &str = ph::CLOCK_COUNTER_CLOCKWISE;
pub const SETTINGS: &str = ph::GEAR;

// Actions
/// Open in Files, Show in Files
pub const FOLDER_OPEN: &str = ph::FOLDER_OPEN;
pub const TRASH: &str = ph::TRASH;
/// Sync now: send and fetch what changed
pub const SYNC: &str = ph::ARROWS_CLOCKWISE;
/// Load a list again
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
pub const INFO: &str = ph::INFO;
pub const FOLDER: &str = ph::FOLDER;
pub const FILE: &str = ph::FILE;

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [&str; 26] = [
        HOME, SHARED, ACTIVITY, SETTINGS, FOLDER_OPEN, TRASH, SYNC, PAUSE, RESUME, CHECK, WARNING, OFFLINE, LINK,
        LINK_BROKEN, LOCK, CLOCK, PEOPLE, COPY, MANAGE, WEB, REFRESH, SEARCH, INFO, SIGN_OUT, FOLDER, FILE,
    ];

    #[test]
    fn each_icon_is_drawn_from_the_icon_font_and_means_one_thing() {
        let ctx = egui::Context::default();
        crate::configure_proton_theme(&ctx);
        let _ = ctx.run(egui::RawInput::default(), |_| {}); // the fonts load with the first frame
        let font = egui::FontId::proportional(16.0);
        for (i, icon) in ALL.iter().enumerate() {
            assert!(ctx.fonts(|f| f.has_glyphs(&font, icon)), "{icon:?} has no glyph");
            assert!(!ALL[..i].contains(icon), "{icon:?} is used for two things");
        }
    }
}
