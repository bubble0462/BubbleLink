//! 设置持久化：`%APPDATA%/com.bubblelink.studio/settings.json`，顶层键浅合并。

use serde_json::Value;
use tauri::{AppHandle, Manager};

fn config_file(app: &AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    dir.join("settings.json")
}

pub fn load(app: &AppHandle) -> Value {
    std::fs::read_to_string(config_file(app))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Value::Object(Default::default()))
}

pub fn save(app: &AppHandle, patch: Value) -> Result<(), String> {
    let mut merged = load(app);
    if let (Value::Object(base), Value::Object(patch)) = (&mut merged, patch) {
        for (k, v) in patch {
            base.insert(k, v);
        }
        let text = serde_json::to_string_pretty(&merged).map_err(|e| e.to_string())?;
        std::fs::write(config_file(app), text).map_err(|e| e.to_string())?;
        Ok(())
    } else {
        Err("设置必须是 JSON 对象".into())
    }
}
