import { useEffect, useRef, useState } from "react";
import FlashPage from "./pages/FlashPage";
import SerialPage from "./pages/SerialPage";

type TabId = "flash" | "serial";

export default function App() {
  const [tab, setTab] = useState<TabId>("flash");
  // 两个页面常驻挂载、只切换显示：串口会话、录制路径、烧录进度与日志
  // 不因来回切页而丢失（后端任务在页面隐藏期间照常运行并继续上报事件）。
  const [flashLabel, setFlashLabel] = useState<string | null>(null);
  const [serialLabel, setSerialLabel] = useState<string | null>(null);
  const indRef = useRef<HTMLDivElement>(null);
  const btnFlash = useRef<HTMLButtonElement>(null);
  const btnSerial = useRef<HTMLButtonElement>(null);

  const moveInd = () => {
    const btn = tab === "flash" ? btnFlash.current : btnSerial.current;
    if (btn && indRef.current) {
      indRef.current.style.left = `${btn.offsetLeft}px`;
      indRef.current.style.width = `${btn.offsetWidth}px`;
    }
  };
  useEffect(moveInd, [tab]);
  useEffect(() => {
    window.addEventListener("resize", moveInd);
    return () => window.removeEventListener("resize", moveInd);
  });

  // 在线状态与 CDC 徽章跟随"当前页"的标签：烧录页看设备、串口页看连接
  const currentLabel = tab === "flash" ? flashLabel : serialLabel;
  const on = currentLabel !== null;
  const serialOn = tab === "serial" && on;

  return (
    <>
      <div className="aurora" />
      <header className="topbar">
        <div className="logo">⚡</div>
        <span className="app-name title-flow">BubbleLink Studio</span>
        <span className="app-sub">三模烧录器工作站</span>
        <div className="spacer" />
        <div className={`status-pill${on ? "" : " off"}`}>
          <span className={`dot${on ? "" : " off"}`} />
          {currentLabel ?? (tab === "flash" ? "未识别到烧录器" : "串口未连接")}
          {serialOn && <span className="mode-badge">CDC</span>}
        </div>
      </header>

      <nav className="tabs">
        <button ref={btnFlash} className={`tab${tab === "flash" ? " active" : ""}`} onClick={() => setTab("flash")}>
          🔌&nbsp;烧录工作台
        </button>
        <button ref={btnSerial} className={`tab${tab === "serial" ? " active" : ""}`} onClick={() => setTab("serial")}>
          📟&nbsp;串口终端
        </button>
        <button className="tab disabled" title="二期">⚙&nbsp;设置</button>
        <div className="tab-ind" ref={indRef} />
      </nav>

      <FlashPage active={tab === "flash"} onStatusChange={setFlashLabel} />
      <SerialPage active={tab === "serial"} onConnChange={setSerialLabel} />
    </>
  );
}
