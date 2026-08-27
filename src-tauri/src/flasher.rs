//! 烧录引擎：
//! ① 三模烧录器识别（presence 双源判定：串口枚举 CDC 部分 + HID 服务活跃实例）
//! ② pyOCD 子进程烧录调度（进度解析 / 取消 / 日志透传）

use std::collections::HashMap;
use std::io::{BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

// ---------------------------------------------------------------------------
// 设备识别
// ---------------------------------------------------------------------------

/// ST-Link 家族 PID（TN1235）：V2=3748，V2-1=374A/374B/374D/3752，
/// V3=374C/374E/374F/3753(带 bridge)/3754(无 bridge)/3757(V3PWR)
const STLINK_PIDS: &[u16] = &[
    0x3748, 0x374A, 0x374B, 0x374C, 0x374D, 0x374E, 0x374F, 0x3752, 0x3753, 0x3754, 0x3757,
];
/// DAPLink/mbed：0204 标准 CMSIS-DAP，0203 旧版 mbed 复合设备
const DAPLINK_PIDS: &[u16] = &[0x0204, 0x0203];
const BMP_PIDS: &[u16] = &[0x6018];

struct ProbeKindDef {
    kind: &'static str,
    label: &'static str,
    vid: u16,
    pids: &'static [u16],
}

const KINDS: &[ProbeKindDef] = &[
    ProbeKindDef { kind: "stlink", label: "00 · ST-Link", vid: 0x0483, pids: STLINK_PIDS },
    ProbeKindDef { kind: "daplink", label: "01 · DAPLink", vid: 0x0d28, pids: DAPLINK_PIDS },
    ProbeKindDef { kind: "bmp", label: "10 · BMP", vid: 0x1d50, pids: BMP_PIDS },
];

#[derive(Serialize, Clone)]
pub struct ProbeDevice {
    /// "stlink" | "daplink" | "bmp"
    pub kind: String,
    /// 展示名（含模式编码）
    pub label: String,
    /// 序列号或友好描述
    pub hint: String,
    pub count: usize,
}

/// "COM3" 之类的回退名（CDC 没有序列号时用端口名顶替）。
fn is_com_name(h: &str) -> bool {
    h.len() <= 5 && h.starts_with("COM") && h[3..].bytes().all(|b| b.is_ascii_digit())
}

/// HID 实例路径（`...\USB\VID_x&PID_y\SN`）的尾段即父设备序列号。
fn hid_instance_serial(path: &str) -> &str {
    path.rsplit(['\\', '/']).next().unwrap_or("").trim()
}

/// 汇总当前在线的三模烧录器。
///
/// 来源优先级：
/// ① PnP 在线 USB 设备接口（cfgmgr32，见 usbenum.rs）——主来源，
///    覆盖经典 ST-Link/V2 这类无 CDC/HID 接口的设备；每台设备恰好一个
///    USB_DEVICE 接口，条目数即设备数。
/// ② CDC 串口 / HID 活跃实例——PnP 不可用时兜底计数，并补充真实序列号。
pub fn identify_probes(com_ports: &[serialport::SerialPortInfo]) -> Vec<ProbeDevice> {
    let usb = crate::usbenum::present_usb_devices();
    let mut cdc: HashMap<(u16, u16), Vec<String>> = HashMap::new();
    for info in com_ports {
        if let serialport::SerialPortType::UsbPort(u) = &info.port_type {
            cdc.entry((u.vid, u.pid)).or_default().push(
                u.serial_number.clone().unwrap_or_else(|| info.port_name.clone()),
            );
        }
    }
    let hid = hid_active_instances();

    KINDS
        .iter()
        .filter_map(|k| {
            let mut hint: Option<String> = None;
            let mut count = 0usize;
            let mut found = false;
            for &pid in k.pids {
                let key = (k.vid, pid);
                // ① PnP 在线接口
                let sns: Vec<&str> = usb
                    .iter()
                    .filter(|(v, p, _)| (*v, *p) == key)
                    .map(|(_, _, s)| s.as_str())
                    .collect();
                if !sns.is_empty() {
                    found = true;
                    count += sns.len();
                    hint = hint.or_else(|| best_serial(&sns));
                }
                // ② CDC：兜底计数 + 真实序列号优先
                let cdc_ports = cdc.get(&key);
                if let Some(ports) = cdc_ports {
                    found = true;
                    if sns.is_empty() {
                        count += ports.len();
                    }
                    hint = hint
                        .or_else(|| ports.iter().find(|h| !is_com_name(h)).cloned());
                }
                // ② HID：兜底计数（接口数 ≥ 设备数，按父序列号去重近似）
                if let Some(insts) = hid.get(&key) {
                    let hsns: Vec<&str> =
                        insts.iter().map(|p| hid_instance_serial(p)).collect();
                    if sns.is_empty() && cdc_ports.is_none() && !hsns.is_empty() {
                        found = true;
                        let mut uniq = hsns.clone();
                        uniq.sort_unstable();
                        uniq.dedup();
                        count += uniq.len().max(1);
                    }
                    hint = hint.or_else(|| best_serial(&hsns));
                }
            }
            if !found {
                return None;
            }
            Some(ProbeDevice {
                kind: k.kind.to_string(),
                label: k.label.to_string(),
                hint: hint.unwrap_or_default(),
                count: count.max(1),
            })
        })
        .collect()
}

/// 挑选可展示的序列号：跳过 Windows 生成的父实例 ID（含 '&'）。
fn best_serial(sns: &[&str]) -> Option<String> {
    sns.iter()
        .find(|s| !s.is_empty() && !s.contains('&'))
        .map(|s| s.to_string())
}

/// HKLM\SYSTEM\CurrentControlSet\Services\hidserv\Enum 中记录了**正在运行**的
/// HID 设备实例，是可靠的存在性信号（无幻影残留）。
#[cfg(windows)]
fn hid_active_instances() -> HashMap<(u16, u16), Vec<String>> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let mut out = HashMap::new();
    let hk = RegKey::predef(HKEY_LOCAL_MACHINE);
    let Ok(root) =
        hk.open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Services\hidserv\Enum", KEY_READ)
    else {
        return out;
    };
    for (val_name, _) in root.enum_values().flatten() {
        let Ok::<String, _>(path) = root.get_value(&val_name) else { continue };
        let lower = path.to_lowercase();
        // 形如 \hid\vid_0d28&pid_0204&mi_01\8&abcdef&0&0000 —— 用 get() 切片，
        // 异常短路径只会解析失败而不会越界 panic
        let Some(vid_pos) = lower.find("vid_") else { continue };
        let Some(pid_rel) = lower[vid_pos..].find("&pid_") else { continue };
        let pid_abs = vid_pos + pid_rel + 5;
        let vid = lower
            .get(vid_pos + 4..vid_pos + 8)
            .and_then(|s| u16::from_str_radix(s, 16).ok());
        let rest = &lower[pid_abs..];
        let pid_end = rest.find(|c: char| !c.is_ascii_hexdigit()).unwrap_or(rest.len());
        let pid = rest.get(..pid_end).and_then(|s| u16::from_str_radix(s, 16).ok());
        let (Some(vid), Some(pid)) = (vid, pid) else { continue };
        out.entry((vid, pid)).or_insert_with(Vec::new).push(path);
    }
    out
}

