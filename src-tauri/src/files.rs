//! 前端请求的通用文件写入（如导出日志）。

pub fn write_text_file(path: &str, content: &str) -> Result<(), String> {
    std::fs::write(path, content).map_err(|e| format!("写入文件失败：{e}"))
}
