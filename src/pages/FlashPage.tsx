import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  api,
  onEvent,
  subscribeAll,
  type FirmwareMeta,
  type ProbeDevice,
  type TargetInfo,
} from "../api";
import { Dropdown, ProgressRing, RefreshButton, SpotlightCard, Spinner, Toast } from "../components/fx";

const TARGETS = [
  "stm32f103ve",
  "stm32f103vc",
  "stm32f103vd",
  "stm32f103ze",
  "stm32f103rc",
  "stm32f103rb",
  "stm32f103c8",
];

const KIND_LABEL: Record<ProbeDevice["kind"], string> = {
  stlink: "00 ST-Link",
  daplink: "01 DAPLink",
  bmp: "10 BMP",
};

function fmtBytes(n: number): string {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

function fmtAddr(a?: number): string {
  return a === undefined ? "—" : `0x${a.toString(16).toUpperCase().padStart(8, "0")}`;
}

interface Props {
  onStatusChange: (label: string | null) => void;
  /** 当前是否为激活页（页面常驻挂载，仅切换显示，保证烧录任务状态不丢） */
  active: boolean;
}

export default function FlashPage({ onStatusChange, active }: Props) {
  // ---- 设备识别 ----
  const [probes, setProbes] = useState<ProbeDevice[]>([]);
  const [firstProbe, setFirstProbe] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [engineVer, setEngineVer] = useState<string | null>(null);
  const [engineErr, setEngineErr] = useState<string | null>(null);
  const [cliVer, setCliVer] = useState<string | null>(null);
  const [cliErr, setCliErr] = useState<string | null>(null);

  const refreshProbes = useCallback(async () => {
    try {
      setProbes(await api.identifyProbes());
    } catch {
      /* 忽略 */
    } finally {
      setFirstProbe(false);
    }
  }, []);

  const manualRefresh = useCallback(async () => {
    setRefreshing(true);
    await refreshProbes();
    setRefreshing(false);
  }, [refreshProbes]);

  // 引擎自检只在挂载时执行一次（后台页面也需要结论，flash-done 前即可就绪）
  useEffect(() => {
    api.pyocdCheck()
      .then((v) => {
        setEngineVer(v);
        setEngineErr(null);
      })
      .catch((e) => setEngineErr(String(e instanceof Error ? e.message : e)));
    api.stm32cliCheck()
      .then((v) => {
        setCliVer(v);
        setCliErr(null);
      })
      .catch((e) => setCliErr(String(e instanceof Error ? e.message : e)));
  }, []);

  // 设备轮询仅在页面可见时进行（隐藏页不空转注册表/USB 查询；切回时立即刷一次）
  useEffect(() => {
    if (!active) return;
    void refreshProbes();
    const t = setInterval(refreshProbes, 2000);
    return () => clearInterval(t);
  }, [active, refreshProbes]);

  const activeKind = useMemo<"daplink" | "stlink" | "bmp" | null>(() => {
    const pri: Array<ProbeDevice["kind"]> = ["daplink", "stlink", "bmp"];
    for (const k of pri) if (probes.some((p) => p.kind === k)) return k;
    return null;
  }, [probes]);

  // ---- 目标芯片自动识别 ----
  const runProbe = useCallback(
    async (silent = false) => {
      if (probingRef.current) return;
      probingRef.current = true;
      setProbing(true);
      try {
        const info = await api.probeTarget();
        setTInfo(info);
        if (info.detected && info.guess) {
          const m = info.guess.match(/^(stm32f10[0-9][a-z]{2})/i);
          const g = m?.[1]?.toLowerCase();
          if (g && TARGETS.includes(g)) setTarget(g);
        } else if (!silent && info.message) {
          showToast(info.message);
        }
      } catch (e) {
        showToast(msgOf(e));
      } finally {
        probingRef.current = false;
        setProbing(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeKind],
  );

  useEffect(() => {
    const p = probes.find((x) => x.kind === activeKind);
    onStatusChange(p ? `${p.label}${p.hint ? ` · ${p.hint}` : ""}` : null);
  }, [probes, activeKind, onStatusChange]);

  // ---- 固件文件 ----
  const [filePath, setFilePath] = useState<string | null>(null);
  const [meta, setMeta] = useState<FirmwareMeta | null>(null);

  const pickFile = async () => {
    const path = await openFileDialog({
      title: "选择固件文件",
      multiple: false,
      filters: [
        { name: "固件", extensions: ["hex", "bin", "elf"] },
      ],
    });
    if (!path || typeof path !== "string") return;
    try {
      const m = await api.firmwareMeta(path);
      setFilePath(path);
      setMeta(m);
      if (m.error) showToast(`固件解析警告：${m.error}`);
    } catch (e) {
      showToast(msgOf(e));
    }
  };

  // ---- 烧录设置 ----
  const [target, setTarget] = useState("auto");
  const [tInfo, setTInfo] = useState<TargetInfo | null>(null);
  const [probing, setProbing] = useState(false);
  const probingRef = useRef(false);
  const [chipErase, setChipErase] = useState(true);
  const [verifyOn, setVerifyOn] = useState(true);
  const [baseAddr, setBaseAddr] = useState("0x08000000");

  // ---- 任务状态 ----
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [percent, setPercent] = useState(0);
  const [logs, setLogs] = useState<Array<{ text: string; cls: string }>>([]);
  const logRef = useRef<HTMLDivElement>(null);
  const percentRef = useRef(0);

  const pushLog = useCallback((text: string, cls: string) => {
    setLogs((prev) => {
      const next = [...prev, { text, cls }];
      return next.length > 400 ? next.slice(next.length - 400) : next;
    });
  }, []);

  // ---- 提示 ----
  const [toast, setToast] = useState<{ msg: string; info?: boolean; key: number } | null>(null);
  const showToast = useCallback((msg: string, info = false) => setToast({ msg, info, key: Date.now() }), []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  // ---- 设置持久化 ----
  useEffect(() => {
    api.settingsGet().then((s) => {
      if (typeof s.flashTarget === "string") setTarget(s.flashTarget);
      if (typeof s.flashFile === "string") setFilePath(s.flashFile);
      if (typeof s.chipErase === "boolean") setChipErase(s.chipErase);
      if (typeof s.verifyFlash === "boolean") setVerifyOn(s.verifyFlash);
      if (typeof s.baseAddr === "string") setBaseAddr(s.baseAddr);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    const t = window.setTimeout(() => {
      api.settingsSave({
        flashTarget: target,
        flashFile: filePath,
        chipErase,
        verifyFlash: verifyOn,
        baseAddr,
      }).catch(() => {});
    }, 400);
    return () => window.clearTimeout(t);
  }, [target, filePath, chipErase, verifyOn, baseAddr]);

  // 自动探测：01/00 模式在线 + 目标选择为 auto + pyOCD 引擎可用时触发一次
  useEffect(() => {
    if (
      target === "auto" &&
      (activeKind === "daplink" || activeKind === "stlink") &&
      engineVer && !tInfo && !probingRef.current
    ) {
      void runProbe(true);
    }
  }, [target, activeKind, engineVer, tInfo, probing, runProbe]);

  // ---- 引擎事件 ----
  useEffect(() => {
    const sub = subscribeAll([
      onEvent<{ phase: string; percent: number }>("flash-progress", (pl) => {
        const pct = Math.min(100, pl.percent);
        if (pct >= percentRef.current || percentRef.current === 100) {
          percentRef.current = pct;
          setPercent(pct);
        }
        setPhase(pl.phase);
      }),
      onEvent<{ ok: boolean; message: string }>("flash-done", (pl) => {
        setBusy(false);
        percentRef.current = pl.ok ? 100 : 0;
        setPercent(pl.ok ? 100 : 0);
        pushLog(pl.message, pl.ok ? "fl-ok" : "fl-err");
        showToast(pl.message.split("。")[0], pl.ok);
        void refreshProbes();
      }),
      onEvent<{ line: string }>("flash-log", (pl) => {
        const line = pl.line;
        let cls = "";
        if (/error|err:|failed|fail/i.test(line)) cls = "fl-err";
        else if (/done|complete|success|verified|\bOK\b/i.test(line)) cls = "fl-ok";
        pushLog(line, cls);
      }),
    ]);
    return sub.cancel;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logs]);

  const engineKind: "pyocd" | "stm32cli" = activeKind === "stlink" ? "stm32cli" : "pyocd";

  const canFlash =
    !busy &&
    !!filePath &&
    !!meta &&
    !meta.error &&
    (activeKind === "stlink"
      ? cliVer !== null
      : activeKind === "daplink"
        ? engineVer !== null && target !== "auto"
        : false);

  const startFlash = async () => {
    if (!filePath || !meta) return;
    if (engineKind === "pyocd" && target === "auto") {
      showToast("目标芯片识别未完成，请手动选择型号");
      return;
    }
    const format =
      meta.kind === "hex" ? "hex" as const :
      meta.kind === "bin" ? "bin" as const : "elf" as const;
    const args = {
      engine: engineKind,
      target: engineKind === "stm32cli" ? "" : target,
      file: filePath,
      format,
      base_addr: format === "bin" ? baseAddr.trim() : null,
      chip_erase: chipErase,
      verify: verifyOn,
    };
    percentRef.current = 0;
    setPercent(0);
    setPhase("准备中…");
    setLogs([]);
    setBusy(true);
    pushLog(
      engineKind === "stm32cli"
        ? `$ STM32_Programmer_CLI -c port=SWD ${chipErase ? "-e all " : ""}-d "${filePath}"${format === "bin" ? ` ${baseAddr}` : ""} ${verifyOn ? "-v " : ""}-g`
        : `$ pyocd load --target ${target} ${format === "bin" ? `--base-address ${baseAddr} ` : ""}"${filePath}"`,
      "fl-dim",
    );
    try {
      await api.flashStart(args);
    } catch (e) {
      setBusy(false);
      setPhase("");
      pushLog(String(e instanceof Error ? e.message : e), "fl-err");
      showToast(msgOf(e));
    }
  };

  const cancelFlash = async () => {
    try {
      await api.flashCancel();
      pushLog("已请求取消任务…", "fl-dim");
    } catch (e) {
      showToast(msgOf(e));
    }
  };

  const dapProbe = probes.find((p) => p.kind === "daplink");
  const sizeKB = meta ? meta.size_bytes / 1024 : 0;

  return (
    <main className={`page page-flash${active ? " active" : ""}`}>
      {/* 左列三步卡片 */}
      <div className="col-scroll">

        {/* ① 设备 */}
        <SpotlightCard className={`card${activeKind === "daplink" ? " emphasis" : ""}`}>
          <div className="card-head">
            <span className="step-no">1</span>
            <span className="card-title">烧录器设备</span>
            <RefreshButton
              label="刷新设备"
              loading={refreshing || firstProbe}
              onClick={() => void manualRefresh()}
              style={{ marginLeft: "auto" }}
            />
          </div>

          {activeKind && probes.map((p) =>
            p.kind === activeKind ? (
              <div className="dev-row" key={p.kind}>
                <div className="dev-ico">BL</div>
                <div>
                  <div className="dev-name">
                    BubbleLink 三模烧录器 <span className="mode-badge">{p.label}</span>
                  </div>
                  <div className="dev-meta">
                    USB {kindVidPid(p.kind)}
                    {p.hint ? ` · SN ${p.hint.slice(0, 24)}` : ""}
                    {p.count > 1 ? ` · ×${p.count}` : ""}
                  </div>
                </div>
                <span style={{ marginLeft: "auto", color: "var(--green)", fontSize: 13, fontWeight: 600 }}>● 在线</span>
              </div>
            ) : null,
          )}

          {firstProbe && (
            <div className="empty-guide">
              <div className="sk-line w80" />
              <div className="sk-line w60" />
            </div>
          )}

          {!firstProbe && !activeKind && (
            <div className="empty-guide">
              <div className="eg-head">
                <div className="eg-ico">🔍</div>
                <div>
                  <div className="eg-title">未识别到烧录器</div>
                  <div className="eg-sub">按下面三步操作后，徽章会自动亮起（每 2 秒自动探测）</div>
                </div>
              </div>
              <div className="eg-steps">
                <div className="gstep gstep-hl">
                  <span className="n">1</span>
                  <div><div className="t">拨动模式开关</div><div className="d">烧录用 01 · DAPLink</div></div>
                </div>
                <div className="gstep">
                  <span className="n">2</span>
                  <div><div className="t">重新插拔 USB</div><div className="d">必须操作：D+ 上拉固定，需重新枚举</div></div>
                </div>
                <div className="gstep">
                  <span className="n">3</span>
                  <div><div className="t">等徽章亮起 / 点刷新</div><div className="d">右上角按钮可手动刷新</div></div>
                </div>
              </div>
            </div>
          )}

          <div className="mode-strip">
            {(["stlink", "daplink", "bmp"] as const).map((k) => (
              <span key={k} className={`chip${activeKind === k ? " on" : ""}`}>{KIND_LABEL[k]}</span>
            ))}
            <span className="mode-note">
              {activeKind === "bmp"
                ? "BMP 模式请用 gdb/VS Code 连接；本页面烧录请切到 01"
                : activeKind === "stlink"
                  ? "ST-Link 模式：由 STM32CubeProgrammer 引擎驱动，芯片自动识别"
                  : ""}
              {dapProbe && activeKind !== "daplink" ? " · 检测到 11 恢复口也可视作 DAPLink" : ""}
            </span>
          </div>
        </SpotlightCard>

        {/* ② 固件 */}
        <SpotlightCard className="card">
          <div className="card-head">
            <span className="step-no">2</span>
            <span className="card-title">固件文件</span>
            <span className="hint">支持 .hex / .bin / .elf</span>
          </div>
          <div className="file-drop" onClick={() => void pickFile()}>
            <div className="file-ico">{meta ? "⬢" : "📂"}</div>
            {meta ? (
              <div style={{ minWidth: 0 }}>
                <div className="dev-name">
                  {fileName(filePath!)}
                  <span className="fmt-badge">{meta.kind.toUpperCase()}</span>
                </div>
                <div className="dev-meta">
                  {fmtBytes(meta.size_bytes)}
                  {" · "}
                  {meta.kind === "hex" && meta.crc32 !== undefined
                    ? `${fmtAddr(meta.min_addr)} – ${fmtAddr(meta.max_addr)} · 载荷CRC32 ${meta.crc32!.toString(16).toUpperCase().padStart(8, "0")}`
                    : meta.crc32 !== undefined
                      ? `载荷CRC32 ${meta.crc32!.toString(16).toUpperCase().padStart(8, "0")}`
                      : "CRC 计算中"}
                </div>
              </div>
            ) : (
              <div>
                <div className="dev-name">点击选择固件文件</div>
                <div className="dev-meta">或将文件拖入此区域 · HEX 自动解析地址范围与载荷 CRC32</div>
              </div>
            )}
            <button className="ghost-btn" style={{ marginLeft: "auto" }}>
              {meta ? "更换文件" : "浏览…"}
            </button>
          </div>
          {meta?.error && (
            <div style={{ color: "var(--red)", fontSize: 12.5, marginTop: 8 }}>⚠ {meta.error}</div>
          )}
        </SpotlightCard>

        {/* ③ 设置与执行 */}
        <SpotlightCard className="card" style={{ flex: 1 }}>
          <div className="card-head">
            <span className="step-no">3</span>
            <span className="card-title">烧录设置与执行</span>
          </div>
          <div className="opt-row-wrap">
            <span className="opt" style={{ alignItems: "flex-start" }}>
              目标芯片
              <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
                <Dropdown value={target} disabled={busy || activeKind === "stlink"} width={196}
                  options={[
                    { value: "auto", label: "自动识别（连上后探测）" },
                    ...TARGETS.map((t) => ({ value: t, label: t })),
                  ]}
                  onChange={(v) => { setTarget(v); if (v !== "auto") setTInfo(null); }} />
                {activeKind === "stlink" && (
                  <span className="lbl">ST-Link 模式由引擎自动识别芯片，无需选择</span>
                )}
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {target === "auto" && (
                    <button className="link-btn" disabled={probing}
                      onClick={() => { setTInfo(null); void runProbe(); }}>
                      {probing ? <><Spinner size={11} blue />识别中…</> : tInfo?.detected ? "⟳ 重新识别" : "⟳ 手动识别"}
                    </button>
                  )}
                  {target === "auto" && tInfo?.detected && (
                    <span className="auto-badge">✓ {tInfo.guess}</span>
                  )}
                  {target === "auto" && probing && <span className="lbl">正在连接目标读取 ID…</span>}
                  {target === "auto" && tInfo && !tInfo.detected && tInfo.message && (
                    <span className="lbl" style={{ color: "var(--red)" }}>{tInfo.message}</span>
                  )}
                </span>
              </span>
            </span>
            <span className="opt">擦除方式
              <Dropdown small width={118} value={chipErase ? "chip" : "sector"} disabled={busy}
                options={[{ value: "chip", label: "全片擦除" }, { value: "sector", label: "仅扇区擦除" }]}
                onChange={(v) => setChipErase(v === "chip")} />
            </span>
            <label className="chk"><input type="checkbox" checked={verifyOn} disabled={busy}
              onChange={(e) => setVerifyOn(e.target.checked)} />烧后校验</label>
            <span className="lbl">烧录完成后自动复位运行</span>
            {meta?.kind === "bin" && (
              <span className="opt">基地址
                <input className="mini-in" style={{ width: 120 }} value={baseAddr} disabled={busy}
                  onChange={(e) => setBaseAddr(e.target.value)} />
              </span>
            )}
          </div>
          <div className="action-row">
            {!busy ? (
              <button className="btn-flash" onClick={() => void startFlash()} disabled={!canFlash}>
                ⚡ 开始烧录
              </button>
            ) : (
              <button className="btn-cancel" onClick={() => void cancelFlash()}>■ 取消任务</button>
            )}
            <div className="prog-block">
              <div className="prog-top">
                <span className="phase">{busy ? phase || "进行中…" : percent === 100 ? "烧录完成 ✓" : "待执行"}</span>
                <span className="pct">{percent}%</span>
              </div>
              <div className="progress">
                <div className={`progress-bar${busy && percent > 0 && percent < 100 ? " striped" : ""}`}
                  style={{ width: `${percent}%` }} />
              </div>
              <div className="prog-stats">
                {[
                  meta ? `${sizeKB.toFixed(1)} KB` : null,
                  !meta ? "未选择固件" : null,
                  reasonText(activeKind, !!filePath, meta, engineVer, engineErr, target, cliVer, cliErr),
                ].filter(Boolean).join("  ")}
              </div>
              <ProgressRing value={percent} size={54} />
            </div>
          </div>
        </SpotlightCard>
      </div>

      {/* 右栏 */}
      <div className="side">
        <div className="panel">
          <h4>烧录引擎</h4>
          <div className="kv"><span className="k">pyOCD（01 用）</span>
            <span className="v" style={engineErr ? { color: "var(--red)" } : undefined}>
              {engineVer ?? (engineErr ? "未检测" : <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Spinner size={11} blue />检查中</span>)}
            </span>
          </div>
          <div className="kv"><span className="k">CubeProg（00 用）</span>
            <span className="v" style={cliErr ? { color: "var(--red)" } : undefined}>
              {cliVer ?? (cliErr ? "未检测" : <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><Spinner size={11} blue />检查中</span>)}
            </span>
          </div>
          <div className="kv"><span className="k">状态</span>
            <span className="v" style={busy ? undefined : { color: "var(--green)" }}>
              {busy ? "烧录中…" : (activeKind === "stlink" ? cliErr : engineErr) ? "不可用" : "就绪"}
            </span>
          </div>
          {engineErr && activeKind !== "stlink" && (
            <div className="kv"><span className="k" style={{ color: "var(--text-3)" }}>
              执行一次 pip install pyocd 后点刷新设备
            </span></div>
          )}
          {cliErr && activeKind === "stlink" && (
            <div className="kv"><span className="k" style={{ color: "var(--text-3)" }}>
              请安装 STM32CubeProgrammer 后重试
            </span></div>
          )}
        </div>

        <div className="panel">
          <h4>目标芯片</h4>
          <div className="kv"><span className="k">识别结果</span>
            <span className="v" style={tInfo?.detected ? { color: "var(--green)" } : undefined}>
              {tInfo?.detected ? (tInfo.guess.split("（")[0]) : target === "auto" ? "待探测" : "手动指定"}
            </span></div>
          <div className="kv"><span className="k">型号</span><span className="v">{target === "auto" ? "auto" : target.toUpperCase()}</span></div>
          <div className="kv"><span className="k">内核</span><span className="v">Cortex-M3</span></div>
          <div className="kv"><span className="k">Flash</span><span className="v">{tInfo?.flash_kb ? `${tInfo.flash_kb} KB` : "—"}</span></div>
          <div className="kv"><span className="k">DEV_ID</span><span className="v">{tInfo?.dev_id ? `0x${tInfo.dev_id.toString(16).toUpperCase()}` : "—"}</span></div>
          <div className="kv"><span className="k">REV_ID</span><span className="v">{tInfo?.rev_id ? `0x${tInfo.rev_id.toString(16).toUpperCase()}` : "—"}</span></div>
        </div>

        <div className="info-box">
          <ul>
            <li>切换模式后必须重新插拔 USB，设备才会重新枚举</li>
            <li>J_SELF（自身烧录口）与 J_SWD（目标口）不可同时连接</li>
            <li>BMP 模式请用 gdb / VS Code 连接，本页面请切到 01</li>
          </ul>
        </div>
      </div>

      {/* 底部日志 */}
      <div className="card log-card">
        <div className="card-head" style={{ marginBottom: 6 }}>
          <span className="card-title">运行日志</span>
          <button className="ghost-btn" style={{ marginLeft: "auto" }} onClick={() => setLogs([])}>清空</button>
        </div>
        <div className="flash-log-body" ref={logRef}>
          {logs.length === 0 ? (
            <div className="fl-dim">— 引擎输出将显示在这里 —</div>
          ) : (
            logs.map((l, i) => (
              <div key={i} className={l.cls}>{l.text}</div>
            ))
          )}
        </div>
      </div>

      {toast && (
        <Toast item={{ key: toast.key, msg: toast.msg, kind: toast.info ? "ok" : "err" }} />
      )}
    </main>
  );
}

// ---- 小工具 ----

function kindVidPid(kind: ProbeDevice["kind"]): string {
  switch (kind) {
    case "stlink": return "0483:374x";
    case "bmp": return "1d50:6018";
    default: return "0d28:0204";
  }
}

function fileName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p;
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function reasonText(
  kind: "daplink" | "stlink" | "bmp" | null,
  hasFile: boolean,
  meta: FirmwareMeta | null,
  engine: string | null,
  engineErr: string | null,
  target: string,
  cliVer: string | null,
  cliErr: string | null,
): string {
  if (kind === "stlink") {
    if (cliErr) return "未找到 STM32CubeProgrammer";
    if (cliVer === null) return "检查引擎中…";
    if (!hasFile || !meta) return "";
    if (meta.error) return "固件解析异常";
    return "";
  }
  if (engineErr) return "引擎不可用";
  if (engine === null) return "检查引擎中…";
  if (!hasFile || !meta) return "";
  if (meta.error) return "固件解析异常";
  if (kind !== "daplink") return "需切换到 01 DAPLink 模式";
  if (target === "auto") return "等待目标芯片识别…";
  return "";
}
