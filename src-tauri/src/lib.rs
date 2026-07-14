mod commands;
mod config;
mod docker;

use std::sync::Arc;

use commands::bridge_supervisor::BridgeSupervisor;
use tauri::{
    image::Image,
    include_image,
    menu::{Menu, MenuItem},
    tray::{TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_deep_link::DeepLinkExt;

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

/// Phase 55.3.0 — start the bridge `systemctl --user` service.
#[tauri::command]
fn bridge_start(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<Arc<BridgeSupervisor>>().start()
}

/// Phase 55.3.0 — restart the bridge service (after env edits or pairing).
/// Tray menu wires "Restart bridge" to this.
#[tauri::command]
fn bridge_restart(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<Arc<BridgeSupervisor>>().restart()
}

/// Phase 55.3.0 — stop the bridge service from the React UI.
#[tauri::command]
fn bridge_stop(app: tauri::AppHandle) -> Result<(), String> {
    app.state::<Arc<BridgeSupervisor>>().stop();
    Ok(())
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
            // Phase 55.3.0 — forward `agentcontrol-tray://pair?…` deep links
            // from the operator portal into the onboarding flow, and
            // `agentcontrol-tray://auth-callback#…` magic-link tokens into auth.
            #[cfg(desktop)]
            let _ = app.deep_link().register_all();
            let handle = app.handle().clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    commands::pair::emit_pair_tokens(&handle, &url);
                    commands::pair::emit_auth_tokens(&handle, &url);
                }
            });

            // Phase 55.3.0 — the bridge runs as a systemctl --user service
            // (WSL on Windows, native on Linux). Ask it to start on tray
            // boot; idempotent + non-fatal. Failures (e.g. WSL/onboarding
            // not done yet) surface in the menu and the onboarding flow.
            // The supervisor is shared as managed state so React + menu
            // handlers can both query / restart.
            let supervisor: Arc<BridgeSupervisor> = Arc::new(BridgeSupervisor::new());
            app.manage(supervisor.clone());
            // `start()` shells out to `wsl systemctl --user start`, which on a
            // cold WSL distro can block 20-30s on first launch. Running it
            // inline here would stall the setup callback and delay the whole
            // webview init → black screen. Spawn it off the main thread so
            // setup() returns immediately and the webview boots in parallel.
            let start_supervisor = supervisor.clone();
            tauri::async_runtime::spawn(async move {
                match tauri::async_runtime::spawn_blocking(move || start_supervisor.start()).await {
                    Ok(Ok(())) => eprintln!("[tray] bridge service started"),
                    Ok(Err(err)) => eprintln!("[tray] bridge service start failed: {err}"),
                    Err(err) => eprintln!("[tray] bridge start task panicked: {err}"),
                }
            });

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
                        match supervisor.restart() {
                            Ok(()) => eprintln!("[tray] bridge service restarted"),
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
            bridge_start,
            bridge_restart,
            bridge_stop,
            docker::docker_available,
            docker::docker_compose,
            commands::wsl::detect_wsl,
            commands::wsl::install_wsl,
            commands::ubuntu::detect_ubuntu,
            commands::ubuntu::install_ubuntu,
            commands::shell::run_in_wsl,
            commands::deps::apt_install_deps,
            commands::deps::install_node22,
            commands::deps::install_claude_cli,
            commands::git_cfg::configure_git,
            commands::git_cfg::read_git_config,
            commands::bridge::download_bridge,
            commands::bridge::npm_install_bridge,
            commands::bridge::npm_run_build_bridge,
            commands::bridge::wait_for_claim_code,
            commands::bridge::bridge_pair_state,
            commands::api_key::generate_api_key,
            commands::api_key::write_env_file,
            commands::oauth::open_claude_oauth,
            commands::oauth::poll_claude_creds,
            commands::pair::open_operator_portal,
            commands::pair::write_pair_env,
            commands::pair::push_pair_to_bridge,
            commands::system::get_machine_label,
            commands::systemd::install_systemd_service,
            commands::systemd::restart_bridge_service,
        ])
        // Phase 55.3.0 — the bridge is now a systemctl --user service that
        // outlives the tray (Tailscale pattern). Quitting the tray must NOT
        // stop the bridge, so there is no longer a kill-on-exit hook.
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