#[cfg(not(windows))]
fn hid_active_instances() -> HashMap<(u16, u16), Vec<String>> {
    HashMap::new()
}

// ---------------------------------------------------------------------------
// pyOCD 可执行文件定位与自检
// ---------------------------------------------------------------------------

fn locate_pyocd() -> Option<PathBuf> {
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let cand = dir.join(if cfg!(windows) { "pyocd.exe" } else { "pyocd" });
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    if cfg!(windows) {
        let mut extra: Vec<PathBuf> = Vec::new();
        for var in ["LOCALAPPDATA", "APPDATA"] {
            if let Ok(base) = std::env::var(var) {
                for v in ["313", "312", "311"] {
                    extra.push(PathBuf::from(&base)
                        .join(r"Programs\Python")
                        .join(format!("Python{v}"))
                        .join("Scripts")
                        .join("pyocd.exe"));
                }
                extra.push(PathBuf::from(&base).join(r"Python\Scripts\pyocd.exe"));
            }
        }
        if let Ok(pf) = std::env::var("ProgramFiles") {
            for v in ["313", "312", "311"] {
                extra.push(PathBuf::from(&pf).join(format!("Python{v}\\Scripts\\pyocd.exe")));
            }
        }
        extra.into_iter().find(|p| p.exists())
    } else {
        None
    }
}

