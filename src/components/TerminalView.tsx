import { useEffect, useMemo, useRef } from "react";
import type { Compiled } from "../rules";
import { styleLine } from "../rules";

export interface TermLine {
  ts: number; // 到达时刻 ms
  bytes: Uint8Array;
  sys?: string; // 系统错误行（不参与字节解码）
}

interface Props {
  lines: TermLine[]; // 待显示切片
  hexDisplay: boolean;
  showTs: boolean;
  showLen: boolean;
  encoding: "utf8" | "gbk";
  compiled: Compiled[];
  filterRe: RegExp | null;
  connected: boolean;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

function fmtTs(ms: number): string {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const DISPLAY_MAX = 1500;

export default function TerminalView(props: Props) {
  const boxRef = useRef<HTMLDivElement>(null);
  const { lines, hexDisplay, showTs, showLen, encoding, compiled, filterRe, connected } = props;

  const decoder = useMemo(() => {
    try {
      return new TextDecoder(encoding === "gbk" ? "gbk" : "utf-8");
    } catch {
      return new TextDecoder("utf-8");
    }
  }, [encoding]);

  useEffect(() => {
    const el = boxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  });

  // 组装显示 HTML
  const html = useMemo(() => {
    const view = lines.slice(-DISPLAY_MAX);
    const rows: string[] = [];
    for (const line of view) {
      if (line.sys !== undefined) {
        rows.push(`<div class="sys-line">‼ ${escapeOnly(line.sys)}</div>`);
        continue;
      }
      let body: string;
      if (hexDisplay) {
        body = spacedHex(line.bytes);
      } else {
        body = decodeLossy(decoder, line.bytes);
      }
      const segs = body.replace(/\r/g, "").split("\n");
      while (segs.length > 1 && segs[segs.length - 1] === "") segs.pop();
      for (const seg of segs) {
        if (filterRe && !filterRe.test(seg)) continue;
        const styled = styleLine(seg, compiled);
        const ts = showTs ? `<span class="ts">${fmtTs(line.ts)}</span>` : "";
        const lenMark =
          showLen && !hexDisplay ? `<span class="ts">[${line.bytes.length}]</span>` : "";
        rows.push(`<div class="${styled.cls}">${ts}${lenMark}${styled.html}</div>`);
      }
    }
    const head = `<div class="dim-note">— 仅渲染最近 ${DISPLAY_MAX} 行（完整缓冲在后台保留并可导出）</div>`;
    const cur = connected ? '<span class="cur"></span>' : "";
    return head + rows.join("") + cur;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lines, hexDisplay, showTs, showLen, encoding, compiled, filterRe, connected]);

  return (
    <div className="term-wrap-main" ref={boxRef} dangerouslySetInnerHTML={{ __html: html }} />
  );
}

function escapeOnly(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** WebView 的 TextDecoder 非严格模式自动替换非法字节，等效 lossy。 */
function decodeLossy(decoder: TextDecoder, bytes: Uint8Array): string {
  return decoder.decode(bytes).replace(/\uFFFD/g, "�");
}

function spacedHex(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) {
    s += (i > 0 ? " " : "") + bytes[i].toString(16).toUpperCase().padStart(2, "0");
  }
  return s;
}
