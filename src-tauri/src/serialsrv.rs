//! 串口服务：端口枚举、会话管理（读线程 + 分包聚合线程）、写入、DTR/RTS、原始流落盘。
//!
//! 数据流：
//!   [端口线程] 独占串口，轮询收发，把 (到达时刻, 字节块) 发给聚合线程
//!   [聚合线程] 按"字节间隙超时 gap_ms"切逻辑包，50ms 窗口批量 emit `serial-data`
//!   每个包的原始字节同步写入落盘文件（若开启）

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, TryRecvError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::hexio;

/// 单个逻辑包最大字节数（超过强制切断，避免产生巨型包）。
const MAX_PKT_BYTES: usize = 16384;
/// emit 批量窗口（毫秒）：事件频率上限 20/s，前端渲染压力恒定。
const EMIT_WINDOW_MS: u64 = 50;
const READ_POLL_MS: u64 = 15;
/// 待写队列深度：防止"定时发送速率 > 设备实际收数速率"时内存无限增长。
const WRITE_QUEUE_CAP: usize = 1024;
/// 落盘刷盘间隔（毫秒）：批量写 + 周期 flush，兼顾性能与断电丢失上限。
const CAPTURE_FLUSH_MS: u64 = 250;

// ---------------------------------------------------------------------------
// 端口枚举
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct PortEntry {
    pub name: String,
    pub friendly: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
}

pub fn list_ports_detail() -> std::io::Result<Vec<PortEntry>> {
    let infos = serialport::available_ports()?;
    let friendly = windows_friendly_names();
    Ok(infos
        .into_iter()
        .map(|info| {
            let (vid, pid, product) = match &info.port_type {
                serialport::SerialPortType::UsbPort(u) => {
                    (Some(u.vid), Some(u.pid), u.product.clone())
                }
                _ => (None, None, None),
            };
            let friendly =
                friendly.get(&info.port_name).cloned().or(product).unwrap_or_default();
            PortEntry { name: info.port_name, friendly, vid, pid }
        })
        .collect())
}

#[cfg(windows)]
fn windows_friendly_names() -> HashMap<String, String> {
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    // 只扫 USB 子树（2.5s 一次轮询，全树递归代价太高）：
    // USB\VID_xxxx&PID_yyyy\<实例>\Device Parameters\PortName
    let mut map = HashMap::new();
    let hk = RegKey::predef(HKEY_LOCAL_MACHINE);
    let Ok(usb_root) =
        hk.open_subkey_with_flags(r"SYSTEM\CurrentControlSet\Enum\USB", KEY_READ)
    else {
        return map;
    };
    for dev in usb_root.enum_keys().flatten() {
        let Ok(devk) = usb_root.open_subkey_with_flags(&dev, KEY_READ) else { continue };
        for inst in devk.enum_keys().flatten() {
            let Ok(instk) = devk.open_subkey_with_flags(&inst, KEY_READ) else { continue };
            let Ok(dp) = instk.open_subkey_with_flags("Device Parameters", KEY_READ)
            else {
                continue;
            };
            let Ok::<String, _>(port) = dp.get_value("PortName") else { continue };
            if let Ok::<String, _>(f) = instk.get_value("FriendlyName") {
                map.insert(port, f);
            }
        }
    }
    map
}

#[cfg(not(windows))]
fn windows_friendly_names() -> HashMap<String, String> {
    HashMap::new()
}

// ---------------------------------------------------------------------------
// 会话与全局状态
// ---------------------------------------------------------------------------

pub struct SessionGuard {
    writer: mpsc::SyncSender<Vec<u8>>,
    cancel: Arc<AtomicBool>,
}

impl Drop for SessionGuard {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::SeqCst);
    }
}

pub struct AppState {
    pub session: Mutex<Option<SessionGuard>>,
    pub joins: Mutex<Option<(JoinHandle<()>, JoinHandle<()>)>>,
    pub pins_dtr: Arc<AtomicBool>,
    pub pins_rts: Arc<AtomicBool>,
    pub capture_file: Arc<Mutex<Option<BufWriter<File>>>>,
    pub capture_count: Arc<AtomicU64>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            joins: Mutex::new(None),
            pins_dtr: Arc::new(AtomicBool::new(true)),
            pins_rts: Arc::new(AtomicBool::new(true)),
            capture_file: Arc::new(Mutex::new(None)),
            capture_count: Arc::new(AtomicU64::new(0)),
        }
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

// ---------------------------------------------------------------------------
// 打开 / 关闭 / 写入 / 引脚 / 落盘
// ---------------------------------------------------------------------------

