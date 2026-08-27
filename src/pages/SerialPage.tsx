import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, onEvent, subscribeAll, type PacketEvent, type PortEntry, type SerialDataEvent } from "../api";
import { CountUp, Dropdown, RefreshButton, Spinner, Toast } from "../components/fx";
import RulesPanel from "../components/RulesPanel";
import TerminalView, { type TermLine } from "../components/TerminalView";
import {
  buildTxPayload,
  type ChecksumKind,
} from "../protocol";
import { compileRules, countColor, DEFAULT_RULES, type HighlightRule } from "../rules";

const MAX_LINES = 100_000;
const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
const CHECK_OPTS: Array<[ChecksumKind, string]> = [
  ["none", "None"],
  ["sum", "SUM 累加和"],
  ["crc8", "CRC8"],
  ["crc16modbus", "CRC16 MODBUS"],
];

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function hexToBytes(hex: string): Uint8Array {
  if (!hex) return new Uint8Array(0);
  const parts = hex.split(" ");
  const out = new Uint8Array(parts.length);
  for (let i = 0; i < parts.length; i++) out[i] = parseInt(parts[i], 16);
  return out;
}

function fmtBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`;
}

interface Props {
  onConnChange: (label: string | null) => void;
  /** 当前是否为激活页（页面常驻挂载，仅切换显示，保证串口/录制状态不丢） */
  active: boolean;
}

export default function SerialPage({ onConnChange, active }: Props) {
  // ---- 连接相关 ----
  const [ports, setPorts] = useState<PortEntry[]>([]);
  const [port, setPort] = useState("");
  const [baud, setBaud] = useState(115200);
  const [gapMs, setGapMs] = useState(20);
  const [connected, setConnected] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [dtr, setDtr] = useState(true);
  const [rts, setRts] = useState(true);

  // ---- 显示相关 ----
  const [encoding, setEncoding] = useState<"utf8" | "gbk">("utf8");
  const [hexDisplay, setHexDisplay] = useState(false);
  const [showTs, setShowTs] = useState(true);
  const [showLen, setShowLen] = useState(true);
  const [filterText, setFilterText] = useState("");
  const [autoScroll, setAutoScroll] = useState(true);

  // ---- 高亮规则 ----
  const [rules, setRules] = useState<HighlightRule[]>(DEFAULT_RULES);

  // ---- 发送相关 ----
  const [sendInput, setSendInput] = useState("");
  const [hexSend, setHexSend] = useState(false);
  const [crlf, setCrlf] = useState(false);
  const [checksum, setChecksum] = useState<ChecksumKind>("none");
  const [timerOn, setTimerOn] = useState(false);
  const [timerMs, setTimerMs] = useState(1000);
  const [history, setHistory] = useState<string[]>([]);
  const histIdxRef = useRef(-1);
  const [sendErr, setSendErr] = useState("");

  // ---- 落盘 ----
  const [capPath, setCapPath] = useState<string | null>(null);

  // ---- 提示 ----
  const [toast, setToast] = useState<{ msg: string; info?: boolean; key: number } | null>(null);
  const showToast = useCallback((msg: string, info = false) => {
    setToast({ msg, info, key: Date.now() });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2800);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- 数据缓冲（refs，避免重渲染开销）----
  const linesRef = useRef<TermLine[]>([]);
  const pendingRef = useRef<PacketEvent[]>([]);
  const statsRef = useRef({ rxBytes: 0, err: 0, warn: 0 });
  const [tick, setTick] = useState(0);
  const forceTick = useCallback(() => setTick((t) => (t + 1) % 1_000_000), []);
  const rulesRef = useRef(rules);
  const connRef = useRef(connected);
  const optsRef = useRef({ sendInput, hexSend, crlf, checksum });

  useEffect(() => {
    rulesRef.current = rules;
  }, [rules]);
  useEffect(() => {
    connRef.current = connected;
    onConnChange(
      connected ? `串口已连接 · ${port}@${baud}` : null,
    );
  }, [connected, port, baud, onConnChange]);
  useEffect(() => {
    optsRef.current = { sendInput, hexSend, crlf, checksum };
  }, [sendInput, hexSend, crlf, checksum]);

  const compiled = useMemo(() => compileRules(rules), [rules]);
  const compiledRef = useRef(compiled);
  useEffect(() => {
    compiledRef.current = compiled;
  }, [compiled]);

  const filterRe = useMemo(() => {
    if (!filterText.trim()) return null;
    try {
      return new RegExp(filterText, "i");
    } catch {
      return null;
    }
  }, [filterText]);

  const utf8Decoder = useMemo(() => new TextDecoder("utf-8"), []);

  // ---- 渲染泵：收到的包按固定节奏刷入缓冲并触发渲染 ----
  useEffect(() => {
    const timer = setInterval(() => {
      if (pendingRef.current.length === 0) return;
      const packets = pendingRef.current.splice(0);
      let changed = false;
      for (const p of packets) {
        const bytes = hexToBytes(p.hex);
        linesRef.current.push({ ts: p.ts_millis, bytes });
        statsRef.current.rxBytes += p.len;
        // 统计按 UTF-8 宽松解码做规则匹配（ASCII 关键字在 GBK 日志同样命中）
        const text = utf8Decoder.decode(bytes);
        const c = compiledRef.current;
        statsRef.current.err += countColor(text, c, "red");
        statsRef.current.warn += countColor(text, c, "amber");
        changed = true;
      }
      const L = linesRef.current;
      if (L.length > MAX_LINES) L.splice(0, L.length - MAX_LINES);
      if (changed) forceTick();
    }, 90);
    return () => clearInterval(timer);
  }, [forceTick, utf8Decoder]);

  // ---- 事件订阅 ----
  useEffect(() => {
    const sub = subscribeAll([
      onEvent<SerialDataEvent>("serial-data", (pl) => {
        pendingRef.current.push(...pl.packets);
      }),
      onEvent<{ port: string; message: string }>("serial-error", (pl) => {
        linesRef.current.push({
          ts: Date.now(),
          bytes: new Uint8Array(0),
          sys: pl.message,
        });
        forceTick();
        if (connRef.current) {
          api.closePort().catch(() => {});
          setConnected(false);
        }
      }),
      onEvent<{ message: string }>("capture-error", (pl) => {
        setCapPath(null);
        showToast(`录制出错，已停止：${pl.message}`);
      }),
    ]);
    return sub.cancel;
  }, [forceTick, showToast]);

  // ---- 端口列表 ----
  const [refreshing, setRefreshing] = useState(false);
  const refreshPorts = useCallback(async () => {
    try {
      const list = await api.listPorts();
      setPorts(list);
      setPort((cur) => (list.some((p) => p.name === cur) ? cur : list[0]?.name ?? ""));
    } catch {
      /* 非桌面环境 */
    }
  }, []);
  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshPorts();
    setRefreshing(false);
  }, [refreshPorts]);
  // 端口列表：页面可见时立即刷新并按 2.5s 轮询；隐藏页不空转
  useEffect(() => {
    if (!active) return;
    void refreshPorts();
    if (connected) return;
    const t = setInterval(refreshPorts, 2500);
    return () => clearInterval(t);
  }, [active, connected, refreshPorts]);

  // ---- 连接 / 断开 ----
  const connect = async () => {
    if (!port || connecting) return;
    setConnecting(true);
    try {
      await api.openPort(port, baud, gapMs);
      setConnected(true);
    } catch (e) {
      showToast(`连接失败：${msgOf(e)}`);
    } finally {
      setConnecting(false);
    }
  };
  const disconnect = async () => {
    try {
      await api.closePort();
    } finally {
      setConnected(false);
    }
  };

  // ---- 发送 ----
  const pushHistory = (text: string) => {
    if (!text.trim()) return;
    setHistory((h) => {
      const next = h.filter((x) => x !== text);
      next.push(text);
      return next.slice(-50);
    });
    histIdxRef.current = -1;
  };

  const doSend = async () => {
    const o = optsRef.current;
    try {
      const payload = buildTxPayload(o.sendInput, o.hexSend, o.crlf, o.checksum);
      await api.send(payload);
      setSendErr("");
      pushHistory(o.sendInput);
      return true;
    } catch (e) {
      setSendErr(msgOf(e));
      return false;
    }
  };

  useEffect(() => {
    if (!timerOn) return;
    if (!connected) {
      showToast("定时发送需要先连接串口", true);
      setTimerOn(false);
      return;
    }
    const ms = Math.max(20, timerMs);
    const t = setInterval(() => void doSend(), ms);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timerOn, timerMs, connected]);

  const onSendKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      void doSend();
    } else if (e.key === "ArrowUp" && history.length > 0) {
      e.preventDefault();
      histIdxRef.current =
        histIdxRef.current < 0
          ? history.length - 1
          : Math.max(0, histIdxRef.current - 1);
      setSendInput(history[histIdxRef.current]);
    } else if (e.key === "ArrowDown" && history.length > 0) {
      e.preventDefault();
      if (histIdxRef.current >= history.length - 1) {
        histIdxRef.current = -1;
        setSendInput("");
      } else {
        histIdxRef.current += 1;
        setSendInput(history[histIdxRef.current]);
      }
    }
  };

  // ---- 落盘 / 导出 ----
  const toggleCapture = async () => {
    if (!capPath) {
      const path = await saveDialog({
        title: "接收数据写入文件",
        defaultPath: `rx_${stamp()}.bin`,
        filters: [{ name: "原始字节流", extensions: ["bin"] }],
      });
      if (!path) return;
      try {
        await api.startCapture(path);
        setCapPath(path);
      } catch (e) {
        showToast(msgOf(e));
      }
    } else {
      try {
        const n = await api.stopCapture();
        showToast(`已停止落盘，本次共 ${n} 字节`, true);
      } finally {
        setCapPath(null);
      }
    }
  };

  const exportLog = async () => {
    const path = await saveDialog({
      title: "导出日志",
      defaultPath: `serial_log_${stamp()}.log`,
      filters: [{ name: "文本日志", extensions: ["log", "txt"] }],
    });
    if (!path) return;
    const pad = (n: number, w = 2) => String(n).padStart(w, "0");
    const lines = linesRef.current.map((l) => {
      if (l.sys !== undefined) return `‼ ${l.sys}`;
      const d = new Date(l.ts);
      const ts = showTs
        ? `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)} `
        : "";
      const body = hexDisplay
        ? Array.from(l.bytes, (b) => b.toString(16).toUpperCase().padStart(2, "0")).join(" ")
        : new TextDecoder(encoding === "gbk" ? "gbk" : "utf-8").decode(l.bytes).replace(/\r/g, "");
      return `${ts}${body}`;
    });
    try {
      await api.writeTextFile(path, lines.join("\n") + "\n");
      showToast(`已导出 ${lines.length} 行`, true);
    } catch (e) {
      showToast(msgOf(e));
    }
  };

  const clearScreen = () => {
    linesRef.current = [];
    statsRef.current.err = 0;
    statsRef.current.warn = 0;
    forceTick();
  };

  // ---- 设置持久化 ----
  useEffect(() => {
    api.settingsGet().then((s) => {
      if (typeof s.port === "string") setPort(s.port);
      if (typeof s.baud === "number") setBaud(s.baud);
      if (typeof s.gapMs === "number") setGapMs(s.gapMs);
      if (s.encoding === "gbk") setEncoding("gbk");
      if (typeof s.hexDisplay === "boolean") setHexDisplay(s.hexDisplay);
      if (typeof s.showLen === "boolean") setShowLen(s.showLen);
      if (typeof s.hexSend === "boolean") setHexSend(s.hexSend);
      if (typeof s.crlf === "boolean") setCrlf(s.crlf);
      if (typeof s.timerMs === "number") setTimerMs(s.timerMs);
      if (Array.isArray(s.customRules))
        setRules([...DEFAULT_RULES, ...(s.customRules as HighlightRule[])]);
    }).catch(() => {});
  }, []);

  const savePatch = useRef<number | undefined>(undefined);
  useEffect(() => {
    window.clearTimeout(savePatch.current);
    savePatch.current = window.setTimeout(() => {
      api.settingsSave({
        port,
        baud,
        gapMs,
        encoding,
        hexDisplay,
        showLen,
        hexSend,
        crlf,
        timerMs,
        customRules: rules.filter((r) => !r.builtin),
      }).catch(() => {});
    }, 400);
  }, [port, baud, gapMs, encoding, hexDisplay, showLen, hexSend, crlf, timerMs, rules]);

  // ---- 派生显示数据（必须每次产出新数组引用，TerminalView 以引用变化为重算依据） ----
  const viewLines = useMemo(() => linesRef.current.slice(-1500), [tick]);

  const portDesc = ports.find((p) => p.name === port)?.friendly ?? "";
  const s = statsRef.current;

  return (
    <main className={`page page-serial${active ? " active" : ""}`}>

      {/* 工具条 */}
      <div className="card ser-toolbar">
        <span className="lbl">端口</span>
        <Dropdown value={port} disabled={connected} width={272}
          options={ports.length === 0
            ? [{ value: "", label: "未发现串口设备" }]
            : ports.map((p) => ({ value: p.name, label: `${p.name}${p.friendly ? ` — ${p.friendly}` : ""}` }))}
          onChange={(v) => setPort(v)} />
        <RefreshButton small loading={refreshing} disabled={connected}
          onClick={() => void manualRefresh()} />
        <span className="lbl">波特率</span>
        <Dropdown value={String(baud)} disabled={connected} width={110}
          options={BAUDS.map((b) => ({ value: String(b), label: String(b) }))}
          onChange={(v) => setBaud(+v)} />
        <span className="lbl">编码</span>
        <Dropdown value={encoding} width={96}
          options={[{ value: "utf8", label: "UTF-8" }, { value: "gbk", label: "GBK" }]}
          onChange={(v) => setEncoding(v as "utf8" | "gbk")} />
        {connected ? (
          <button className="btn-conn disc" onClick={() => void disconnect()}>
            <span className="btn-disc-dot" />断开连接
          </button>
        ) : (
          <button className="btn-conn" onClick={() => void connect()} disabled={!port || connecting}>
            {connecting ? <><Spinner size={12} />连接中…</> : "连接"}
          </button>
        )}
        <div className="grow" />
        <label className="chk"><b>时间戳</b><input type="checkbox" checked={showTs} onChange={(e) => setShowTs(e.target.checked)} /></label>
        <span className="opt">自动滚动
          <label className="tgl"><input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} /><span className="track" /></label>
        </span>
        <input className="filter-in" placeholder="⌕ 过滤关键字…" value={filterText} onChange={(e) => setFilterText(e.target.value)} />
        <button className="mini-act" onClick={clearScreen}>清屏</button>
        <button className="mini-act" onClick={() => void exportLog()}>导出日志</button>
      </div>

      {/* 终端 + 右栏 */}
      <div className="term-wrap">
        <div className="recv-opts">
          <span className="lbl">接收</span>
          <label className="chk"><input type="checkbox" checked={hexDisplay} onChange={(e) => setHexDisplay(e.target.checked)} />HEX 显示</label>
          <label className="chk"><input type="checkbox" checked={showLen} onChange={(e) => setShowLen(e.target.checked)} />分包显示</label>
          <span className="lbl">超时</span>
          <input className="mini-in" value={gapMs} disabled={connected}
            onChange={(e) => setGapMs(Math.min(1000, Math.max(1, +e.target.value.replace(/\D/g, "") || 1)))} />
          <span className="lbl">ms · 按字节间隙分包</span>
          <span className="vline" />
          {capPath ? (
            <>
              <span className="rec-on"><span className="rdot" />接收数据到文件 {capPath.split(/[\\/]/).pop()}</span>
              <button className="mini-act" onClick={() => void toggleCapture()}>停止</button>
            </>
          ) : (
            <>
              <span className="rec-off">接收数据到文件</span>
              <button className="mini-act" onClick={() => void toggleCapture()} disabled={!connected}>开始</button>
            </>
          )}
        </div>
        <TerminalView
          lines={viewLines}
          hexDisplay={hexDisplay}
          showTs={showTs}
          showLen={showLen}
          encoding={encoding}
          compiled={compiled}
          filterRe={filterRe}
          connected={connected && autoScroll}
        />
        <div className="send-bar">
          <input
            className="send-in"
            value={sendInput}
            placeholder={hexSend ? "输入 HEX，如 68 03 00 1A" : "输入要发送的内容…"}
            onChange={(e) => setSendInput(e.target.value)}
            onKeyDown={onSendKeyDown}
            disabled={!connected}
          />
          <label className="chk"><input type="checkbox" checked={hexSend} onChange={(e) => setHexSend(e.target.checked)} /><b>HEX 发送</b></label>
          <label className="chk"><input type="checkbox" checked={crlf} onChange={(e) => setCrlf(e.target.checked)} />回车换行</label>
          <span className="lbl">校验</span>
          <Dropdown small width={138} value={checksum}
            options={CHECK_OPTS.map(([v, t]) => ({ value: v, label: t }))}
            onChange={(v) => setChecksum(v as ChecksumKind)} />
          <span className="vline" />
          <label className="chk"><input type="checkbox" checked={timerOn} onChange={(e) => setTimerOn(e.target.checked)} />定时发送</label>
          <input className="mini-in" style={{ width: 64 }} value={timerMs}
            onChange={(e) => setTimerMs(Math.max(20, +e.target.value.replace(/\D/g, "") || 20))} />
          <span className="lbl">ms/次</span>
          <button className="btn-send" onClick={() => void doSend()} disabled={!connected}>发送 ⏎</button>
          {sendErr ? <span className="send-err">{sendErr}</span> : <span className="hint">↑↓ 历史 · Ctrl+⏎ 发送</span>}
        </div>
      </div>

      {/* 右栏 */}
      <div className="side">
        <RulesPanel rules={rules} onChange={setRules} />
        <div className="panel">
          <h4>会话统计</h4>
          <div className="stats-grid">
            <div className="stat"><div className="n"><CountUp value={linesRef.current.length} format={(v) => Math.round(v).toLocaleString()} /></div><div className="t">总行数</div></div>
            <div className="stat"><div className="n red"><CountUp value={s.err} /></div><div className="t">ERROR</div></div>
            <div className="stat"><div className="n amber"><CountUp value={s.warn} /></div><div className="t">WARN</div></div>
            <div className="stat"><div className="n"><CountUp value={s.rxBytes} format={(v) => fmtBytes(v)} /></div><div className="t">RX 字节</div></div>
          </div>
        </div>
      </div>

      {/* 状态栏 */}
      <div></div>
      <div className="status-bar">
        {connected ? <span className="okc">● 已连接</span> : <span>○ 未连接</span>}
        <span>{port || "-"} · {connected ? `${baud} 8N1` : "-"}</span>
        <span>RX {fmtBytes(s.rxBytes)}</span>
        <span>行 {linesRef.current.length.toLocaleString()}</span>
        {capPath && <span style={{ color: "var(--green)" }}>● 落盘中</span>}
        <span className="right">
          <label className="chk" title="连接时可实时切换">DTR
            <input type="checkbox" checked={dtr} onChange={(e) => {
              setDtr(e.target.checked);
              if (connected) api.setPins(e.target.checked, rts).catch(() => {});
            }} />
          </label>
          <label className="chk">RTS
            <input type="checkbox" checked={rts} onChange={(e) => {
              setRts(e.target.checked);
              if (connected) api.setPins(dtr, e.target.checked).catch(() => {});
            }} />
          </label>
          <span>{portDesc}</span>
        </span>
      </div>

      {toast && (
        <Toast item={{ key: toast.key, msg: toast.msg, kind: toast.info ? "ok" : "err" }} />
      )}
    </main>
  );
}

// 小工具 -------------------------------------------------------------------

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
