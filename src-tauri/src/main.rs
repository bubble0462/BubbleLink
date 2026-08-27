//! BubbleLink Studio 主进程：窗口与命令注册。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod files;
mod flasher;
mod hexio;
mod serialsrv;
mod settings;

use flasher::FlashState;
use serialsrv::AppState;

#[tauri::command]
fn cmd_write_text_file(path: String, content: String) -> Result<(), String> {
    files::write_text_file(&path, &content)
}

// ---- 串口 ----

#[tauri::command]
fn cmd_list_ports() -> Result<Vec<serialsrv::PortEntry>, String> {
    serialsrv::list_ports_detail().map_err(|e| e.to_string())
}

#[tauri::command]
fn cmd_open_port(
    app: tauri::AppHandle,
    state: tauri::State<AppState>,
    name: String,
    baud: u32,
    gap_ms: u64,
) -> Result<serde_json::Value, String> {
    serialsrv::open_port(&app, &state, &name, baud, gap_ms)
}

#[tauri::command]
fn cmd_close_port(state: tauri::State<AppState>) {
    serialsrv::close_port(&state);
}

#[tauri::command]
fn cmd_send(state: tauri::State<AppState>, data: Vec<u8>) -> Result<usize, String> {
    serialsrv::send_bytes(&state, &data)
}

#[tauri::command]
fn cmd_set_pins(state: tauri::State<AppState>, dtr: bool, rts: bool) -> Result<(), String> {
    serialsrv::set_pins(&state, dtr, rts)
}

#[tauri::command]
fn cmd_start_capture(state: tauri::State<AppState>, path: String) -> Result<(), String> {
    serialsrv::start_capture(&state, &path)
}

#[tauri::command]
fn cmd_stop_capture(state: tauri::State<AppState>) -> Result<u64, String> {
    serialsrv::stop_capture(&state).map_err(|e| e.to_string())
}

// ---- 烧录 ----

/// 当前在线的三模烧录器（基于串口 CDC + HID 活跃实例双源判定）。
#[tauri::command]
fn cmd_identify_probes() -> Vec<flasher::ProbeDevice> {
    let ports = serialport::available_ports().unwrap_or_default();
    flasher::identify_probes(&ports)
}

/// pyOCD 引擎自检。
#[tauri::command]
fn cmd_pyocd_check() -> Result<String, String> {
    flasher::pyocd_version()
}

/// STM32CubeProgrammer CLI 引擎自检。
#[tauri::command]
fn cmd_stm32cli_check() -> Result<String, String> {
    flasher::stm32cli_version()
}

/// 固件文件元信息（地址范围 / CRC32 / 大小）。
#[tauri::command]
fn cmd_firmware_meta(path: String) -> flasher::FirmwareMeta {
    flasher::firmware_meta(&path)
}

/// 启动烧录（pyOCD 引擎）。
#[tauri::command]
fn cmd_flash_start(
    app: tauri::AppHandle,
    state: tauri::State<FlashState>,
    args: flasher::FlashArgs,
) -> Result<(), String> {
    flasher::start_flash(&app, &state, args)
}

/// 取消当前烧录任务。
#[tauri::command]
fn cmd_flash_cancel(state: tauri::State<FlashState>) {
    flasher::cancel_flash(&state);
}

/// 目标芯片自动识别（读 DBGMCU_IDCODE + Flash 容量）。
#[tauri::command]
fn cmd_probe_target() -> flasher::TargetInfo {
    flasher::probe_target()
}

// ---- 设置 ----

#[tauri::command]
fn cmd_settings_get(app: tauri::AppHandle) -> serde_json::Value {
    settings::load(&app)
}

#[tauri::command]
fn cmd_settings_save(app: tauri::AppHandle, value: serde_json::Value) -> Result<(), String> {
    settings::save(&app, value)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::new())
        .manage(FlashState::new())
        .invoke_handler(tauri::generate_handler![
            cmd_write_text_file,
            cmd_list_ports,
            cmd_open_port,
            cmd_close_port,
            cmd_send,
            cmd_set_pins,
            cmd_start_capture,
            cmd_stop_capture,
            cmd_identify_probes,
            cmd_pyocd_check,
            cmd_stm32cli_check,
            cmd_firmware_meta,
            cmd_flash_start,
            cmd_flash_cancel,
            cmd_probe_target,
            cmd_settings_get,
            cmd_settings_save,
        ])
        .run(tauri::generate_context!())
        .expect("BubbleLink Studio 启动失败");
}
