//! Settings' own cards: the account (who is signed in, their plan and storage, Sign out), and what is hidden from this
//! computer, with Unhide.

use eframe::egui::{self, Align, Color32, CornerRadius, FontFamily, FontId, Frame, Layout, Margin, RichText, Sense, Vec2};

use crate::home::{
    elided, open_in_browser, primary_button, secondary_button, storage, trash_hover, OPEN_TRASH, PROTON_DRIVE_TRASH_URL,
    PROTON_DRIVE_WEB_URL,
};
use crate::{
    card_frame, is_light_mode, ProtonDriveNativeApp, WorkerCommand, BG_CARD_ALT, HIDDEN_NEEDS_RESTART, PROTON_PURPLE_TEXT,
    STATUS_DANGER, TEXT_MUTED, TEXT_PRIMARY,
};

/// The plan, as the account's quota tells it.
pub fn plan_name(max_space: u64) -> &'static str {
    const GB: u64 = 1024 * 1024 * 1024;
    if max_space >= 400 * GB {
        "Proton Unlimited"
    } else if max_space >= 15 * GB {
        "Proton Drive Plus"
    } else {
        "Proton Free"
    }
}

impl ProtonDriveNativeApp {
    /// Account: the initials, name and email, the plan, the storage used, and Sign out (Sign in while signed out).
    pub(crate) fn render_account_card(&mut self, ui: &mut egui::Ui) {
        let account = self.status.account.clone();
        let (name, email, initials) = match &account {
            Some(a) => (
                if a.display_name.is_empty() { "Proton Account".to_string() } else { a.display_name.clone() },
                a.email.clone(),
                if a.initials.is_empty() { "PD".to_string() } else { a.initials.clone() },
            ),
            None if self.status.logged_in => ("Proton Account".to_string(), String::new(), "PD".to_string()),
            None => ("Not signed in".to_string(), String::new(), "PD".to_string()),
        };
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(RichText::new("Account").size(16.0).strong().color(TEXT_PRIMARY()));
            ui.add_space(12.0);
            ui.horizontal(|ui| {
                let (avatar, _) = ui.allocate_exact_size(Vec2::new(44.0, 44.0), Sense::hover());
                let fill = if is_light_mode() { Color32::from_rgb(235, 229, 255) } else { Color32::from_rgb(50, 41, 82) };
                ui.painter().rect_filled(avatar, CornerRadius::same(10), fill);
                ui.painter().text(
                    avatar.center(),
                    egui::Align2::CENTER_CENTER,
                    &initials,
                    FontId::new(16.0, FontFamily::Proportional),
                    TEXT_PRIMARY(),
                );
                ui.add_space(6.0);
                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                    if self.status.logged_in {
                        if secondary_button(ui, "Sign out", 32.0).clicked() {
                            self.send_account_command(WorkerCommand::Logout);
                        }
                    } else if primary_button(ui, "Sign in", 32.0).clicked() {
                        self.send_account_command(WorkerCommand::StartLogin);
                    }
                    ui.add_space(8.0);
                    ui.with_layout(Layout::top_down(Align::Min), |ui| {
                        ui.horizontal(|ui| {
                            elided(ui, RichText::new(&name).size(14.5).strong().color(TEXT_PRIMARY()), &name);
                            if let Some(a) = account.as_ref().filter(|a| a.max_space > 0) {
                                ui.add_space(4.0);
                                plan_pill(ui, plan_name(a.max_space));
                            }
                        });
                        if !email.is_empty() {
                            elided(ui, RichText::new(&email).size(12.5).color(TEXT_MUTED()), &email);
                        }
                    });
                });
            });
            if let Some(s) = storage(account.as_ref()) {
                ui.add_space(12.0);
                ui.separator();
                ui.add_space(10.0);
                ui.horizontal(|ui| {
                    ui.label(RichText::new("Proton storage").size(13.0).color(TEXT_PRIMARY()));
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(RichText::new(&s.text).size(13.0).strong().color(TEXT_PRIMARY()));
                    });
                });
            }
            // Proton Drive on the web, and its trash, where a delete through the drive puts what was deleted (#201).
            // Signed in only: signed out, Sign in is the one thing to do
            if self.status.logged_in {
                ui.add_space(12.0);
                ui.horizontal(|ui| {
                    if secondary_button(ui, "Open Proton Drive on the web", 30.0).clicked() {
                        open_in_browser(PROTON_DRIVE_WEB_URL);
                    }
                    ui.add_space(8.0);
                    if secondary_button(ui, OPEN_TRASH, 30.0).on_hover_text(trash_hover(&self.status.sync_dir)).clicked() {
                        open_in_browser(PROTON_DRIVE_TRASH_URL);
                    }
                });
            }
            // How signing in or out went (the sign-in page opening, or why it failed)
            if let Some(error) = &self.account_error {
                ui.add_space(8.0);
                ui.add(egui::Label::new(RichText::new(error).size(12.5).color(STATUS_DANGER)).wrap());
            } else if let Some(url) = &self.login_url {
                let text = if url.is_empty() {
                    "Opening the Proton sign-in page in your browser…".to_string()
                } else {
                    format!("Sign-in URL opened in browser: {url}")
                };
                ui.add_space(8.0);
                ui.add(egui::Label::new(RichText::new(text).size(12.0).color(PROTON_PURPLE_TEXT())).wrap());
            }
        });
    }

    /// Hidden from this computer: each hidden item with Unhide (POST /availability, as the browser sent it).
    pub(crate) fn render_hidden_card(&mut self, ui: &mut egui::Ui) {
        let mut unhide: Option<String> = None;
        card_frame().show(ui, |ui| {
            ui.set_min_width(ui.available_width());
            ui.label(RichText::new("Hidden from this computer").size(16.0).strong().color(TEXT_PRIMARY()));
            ui.add_space(4.0);
            ui.add(
                egui::Label::new(
                    RichText::new("Hidden items stay in Proton Drive, but aren't kept on this computer or shown in Files. To hide something, right-click it in Files.")
                        .size(12.0)
                        .color(TEXT_MUTED()),
                )
                .wrap(),
            );
            ui.add_space(10.0);
            match &self.hidden {
                None => {
                    ui.label(RichText::new("Loading…").size(13.0).color(TEXT_MUTED()));
                }
                // An older daemon, without the list: not an error, a restart brings it
                Some(Err(e)) if e == HIDDEN_NEEDS_RESTART => {
                    ui.add(egui::Label::new(RichText::new(e).size(12.5).color(TEXT_MUTED())).wrap());
                }
                Some(Err(e)) => {
                    ui.add(
                        egui::Label::new(RichText::new(format!("Couldn't load the list: {e}")).size(12.5).color(STATUS_DANGER))
                            .wrap(),
                    );
                }
                Some(Ok(items)) if items.is_empty() => {
                    ui.label(RichText::new("Nothing is hidden.").size(13.0).color(TEXT_MUTED()));
                }
                Some(Ok(items)) => {
                    // One action at a time, and only with the daemon there to do it
                    let can = self.daemon_online && self.working.is_empty();
                    for item in items {
                        Frame::NONE
                            .fill(BG_CARD_ALT())
                            .corner_radius(CornerRadius::same(8))
                            .inner_margin(Margin::symmetric(12, 6))
                            .show(ui, |ui| {
                                ui.set_min_width(ui.available_width());
                                ui.horizontal(|ui| {
                                    ui.set_min_height(30.0);
                                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                        let label = if self.working.contains(&item.path) { "Unhiding…" } else { "Unhide" };
                                        if ui.add_enabled_ui(can, |ui| secondary_button(ui, label, 30.0)).inner.clicked() {
                                            unhide = Some(item.path.clone());
                                        }
                                        if item.state == "hiding" {
                                            ui.add_space(8.0);
                                            ui.label(RichText::new("Hiding…").size(12.5).color(TEXT_MUTED()));
                                        }
                                        ui.add_space(8.0);
                                        ui.with_layout(Layout::left_to_right(Align::Center), |ui| {
                                            elided(ui, RichText::new(&item.path).size(13.5).color(TEXT_PRIMARY()), &item.path);
                                        });
                                    });
                                });
                            });
                        ui.add_space(6.0);
                    }
                }
            }
            // How the last Unhide went: the items it had to keep as information, a refusal or failure as an error
            if let Some(notice) = &self.unhide_notice {
                ui.add_space(6.0);
                let color = if notice.error { STATUS_DANGER } else { TEXT_MUTED() };
                ui.add(egui::Label::new(RichText::new(&notice.text).size(12.5).color(color)).wrap());
            }
        });
        if let Some(path) = unhide {
            self.unhide_notice = None;
            self.unhiding = Some(path.clone());
            self.send_availability(path, "unhide");
        }
    }
}

/// The plan, in a small pill beside the name.
fn plan_pill(ui: &mut egui::Ui, plan: &str) {
    Frame::NONE
        .fill(crate::PROTON_PURPLE_SOFT())
        .corner_radius(CornerRadius::same(5))
        .inner_margin(Margin::symmetric(7, 2))
        .show(ui, |ui| {
            ui.label(RichText::new(plan).size(11.0).color(PROTON_PURPLE_TEXT()));
        });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_plan_is_named_by_the_accounts_quota() {
        const GB: u64 = 1024 * 1024 * 1024;
        assert_eq!(plan_name(5 * GB), "Proton Free");
        assert_eq!(plan_name(15 * GB - 1), "Proton Free");
        assert_eq!(plan_name(15 * GB), "Proton Drive Plus");
        assert_eq!(plan_name(200 * GB), "Proton Drive Plus");
        assert_eq!(plan_name(400 * GB), "Proton Unlimited");
        assert_eq!(plan_name(510 * GB), "Proton Unlimited");
    }
}