pub fn open_port(
    app: &AppHandle,
    state: &AppState,
    name: &str,
    baud: u32,
    gap_ms: u64,
) -> Result<serde_json::Value, String> {
    close_port(state);

    let port = serialport::new(name, baud)
        .data_bits(serialport::DataBits::Eight)
        .parity(serialport::Parity::None)
        .stop_bits(serialport::StopBits::One)
        .flow_control(serialport::FlowControl::None)
        .timeout(Duration::from_millis(READ_POLL_MS))
        .open()
        .map_err(|e| format!("打开 {name} 失败：{e}"))?;

    let cancel = Arc::new(AtomicBool::new(false));
    let (tx_write, rx_write) = mpsc::sync_channel::<Vec<u8>>(WRITE_QUEUE_CAP); // 写队列有界：设备收不过来时让前端立刻得到"队列繁忙"，而不是无限堆积
    // 读方向保持无界：聚合线程只做切包与非阻塞 emit，消费速度远高于到达速度
    let (tx_data, rx_data) = mpsc::channel::<(Instant, Vec<u8>)>();

    // 端口读写循环线程（独占串口所有权）
    let rd_cancel = cancel.clone();
    let rd_dtr = state.pins_dtr.clone();
    let rd_rts = state.pins_rts.clone();
    let err_app = app.clone();
    let err_name = name.to_string();
    let reader = std::thread::spawn(move || {
        run_port_loop(
            PortLoopCtx { port, tx_data, rx_write, cancel: rd_cancel, dtr_want: rd_dtr, rts_want: rd_rts },
            &err_app,
            &err_name,
        );
    });

    // 分包聚合线程
    let agg_cancel = cancel.clone();
    let agg_app = app.clone();
    let agg_port = name.to_string();
    let cap_file = state.capture_file.clone();
    let cap_count = state.capture_count.clone();
    let aggregator = std::thread::spawn(move || {
        run_aggregator(
            agg_app,
            agg_port,
            rx_data,
            gap_ms.clamp(1, 1000),
            agg_cancel,
            cap_file,
            cap_count,
        );
    });

    *state.session.lock().unwrap() = Some(SessionGuard { writer: tx_write, cancel });
    *state.joins.lock().unwrap() = Some((reader, aggregator));

    Ok(serde_json::json!({ "name": name, "baud": baud, "gapMs": gap_ms }))
}

pub fn close_port(state: &AppState) {
    if let Some(guard) = state.session.lock().unwrap().take() {
        drop(guard); // Drop 里置取消标志
    }
    if let Some(joins) = state.joins.lock().unwrap().take() {
        let _ = joins.0.join();
        let _ = joins.1.join();
    }
}

pub fn send_bytes(state: &AppState, data: &[u8]) -> Result<usize, String> {
    let guard = state.session.lock().unwrap();
    let Some(s) = guard.as_ref() else {
        return Err("串口未连接".into());
    };
    match s.writer.try_send(data.to_vec()) {
        Ok(()) => Ok(data.len()),
        Err(mpsc::TrySendError::Full(_)) => {
            Err("发送队列已满：设备未及时收数，请降低发送频率".into())
        }
        Err(mpsc::TrySendError::Disconnected(_)) => Err("串口已断开".into()),
    }
}

pub fn set_pins(state: &AppState, dtr: bool, rts: bool) -> Result<(), String> {
    let guard = state.session.lock().unwrap();
    if guard.as_ref().is_none() {
        return Err("串口未连接".into());
    }
    drop(guard);
    state.pins_dtr.store(dtr, Ordering::SeqCst);
    state.pins_rts.store(rts, Ordering::SeqCst);
    Ok(())
}

pub fn start_capture(state: &AppState, path: &str) -> Result<(), String> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(true) // 保存对话框语义是"新文件"：覆盖而非追加
        .open(path)
        .map_err(|e| format!("无法创建接收文件：{e}"))?;
    *state.capture_file.lock().unwrap() = Some(BufWriter::with_capacity(16 * 1024, file));
    state.capture_count.store(0, Ordering::SeqCst);
    Ok(())
}

pub fn stop_capture(state: &AppState) -> Result<u64, String> {
    let mut g = state.capture_file.lock().unwrap();
    if let Some(mut w) = g.take() {
        w.flush().map_err(|e| e.to_string())?;
    }
    Ok(state.capture_count.load(Ordering::SeqCst))
}

// ---------------------------------------------------------------------------
// 读+写端口循环
// ---------------------------------------------------------------------------

type TxData = mpsc::Sender<(Instant, Vec<u8>)>;
type RxWrite = mpsc::Receiver<Vec<u8>>;

/// 端口读写循环线程的输入（避免过长参数列表）。
struct PortLoopCtx {
    port: Box<dyn serialport::SerialPort>,
    tx_data: TxData,
    rx_write: RxWrite,
    cancel: Arc<AtomicBool>,
    dtr_want: Arc<AtomicBool>,
    rts_want: Arc<AtomicBool>,
}

