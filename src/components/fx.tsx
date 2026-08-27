/**
 * 视觉组件层：从个人组件库（前端/universal/…）移植实现，配色统一适配蓝白主题。
 *  - SpotlightCard  ← hover-glow-card（鼠标跟随光斑，蓝色淡光斑）
 *  - ProgressRing   ← progress（SVG 环形进度，蓝渐变描边）
 *  - Spinner        ← spinners（内联小转圈，白色/蓝色两种）
 *  - CountUp        ← count-up（数字滚动，rAF 缓出，零依赖）
 *  - Toast          ← toast（右上角滑入毛玻璃提示，浅色版）
 */

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";

/* ---------------- 光斑卡片 ---------------- */

interface SpotlightProps {
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
  onClick?: () => void;
}

export function SpotlightCard({ className = "", style, children, onClick }: SpotlightProps) {
  const ref = useRef<HTMLDivElement>(null);
  const onMove = (e: MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--mx", `${e.clientX - r.left}px`);
    el.style.setProperty("--my", `${e.clientY - r.top}px`);
  };
  return (
    <div ref={ref} onMouseMove={onMove} onClick={onClick} className={`spot-card ${className}`} style={style}>
      {children}
    </div>
  );
}

/* ---------------- 环形进度 ---------------- */

export function ProgressRing({
  value,
  size = 54,
  stroke = 6,
}: {
  value: number;
  size?: number;
  stroke?: number;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const [gid] = useState(() => `rg${Math.random().toString(36).slice(2, 8)}`);
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div className="ring-wrap" style={{ width: size, height: size }} title={`总进度 ${Math.round(pct)}%`}>
      <svg width={size} height={size} className="ring-svg">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#1668dc" />
            <stop offset="100%" stopColor="#3c85ff" />
          </linearGradient>
        </defs>
        <circle className="ring-bg" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        <circle
          className="ring-fg"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          stroke={`url(#${gid})`}
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct / 100)}
        />
      </svg>
      <span className="ring-num" style={{ fontSize: Math.round(size / 4.4) }}>
        {Math.round(pct)}%
      </span>
    </div>
  );
}

/* ---------------- 内联小转圈 ---------------- */

export function Spinner({ size = 13, blue = false }: { size?: number; blue?: boolean }) {
  return (
    <span
      className={`spinner-inline${blue ? " spinner-blue" : ""}`}
      style={{ width: size, height: size }}
    />
  );
}

/* ---------------- 数字滚动 ---------------- */

export function CountUp({
  value,
  format = (v: number) => String(Math.round(v)),
  dur = 500,
}: {
  value: number;
  format?: (v: number) => string;
  dur?: number;
}) {
  const [disp, setDisp] = useState(value);
  const fromRef = useRef(value);
  const rafRef = useRef(0);

  useEffect(() => {
    const from = fromRef.current;
    const to = value;
    if (from === to) return;
    const t0 = performance.now();
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      setDisp(from + (to - from) * eased);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(step);
      } else {
        fromRef.current = to;
      }
    };
    rafRef.current = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafRef.current);
  }, [value, dur]);

  return <>{format(disp)}</>;
}

/* ---------------- Toast（右上角滑入） ---------------- */
export interface ToastData {
  key: number;
  msg: string;
  kind: "ok" | "err" | "info";
}

export function Toast({ item }: { item: ToastData | null }) {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!item) return;
    setShown(false);
    const raf = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(raf);
  }, [item]);
  if (!item) return null;
  const dot =
    item.kind === "ok" ? "var(--green)" : item.kind === "err" ? "var(--red)" : "var(--primary)";
  return (
    <div className="toast-wrap">
      <div className={`toast2${shown ? " is-in" : ""}`} role="status">
        <span className="t-dot" style={{ background: dot, boxShadow: `0 0 8px ${dot}` }} />
        <span className="t-msg">{item.msg}</span>
      </div>
    </div>
  );
}

/* ---------------- 圆形刷新按钮 ← refresh-button（Lucide refresh-cw 图标，浅色蓝白版） ---------------- */