fn pyocd_binary() -> Result<PathBuf, String> {
    locate_pyocd()
        .ok_or_else(|| "未找到 pyOCD：请在本机命令行执行一次 `pip install pyocd` 后重试".to_string())
}

/// 引擎自检：能否调用 pyOCD 及其版本号。
pub fn pyocd_version() -> Result<String, String> {
    let exe = pyocd_binary()?;
    let mut cmd = Command::new(&exe);
    cmd.arg("--version");
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW，避免闪黑框
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// ----- STM32CubeProgrammer CLI（ST-Link 引擎） -----

fn locate_stm32cli() -> Option<PathBuf> {
    const NAME: &str = if cfg!(windows) { "STM32_Programmer_CLI.exe" } else { "STM32_Programmer_CLI" };
    if let Ok(custom) = std::env::var("STM32CUBE_PROGRAMMER_PATH") {
        let base = PathBuf::from(custom);
        let p = base.join("bin").join(NAME);
        if p.exists() {
            return Some(p);
        }
        let p = base.join(NAME);
        if p.exists() {
            return Some(p);
        }
    }
    if let Ok(path_env) = std::env::var("PATH") {
        for dir in std::env::split_paths(&path_env) {
            let cand = dir.join(NAME);
            if cand.exists() {
                return Some(cand);
            }
        }
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Ok(pf) = std::env::var("ProgramFiles") {
        roots.push(PathBuf::from(&pf).join(r"STMicroelectronics\STM32Cube\STM32CubeProgrammer\bin"));
    }
    if let Ok(pf86) = std::env::var("ProgramFiles(x86)") {
        roots.push(PathBuf::from(pf86).join(r"STMicroelectronics\STM32Cube\STM32CubeProgrammer\bin"));
    }
    if let Ok(ld) = std::env::var("LOCALAPPDATA") {
        roots.push(PathBuf::from(ld).join(r"Programs\STM32Cube\STM32CubeProgrammer\bin"));
    }
    roots.into_iter().map(|d| d.join(NAME)).find(|p| p.exists())
}

fn stm32cli_binary() -> Result<PathBuf, String> {
    locate_stm32cli().ok_or_else(|| {
        "未找到 STM32CubeProgrammer：请安装后重试（或设置环境变量 STM32CUBE_PROGRAMMER_PATH）".to_string()
    })
}

/// 引擎自检：STM32CubeProgrammer CLI 版本。
pub fn stm32cli_version() -> Result<String, String> {
    let exe = stm32cli_binary()?;
    let mut cmd = Command::new(&exe);
    cmd.arg("--version");
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    let ver = text
        .lines()
        .map(str::trim)
        .find(|l| l.to_lowercase().contains("stm32cubeprogrammer v"))
        .unwrap_or("已安装");
    Ok(ver.to_string())
}

// ---------------------------------------------------------------------------
// 目标芯片自动识别（Cortex-M3 无 ROM 表型号信息，改读 F1 的 DBGMCU_IDCODE 与
// Flash 容量寄存器，推断密度/容量并给出具体型号推测）
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
pub struct TargetInfo {
    pub detected: bool,
    pub dev_id: Option<u32>,
    pub rev_id: Option<u32>,
    pub flash_kb: Option<u32>,
    pub density: String,
    pub guess: String,
    pub message: Option<String>,
}

pub fn probe_target() -> TargetInfo {
    match run_pyocd_reads() {
        Ok(out) => interpret_target(&out),
        Err(m) => TargetInfo {
            detected: false,
            dev_id: None,
            rev_id: None,
            flash_kb: None,
            density: "—".into(),
            guess: "—".into(),
            message: Some(m),
        },
    }
}

/// 只读识别，不干预目标运行状态：pyOCD commander 默认 connect_mode=attach
/// （连接不暂停内核）且 resume_on_disconnect=False（断开不恢复），因此这里
/// 不追加 `go`——识别前后目标程序照常运行，无任何副作用。
fn run_pyocd_reads() -> Result<String, String> {
    let exe = pyocd_binary()?;
    let mut command = Command::new(&exe);
    command.args([
        "commander",
        "--target",
        "cortex_m",
        "-f",
        "1000000",
        "-c",
        "read32 0xE0042000",
        "-c",
        "read32 0x1FFFF7E0",
    ]);
    command.stdout(Stdio::piped()).stderr(Stdio::piped()).stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|e| format!("启动 pyOCD 失败：{e}"))?;
    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");
    let t_out = std::thread::spawn(move || collect_output(stdout));
    let t_err = std::thread::spawn(move || collect_output(stderr));

    let deadline = Instant::now() + Duration::from_secs(9);
    let exit_status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() > deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = t_out.join();
                    let _ = t_err.join();
                    return Err("自动识别超时（检查 J_SWD 接线与目标板供电）".into());
                }
            }
            Err(e) => return Err(e.to_string()),
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let out = t_out.join().unwrap_or_default();
    let err = t_err.join().unwrap_or_default();
    // 识别失败时把 stderr 尾部带出来（pyOCD 的连接/目标错误大多打在 stderr）
    if !exit_status.success() {
        let tail = last_lines(&err, 3)
            .or_else(|| last_lines(&out, 3))
            .unwrap_or_else(|| "无错误输出".into());
        return Err(format!("pyOCD 识别失败：{tail}"));
    }
    Ok(out)
}

