import { useEffect, useRef, useState } from "react";
import FlashPage from "./pages/FlashPage";
import SerialPage from "./pages/SerialPage";

type TabId = "flash" | "serial";

export default function App() {
  const [tab, setTab] = useState<TabId>("flash");
  const [connLabel, setConnLabel] = useState<string | null>(null);
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

  return (
    <>
      <div className="aurora" />
      <header className="topbar">
        <div className="logo">⚡</div>
        <span className="app-name title-flow">BubbleLink Studio</span>
        <span className="app-sub">三模烧录器工作站</span>
        <div className="spacer" />
        <div className={`status-pill${connLabel ? "" : " off"}`}>
          <span className={`dot${connLabel ? "" : " off"}`} />
          {connLabel ?? "未连接设备"}
          {connLabel && <span className="mode-badge">CDC</span>}
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

      {tab === "flash"
        ? <FlashPage onStatusChange={setConnLabel} />
        : <SerialPage onConnChange={setConnLabel} />}
    </>
  );
}