function RefreshIcon() {
  return (
    <svg
      className="rf-icon"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  );
}

export function RefreshButton({
  loading,
  onClick,
  label,
  disabled,
  small,
  style,
}: {
  loading: boolean;
  onClick?: () => void;
  label?: string;
  disabled?: boolean;
  small?: boolean;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      aria-label={label ?? "刷新"}
      aria-busy={loading}
      disabled={loading || disabled}
      style={style}
      className={`rf-btn${label ? " has-text" : ""}${small ? " rf-sm" : ""}${loading ? " is-loading" : ""}`}
      onClick={loading || disabled ? undefined : onClick}
    >
      <RefreshIcon />
      {label && <span>{label}</span>}
    </button>
  );
}

/* ---------------- 自定义下拉 ← select-dropdown（含键盘 ↑↓ Enter ESC） ---------------- */

export interface DropdownOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export function Dropdown({
  value,
  options,
  onChange,
  disabled,
  width,
  small,
  placeholder,
}: {
  value: string;
  options: DropdownOption[];
  onChange: (v: string) => void;
  disabled?: boolean;
  width?: number;
  small?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState({ top: 0, left: 0, width: 240, up: false });
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const selIdx = options.findIndex((o) => o.value === value);

  const openMenu = () => {
    if (disabled) return;
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const est = Math.min(260, options.length * 36 + 14);
    const up = window.innerHeight - r.bottom < est + 12 && r.top > est + 12;
    setPos({ left: r.left, width: r.width, top: up ? r.top - est - 6 : r.bottom + 6, up });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    // 键盘焦点落在当前选中项；没有则第一个可用项
    let idx = selIdx;
    if (idx < 0) for (let i = 0; i < options.length; i++) if (!options[i].disabled) { idx = i; break; }
    setActive(idx);

    // 依据触发框当前位置摆放菜单；返回 null 表示触发框已滚出视野
    const updatePos = (): boolean => {
      const el = ref.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      if (r.bottom < 0 || r.top > window.innerHeight) return false;
      const est = Math.min(260, options.length * 36 + 14);
      const up = window.innerHeight - r.bottom < est + 12 && r.top > est + 12;
      setPos({ left: r.left, width: r.width, top: up ? r.top - est - 6 : r.bottom + 6, up });
      return true;
    };
    if (!updatePos()) {
      setOpen(false);
      return;
    }
    const onDoc = (e: globalThis.MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || menuRef.current?.contains(t)) return;
      setOpen(false);
    };
    // 页面滚动/缩放时跟随重定位；菜单自身滚动（e.target 在菜单内）不干预
    const onScroll = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      if (!updatePos()) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pick = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpen(false);
  };

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (disabled) return;
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const dir = e.key === "ArrowDown" ? 1 : -1;
      let i = active;
      for (let n = 0; n < options.length; n++) {
        i = (i + dir + options.length) % options.length;
        if (!options[i].disabled) break;
      }
      setActive(i);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(active);
    }
  };

  const current = options.find((o) => o.value === value);
  const menu = (
    <div
      ref={menuRef}
      className={`dd-menu dd-menu--portal${open ? " dd-open" : ""}`}
      role="listbox"
      style={{ top: pos.top, left: pos.left, width: Math.max(pos.width, 200), transform: pos.up ? "translateY(4px)" : undefined }}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="option"
          aria-selected={o.value === value}
          className={`dd-option${o.value === value ? " is-selected" : ""}${i === active ? " is-active" : ""}${o.disabled ? " is-disabled" : ""}`}
          disabled={o.disabled}
          onMouseEnter={() => setActive(i)}
          onClick={() => pick(i)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );

  return (
    <div
      ref={ref}
      className={`dd${small ? " dd-sm" : ""}${open ? " dd-open" : ""}`}
      style={width ? { width } : undefined}
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="dd-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : openMenu())}
      >
        <span className={`dd-value${current ? "" : " is-placeholder"}`}>
          {current ? current.label : placeholder ?? "请选择"}
        </span>
        <span className="dd-arrow">▼</span>
      </button>
      {createPortal(open ? menu : null, document.body)}
    </div>
  );
}