fn run_port_loop(ctx: PortLoopCtx, app: &AppHandle, port_name: &str) {
    let PortLoopCtx { mut port, tx_data, rx_write, cancel, dtr_want, rts_want } = ctx;
    let mut buf = vec![0u8; 8192];
    let mut dtr_cur = dtr_want.load(Ordering::SeqCst);
    let mut rts_cur = rts_want.load(Ordering::SeqCst);
    let _ = port.write_data_terminal_ready(dtr_cur);
    let _ = port.write_request_to_send(rts_cur);

    loop {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        // 应用外部引脚请求
        if dtr_cur != dtr_want.load(Ordering::SeqCst) {
            dtr_cur = !dtr_cur;
            let _ = port.write_data_terminal_ready(dtr_cur);
        }
        if rts_cur != rts_want.load(Ordering::SeqCst) {
            rts_cur = !rts_cur;
            let _ = port.write_request_to_send(rts_cur);
        }
        // 发送队列
        match rx_write.try_recv() {
            Ok(data) => {
                if let Err(e) = port.write_all(&data).and_then(|_| port.flush()) {
                    emit_error(app, port_name, format!("发送失败：{e}"));
                    break;
                }
            }
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => {}
        }
        // 接收
        match port.read(&mut buf) {
            Ok(n) if n > 0 => {
                if tx_data.send((Instant::now(), buf[..n].to_vec())).is_err() {
                    break;
                }
            }
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
            Err(e) => {
                emit_error(app, port_name, format!("读取中断，串口可能被拔出：{e}"));
                break;
            }
        }
    }
}

fn emit_error(app: &AppHandle, port: &str, message: String) {
    let _ = app.emit("serial-error", serde_json::json!({ "port": port, "message": message }));
}

// ---------------------------------------------------------------------------
// 分包聚合线程
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
struct PacketEvent {
    ts_millis: u64,
    len: usize,
    hex: String,
}

/// 落盘写入：成功才计数；周期 flush 平衡性能与丢失上限；出错立即终止录制
/// 并上报一次 `capture-error`（前端据此复位录制 UI）。
fn write_capture(
    app: &AppHandle,
    cap_file: &Arc<Mutex<Option<BufWriter<File>>>>,
    cap_count: &AtomicU64,
    data: &[u8],
    last_flush: &mut Instant,
) {
    let mut g = match cap_file.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    let Some(w) = g.as_mut() else { return };
    let due = last_flush.elapsed() >= Duration::from_millis(CAPTURE_FLUSH_MS);
    let res = w.write_all(data).and_then(|_| if due { w.flush() } else { Ok(()) });
    match res {
        Ok(()) => {
            cap_count.fetch_add(data.len() as u64, Ordering::SeqCst);
            if due {
                *last_flush = Instant::now();
            }
        }
        Err(e) => {
            *g = None; // 终止录制，避免每包重复报错
            drop(g);
            let _ = app.emit(
                "capture-error",
                serde_json::json!({ "message": format!("录制写入失败：{e}") }),
            );
        }
    }
}

fn run_aggregator(
    app: AppHandle,
    port_name: String,
    rx_data: mpsc::Receiver<(Instant, Vec<u8>)>,
    gap_ms: u64,
    cancel: Arc<AtomicBool>,
    cap_file: Arc<Mutex<Option<BufWriter<File>>>>,
    cap_count: Arc<AtomicU64>,
) {
    let gap = Duration::from_millis(gap_ms);
    let poll = Duration::from_millis(10);

    let mut pending: Vec<PacketEvent> = Vec::new();
    let mut buf: Vec<u8> = Vec::new();
    let mut buf_first_ts: u64 = 0;
    let mut last_rx: Option<Instant> = None;
    let mut last_emit = Instant::now();
    let mut cap_last_flush = Instant::now();

    macro_rules! flush_packet {
        () => {
            if !buf.is_empty() {
                let data = std::mem::take(&mut buf);
                write_capture(&app, &cap_file, &cap_count, &data, &mut cap_last_flush);
                pending.push(PacketEvent {
                    ts_millis: buf_first_ts,
                    len: data.len(),
                    hex: hexio::format_hex_grouped(&data),
                });
            }
        };
    }

    loop {
        if cancel.load(Ordering::SeqCst) {
            break;
        }
        match rx_data.recv_timeout(poll) {
            Ok((now, data)) => {
                // 字节间隙超过 gap → 切包
                if let Some(last) = last_rx {
                    if now.duration_since(last) >= gap && !buf.is_empty() {
                        flush_packet!();
                    }
                }
                if buf.is_empty() {
                    buf_first_ts = now_ms();
                } else if buf.len() + data.len() > MAX_PKT_BYTES {
                    flush_packet!();
                    buf_first_ts = now_ms();
                }
                buf.extend_from_slice(&data);
                last_rx = Some(now);
            }
            Err(RecvTimeoutError::Timeout) => {
                // 空闲超时 → 结束当前包
                if last_rx.is_some_and(|t| t.elapsed() >= gap) {
                    flush_packet!();
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // 批量 emit
        if !pending.is_empty() && last_emit.elapsed() >= Duration::from_millis(EMIT_WINDOW_MS) {
            let ev = serde_json::json!({
                "port": port_name,
                "packets": std::mem::take(&mut pending),
            });
            let _ = app.emit("serial-data", ev);
            last_emit = Instant::now();
        }
    }
    // 收尾
    flush_packet!();
    if !pending.is_empty() {
        let ev = serde_json::json!({ "port": port_name, "packets": pending });
        let _ = app.emit("serial-data", ev);
    }
    // 串口关闭但录制未停时，把缓冲区里最后一段刷到磁盘
    if let Ok(mut g) = cap_file.lock() {
        if let Some(w) = g.as_mut() {
            let _ = w.flush();
        }
    }
}
