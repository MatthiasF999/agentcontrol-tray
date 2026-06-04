mod bridge_supervisor;
mod docker;

use std::sync::Arc;

use bridge_supervisor::BridgeSupervisor;
use tauri::{
    image::Image,
    include_image,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, RunEvent, WindowEvent,
};

const TRAY_ID: &str = "agentcontrol-main";

fn icon_for(state: &str) -> Image<'static> {
    match state {
        "running" => include_image!("icons/status-green-32.png"),
        "claimed" | "stopped" => include_image!("icons/status-yellow-32.png"),
        _ => include_image!("icons/status-red-32.png"),
    }
}

/// Show + focus the main window, optionally deep-linking to a route.
/// Add-24 — invoked from the OS-notification `onAction` bridge: when a
/// notification carries `extra.route`, the JS side calls this with that
/// route so focus + navigation happen atomically. The `navigate` event
/// is consumed by the React router (see src/lib/navigation.ts).
#[tauri::command]
fn show_main_window(app: tauri::AppHandle, route: Option<String>) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
    }
    if let Some(route) = route {
        app.emit("navigate", route).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn update_tray_status(
    app: tauri::AppHandle,
    state: String,
    tooltip: String,
) -> Result<(), String> {
    let tray = app
        .tray_by_id(TRAY_ID)
        .ok_or_else(|| "tray not found".to_string())?;
    tray.set_icon(Some(icon_for(&state))).map_err(|e| e.to_string())?;
    tray.set_tooltip(Some(tooltip)).map_err(|e| e.to_string())?;
    Ok(())
}

/// Phase 39.11 — let the React UI inspect bridge supervisor state.
/// Returns ("running" | "stopped", optional last-error message).
#[tauri::command]
fn bridge_status(app: tauri::AppHandle) -> Result<(String, Option<String>), String> {
    let supervisor = app.state::<Arc<BridgeSupervisor>>();
    if supervisor.is_running() {
        Ok(("running".to_string(), None))
    } else {
        Ok(("stopped".to_string(), None))
    }
}

/// Phase 39.11 — restart the bridge child (after env edits or Node
/// install). Tray menu wires "Restart bridge" to this.
#[tauri::command]
fn bridge_restart(app: tauri::AppHandle) -> Result<u32, String> {
    let supervisor = app.state::<Arc<BridgeSupervisor>>();
    supervisor.kill();
    supervisor.spawn(&app)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }));
    }

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_updater::Builder::new().build());
    }

    builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_deep_link::init())
        .setup(|app| {
            // Phase 39.11 — bring up the bridge child as soon as the
            // tray boots. Failures are non-fatal: we surface them in
            // the menu so the user can install Node + retry. The
            // supervisor is shared as managed state so React + menu
            // handlers can both query / restart.
            let supervisor: Arc<BridgeSupervisor> = Arc::new(BridgeSupervisor::new());
            app.manage(supervisor.clone());
            match supervisor.spawn(&app.handle()) {
                Ok(pid) => {
                    eprintln!("[tray] bridge spawned pid={pid}");
                }
                Err(err) => {
                    eprintln!("[tray] bridge spawn failed: {err}");
                }
            }

            let show_item = MenuItem::with_id(app, "show", "Open AgentControl", true, None::<&str>)?;
            let restart_item =
                MenuItem::with_id(app, "restart_bridge", "Restart bridge", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &restart_item, &quit_item])?;

            let _tray = TrayIconBuilder::with_id(TRAY_ID)
                .icon(include_image!("icons/status-red-32.png"))
                .tooltip("AgentControl — Bridge not paired")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        if let Some(win) = app.get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                    "restart_bridge" => {
                        let supervisor = app.state::<Arc<BridgeSupervisor>>();
                        supervisor.kill();
                        match supervisor.spawn(app) {
                            Ok(pid) => eprintln!("[tray] bridge restarted pid={pid}"),
                            Err(err) => eprintln!("[tray] bridge restart failed: {err}"),
                        }
                    }
                    "quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { .. } = event {
                        if let Some(win) = tray.app_handle().get_webview_window("main") {
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                })
                .build(app)?;

            if let Some(win) = app.get_webview_window("main") {
                let win_clone = win.clone();
                win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = win_clone.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_main_window,
            update_tray_status,
            bridge_status,
            bridge_restart,
            docker::docker_available,
            docker::docker_compose,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        // Phase 39.11 — clean shutdown of the bridge child on app
        // exit. `.run` + `on_run_event` give us a hook into the event
        // loop so we kill the supervisor before the process tears down.
        .run(|app_handle, event| {
            if let RunEvent::ExitRequested { .. } | RunEvent::Exit = event {
                let supervisor = app_handle.state::<Arc<BridgeSupervisor>>();
                supervisor.kill();
            }
        });
}