/// 取文本末尾最多 n 条非空行。
fn last_lines(text: &str, n: usize) -> Option<String> {
    let lines: Vec<&str> = text.lines().map(str::trim).filter(|l| !l.is_empty()).collect();
    if lines.is_empty() {
        None
    } else {
        Some(lines[lines.len().saturating_sub(n)..].join(" | "))
    }
}

fn collect_output<R: std::io::Read + Send + 'static>(r: R) -> String {
    let mut s = String::new();
    let _ = BufReader::new(r).read_to_string(&mut s);
    s
}

fn interpret_target(out: &str) -> TargetInfo {
    let none = TargetInfo {
        detected: false,
        dev_id: None,
        rev_id: None,
        flash_kb: None,
        density: "—".into(),
        guess: "—".into(),
        message: Some("未读到目标 ID（检查 J_SWD 接线与目标板供电）".into()),
    };
    let Some(id) = find_hex_after(out, "e0042000") else {
        return none;
    };
    let dev = id & 0xFFF;
    let rev = (id >> 16) & 0xFFFF;
    let flash_kb = find_hex_after(out, "1ffff7e0").map(|v| v & 0xFFFF);
    let (density, guess) = match (dev, flash_kb) {
        (0x414, Some(512)) => ("高密度", "stm32f103ve（高密度 · 512KB，推测）"),
        (0x414, Some(256)) => ("高密度", "stm32f103vc（高密度 · 256KB，推测）"),
        (0x414, Some(384)) => ("高密度", "stm32f103rc/rd（高密度 · 256~384KB，推测）"),
        (0x414, _) => ("高密度", "STM32F103 高密度（按容量选择型号）"),
        // RM0008：0x418 = 互联型（F105/F107），0x430 = 超大容量 XL（F103xF/xG）
        (0x418, _) => ("互联型", "STM32F105/F107（互联型，推测）"),
        (0x430, _) => ("超大容量 XL", "STM32F103 ZG/XG（超大容量 · 768KB~1MB，推测）"),
        (0x410, _) => ("中密度", "STM32F103 C8/RB（中密度，推测）"),
        (0x412, _) => ("低密度", "STM32F10x 低密度"),
        _ => ("未知", "未知型号（请手动选择）"),
    };
    TargetInfo {
        detected: true,
        dev_id: Some(dev),
        rev_id: Some(rev),
        flash_kb,
        density: density.into(),
        guess: guess.into(),
        message: None,
    }
}

/// 在命令输出中定位 `addr` 对应的读数（跳过 `>>> read32 …` 回显行与地址本身）。
fn find_hex_after(out: &str, addr: &str) -> Option<u32> {
    let lines: Vec<&str> = out.lines().collect();
    let mut found: Option<usize> = None;
    for (i, l) in lines.iter().enumerate() {
        if l.to_lowercase().contains(addr) {
            found = Some(i);
            break;
        }
    }
    let li = found?;
    for l in lines.iter().skip(li) {
        let lw = l.to_lowercase();
        if lw.contains("read32") || lw.contains(">>>") {
            continue;
        }
        if let Some(pos) = lw.find(addr) {
            if let Some(v) = first_hex8(&lw[pos + addr.len()..]) {
                return Some(v);
            }
            continue;
        }
        if let Some(v) = first_hex8(&lw) {
            return Some(v);
        }
    }
    None
}

/// 找到第一个独立的 8 位 HEX 数字（左右边界都不是 HEX 字符）。
fn first_hex8(s: &str) -> Option<u32> {
    let b = s.as_bytes();
    let mut i = 0;
    while i + 8 <= b.len() {
        if b[i..i + 8].iter().all(|c| c.is_ascii_hexdigit()) {
            let ok_left = i == 0 || !b[i - 1].is_ascii_hexdigit();
            let ok_right = i + 8 == b.len() || !b[i + 8].is_ascii_hexdigit();
            if ok_left && ok_right {
                return u32::from_str_radix(&s[i..i + 8], 16).ok();
            }
            i += 8;
        } else {
            i += 1;
        }
    }
    None
}

// ---------------------------------------------------------------------------
// 固件文件元信息
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct FirmwareMeta {
    pub kind: String, // "hex" | "bin" | "elf"
    pub size_bytes: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub crc32: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_addr: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_addr: Option<u32>,
    pub error: Option<String>,
}

pub fn firmware_meta(path: &str) -> FirmwareMeta {
    let lower = path.to_lowercase();
    let kind = if lower.ends_with(".hex") {
        "hex"
    } else if lower.ends_with(".bin") {
        "bin"
    } else {
        "elf"
    };
    let mut meta = FirmwareMeta {
        kind: kind.to_string(),
        size_bytes: 0,
        crc32: None,
        min_addr: None,
        max_addr: None,
        error: None,
    };
    let data = match std::fs::read(path) {
        Ok(d) => d,
        Err(e) => {
            meta.error = Some(e.to_string());
            return meta;
        }
    };
    meta.size_bytes = data.len() as u64;
    match kind {
        "hex" => {
            let text = String::from_utf8_lossy(&data);
            match crate::hexio::parse_ihex(&text) {
                Ok(info) => {
                    meta.crc32 = Some(info.crc32);
                    meta.min_addr = Some(info.min_addr);
                    meta.max_addr = Some(info.max_addr);
                }
                Err(e) => meta.error = Some(e),
            }
        }
        _ => {
            meta.crc32 = Some(crate::hexio::crc32(&data));
        }
    }
    meta
}

// ---------------------------------------------------------------------------
// 烧录任务
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, serde::Deserialize)]
pub struct FlashArgs {
    /// "pyocd"（DAPLink 模式）| "stm32cli"（ST-Link 模式）
    #[serde(default)]
    pub engine: String,
    pub target: String,
    pub file: String,
    /// "hex" | "bin" | "elf"
    pub format: String,
    /// bin 格式的基地址（可选）
    pub base_addr: Option<String>,
    pub chip_erase: bool,
    pub verify: bool,
}

/// 任务槽位：Drop 时杀子进程并置取消标志。
pub struct FlashSlot {
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

impl Drop for FlashSlot {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut g) = self.child.lock() {
            if let Some(c) = g.as_mut() {
                let _ = c.kill();
            }
            *g = None;
        }
    }
}

impl FlashSlot {
    fn busy(&self) -> bool {
        !self.cancel.load(Ordering::SeqCst)
    }
}

pub struct FlashState {
    pub job: Mutex<Option<FlashSlot>>,
}

impl FlashState {
    pub fn new() -> Self {
        Self { job: Mutex::new(None) }
    }

    fn clear(&self) {
        *self.job.lock().unwrap() = None;
    }
}

pub fn start_flash(app: &AppHandle, state: &FlashState, args: FlashArgs) -> Result<(), String> {
    let mut slot = state.job.lock().unwrap();
    if slot.as_ref().map(|j| j.busy()).unwrap_or(false) {
        return Err("已有烧录任务在进行中".into());
    }
    *slot = None; // 回收旧槽位

    let engine = if args.engine.is_empty() { "pyocd".to_string() } else { args.engine.clone() };
    let mut cmd_args: Vec<String> = Vec::new();

    if engine == "stm32cli" {
        // STM32CubeProgrammer CLI：芯片自动识别，无需 target
        cmd_args.push("-c".into());
        cmd_args.push("port=SWD".into());
        if args.chip_erase {
            cmd_args.push("-e".into());
            cmd_args.push("all".into());
        }
        cmd_args.push("-d".into());
        cmd_args.push(args.file.clone());
        if args.format == "bin" {
            if let Some(ba) = &args.base_addr {
                cmd_args.push(ba.clone());
            }
        }
        if args.verify {
            cmd_args.push("-v".into());
        }
        cmd_args.push("-g".into()); // 复位并运行
    } else {
        cmd_args.extend(["load".into(), "--target".into(), args.target.clone()]);
        match args.format.as_str() {
            "bin" => {
                cmd_args.push("--format".into());
                cmd_args.push("bin".into());
                if let Some(ba) = &args.base_addr {
                    cmd_args.push("--base-address".into());
                    cmd_args.push(ba.clone());
                }
            }
            f => {
                cmd_args.push("--format".into());
                cmd_args.push(f.to_string());
            }
        }
        if args.chip_erase {
            cmd_args.push("--chip-erase".into());
        }
        if !args.verify {
            cmd_args.push("--no-verify".into());
        }
        cmd_args.push(args.file.clone());
    }

    let exe = if engine == "stm32cli" { stm32cli_binary()? } else { pyocd_binary()? };

    let mut command = Command::new(&exe);
    command
        .args(&cmd_args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let mut child = command.spawn().map_err(|e| format!("启动 pyOCD 失败：{e}"))?;
    let stdout = child.stdout.take().expect("stdout");
    let stderr = child.stderr.take().expect("stderr");

    let cancel = Arc::new(AtomicBool::new(false));
    let child_arc = Arc::new(Mutex::new(Some(child)));

    let app2 = app.clone();
    let cancel2 = cancel.clone();
    let child2 = child_arc.clone();
    std::thread::spawn(move || {
        run_flash_job(app2, stdout, stderr, cancel2, child2);
    });

    *slot = Some(FlashSlot { cancel, child: child_arc });
    Ok(())
}

pub fn cancel_flash(state: &FlashState) {
    if let Some(job) = state.job.lock().unwrap().as_ref() {
        job.cancel.store(true, Ordering::SeqCst);
        if let Ok(mut g) = job.child.lock() {
            if let Some(c) = g.as_mut() {
                let _ = c.kill();
            }
        }
    }
}

// 输出行统一进队列（stdout/stderr 两读线程），逐条透传并解析进度。

fn run_flash_job(
    app: AppHandle,
    stdout: std::process::ChildStdout,
    stderr: std::process::ChildStderr,
    cancel: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
) {
    let (tx_line, rx_line) = mpsc::channel::<String>();

    let t_out = {
        let tx = tx_line.clone();
        std::thread::spawn(move || pump_lines(stdout, tx))
    };
    let t_err = std::thread::spawn(move || pump_lines(stderr, tx_line));

    let mut last_emit = Instant::now();
    let mut pending_progress: Option<(String, u32)> = None;
    let mut tail: Vec<String> = Vec::new();
    let mut exited_ok: Option<bool> = None;

    loop {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        match rx_line.recv_timeout(Duration::from_millis(80)) {
            Ok(line) => {
                let display = line.trim_end().to_string();
                if !display.trim().is_empty() {
                    let _ = app.emit("flash-log", serde_json::json!({ "line": display }));
                    tail.push(display.clone());
                    if tail.len() > 6 {
                        tail.remove(0);
                    }
                }
                if let Some((phase, pct)) = parse_progress(&display) {
                    pending_progress = Some((phase, pct));
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        if let Some((phase, pct)) = pending_progress.take() {
            if last_emit.elapsed() >= Duration::from_millis(60) || pct >= 100 {
                let _ = app.emit(
                    "flash-progress",
                    serde_json::json!({ "phase": phase, "percent": pct }),
                );
                last_emit = Instant::now();
            } else {
                pending_progress = Some((phase, pct));
            }
        }
        let mut g = child.lock().unwrap();
        if let Some(c) = g.as_mut() {
            if let Ok(Some(status)) = c.try_wait() {
                exited_ok = Some(status.success());
                *g = None;
                break;
            }
        } else {
            break;
        }
    }

    let _ = t_out.join();
    let _ = t_err.join();

    // 收尾：清空任务槽位（必须在发 done 事件前，避免前端立刻重发被误判）
    if let Some(st) = app.try_state::<FlashState>() {
        st.clear();
    }

    if cancel.load(Ordering::SeqCst) {
        if let Ok(mut g) = child.lock() {
            if let Some(c) = g.as_mut() {
                let _ = c.kill();
            }
            *g = None;
        }
        let _ = app.emit("flash-done", serde_json::json!({ "ok": false, "message": "已取消" }));
        return;
    }

    let ok = exited_ok.unwrap_or(false);
    let summary = tail.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" | ");
    let message = if ok {
        format!("烧录完成，目标已复位运行。{summary}")
    } else {
        format!("烧录失败。{summary}")
    };
    let _ = app.emit("flash-done", serde_json::json!({ "ok": ok, "message": message }));
}

/// 按字节读取输出流，遇 \n 或 \r 提交一行（pyOCD 进度条用 \r 原地刷新）。
fn pump_lines<R: std::io::Read + Send + 'static>(reader: R, tx: mpsc::Sender<String>) {
    let mut r = BufReader::new(reader);
    let mut buf: Vec<u8> = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    loop {
        match r.read(&mut byte) {
            Ok(0) => break,
            Ok(_) => {
                let b = byte[0];
                if b == b'\n' || b == b'\r' {
                    tx.send(String::from_utf8_lossy(&buf).trim_end_matches('\r').to_string()).ok();
                    buf.clear();
                } else {
                    buf.push(b);
                }
            }
            Err(_) => break,
        }
    }
    if !buf.is_empty() {
        tx.send(String::from_utf8_lossy(&buf).to_string()).ok();
    }
}

/// 从一行输出解析阶段文案与百分比：识别 erase/program/write/verify/reset 关键字 + NN%。
fn parse_progress(line: &str) -> Option<(String, u32)> {
    let lower = line.to_lowercase();
    let bytes = lower.as_bytes();
    let pct_pos = lower.rfind('%')?;
    let mut end = pct_pos;
    while end > 0 && !bytes[end - 1].is_ascii_digit() {
        end -= 1;
    }
    if end == 0 {
        return None;
    }
    let mut start = end;
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    if end - start > 3 {
        return None;
    }
    let pct: u32 = lower[start..end].parse().ok()?;
    if pct > 100 {
        return None;
    }
    let head = &lower[..start];
    let phase = if head.contains("eras") {
        "擦除中…"
    } else if head.contains("download") || head.contains("program") || head.contains("writ") || head.contains("flash") {
        "写入中…"
    } else if head.contains("verif") {
        "校验中…"
    } else if head.contains("reset") || head.contains("run") {
        "复位运行…"
    } else {
        "进行中…"
    };
    Some((phase.to_string(), pct))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_parse_bar() {
        assert_eq!(
            parse_progress("Programming [==================     ] 45%"),
            Some(("写入中…".into(), 45))
        );
        assert_eq!(
            parse_progress("\rErasing sectors ... 12%"),
            Some(("擦除中…".into(), 12))
        );
        assert_eq!(parse_progress("Verifying 100%"), Some(("校验中…".into(), 100)));
        assert_eq!(parse_progress("[=====] 0%"), Some(("进行中…".into(), 0)));
        assert_eq!(parse_progress("No percentage here"), None);
        assert_eq!(parse_progress("Loaded 12345% junk"), None); // 超界百分比拒绝
        assert_eq!(
            parse_progress("File download in progress : 33%"),
            Some(("写入中…".into(), 33))
        ); // CubeProgrammer CLI 文案
    }

    #[test]
    fn target_interpret_f103ve() {
        // REV 0x1001 | DEV 0x414（高密度），Flash 512KB
        let out = ">>> read32 0xE0042000\n0xE0042000: 10016414\n>>> read32 0x1FFFF7E0\n0x1FFFF7E0: 00000200\n";
        let info = interpret_target(out);
        assert!(info.detected);
        assert_eq!(info.dev_id, Some(0x414));
        assert_eq!(info.flash_kb, Some(512));
        assert!(info.guess.contains("stm32f103ve"));
    }

    #[test]
    fn target_interpret_no_target() {
        let info = interpret_target("some random output\nnothing here");
        assert!(!info.detected);
        assert!(info.message.is_some());
    }

    #[test]
    fn target_interpret_dev_id_418_430() {
        // RM0008：0x418 = 互联型（F105/F107），0x430 = 超大容量 XL —— 防回归
        let out_418 = ">>> read32 0xE0042000\n0xE0042000: 00000418\n>>> read32 0x1FFFF7E0\n0x1FFFF7E0: 00000080\n";
        let info = interpret_target(out_418);
        assert_eq!(info.dev_id, Some(0x418));
        assert_eq!(info.density, "互联型");
        assert!(info.guess.contains("F105"));

        let out_430 = ">>> read32 0xE0042000\n0xE0042000: 00000430\n>>> read32 0x1FFFF7E0\n0x1FFFF7E0: 00000400\n";
        let info = interpret_target(out_430);
        assert_eq!(info.dev_id, Some(0x430));
        assert_eq!(info.density, "超大容量 XL");
        assert!(info.guess.contains("ZG"));
    }

    #[test]
    fn tail_lines_helper() {
        assert_eq!(last_lines("a\nb\nc\n", 2).as_deref(), Some("b | c"));
        assert_eq!(last_lines("  \n \n", 3), None);
    }

    #[test]
    fn hex8_boundaries() {
        assert_eq!(first_hex8("0xE0042000: 10016410 zz"), Some(0xE004_2000)); // 地址本身也会命中，调用方需跳过
        assert_eq!(first_hex8("value 1234567 8"), None);
        assert_eq!(first_hex8("abcdeadbeef99x"), None);
    }
}
