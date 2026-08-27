/** 终端高亮规则：内置 + 用户自定义正则。命中 → 整行着色 + 关键词加粗（可跨多色）。 */

export type RuleColor = "red" | "amber" | "green" | "blue";

export interface HighlightRule {
  id: string;
  pattern: string;
  color: RuleColor;
  builtin?: boolean;
}

export const DEFAULT_RULES: HighlightRule[] = [
  { id: "builtin-error", pattern: "ERROR|FAIL|WRP|断言失败", color: "red", builtin: true },
  { id: "builtin-warn", pattern: "WARN", color: "amber", builtin: true },
  { id: "builtin-ok", pattern: "\\bOK\\b|\\bRDY\\b|成功", color: "green", builtin: true },
  { id: "builtin-num", pattern: "0x[0-9A-Fa-f]{4,}", color: "blue", builtin: true },
];

export const COLOR_HEX: Record<RuleColor, string> = {
  red: "#e5484d",
  amber: "#e88a1a",
  green: "#16a34a",
  blue: "#1668dc",
};

const ROW_CLASS: Record<RuleColor, string> = {
  red: "row-hl-red",
  amber: "row-hl-amber",
  green: "row-hl-green",
  blue: "row-hl-blue",
};

export interface Compiled {
  color: RuleColor;
  cls: string;
  reRow: RegExp; // 不区分大小写，测试整行
  reScan: RegExp; // 全局，扫描关键词位置
}

export function compileRules(rules: HighlightRule[]): Compiled[] {
  const out: Compiled[] = [];
  for (const r of rules) {
    try {
      const flags = r.id === "builtin-ok" || r.id === "builtin-error" || r.id === "builtin-warn"
        ? "gi"
        : /^\^.*\$/.test(r.pattern)
          ? ""
          : /\\b/.test(r.pattern)
            ? "g"
            : "gi";
      out.push({
        color: r.color,
        cls: ROW_CLASS[r.color],
        reRow: new RegExp(r.pattern, flags.replace("g", "")),
        reScan: new RegExp(r.pattern, flags.includes("g") ? flags : flags + "g"),
      });
    } catch {
      // 非法正则的规则直接忽略
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface Styled {
  cls: string;
  html: string;
}

/** 整行渲染：确定行着色类 + 关键词加粗。 */
export function styleLine(text: string, compiled: Compiled[]): Styled {
  let cls = "";
  const ranges: Array<[number, number]> = [];
  for (const c of compiled) {
    c.reScan.lastIndex = 0;
    if (!c.reRow.test(text)) continue;
    if (!cls) cls = c.cls;
    c.reScan.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = c.reScan.exec(text))) {
      if (m[0].length === 0) break;
      ranges.push([m.index, m.index + m[0].length]);
      if (ranges.length > 200) break;
    }
  }
  if (ranges.length === 0) return { cls, html: escapeHtml(text) };
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([...r]);
  }
  let html = "";
  let pos = 0;
  for (const [s, e] of merged) {
    html += escapeHtml(text.slice(pos, s));
    html += `<b>${escapeHtml(text.slice(s, e))}</b>`;
    pos = e;
  }
  html += escapeHtml(text.slice(pos));
  return { cls, html };
}

/** 统计某颜色规则的命中次数（用于 ERROR/WARN 计数）。 */
export function countColor(text: string, compiled: Compiled[], color: RuleColor): number {
  let n = 0;
  for (const c of compiled) {
    if (c.color !== color) continue;
    c.reScan.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = c.reScan.exec(text))) {
      if (m[0].length === 0) break;
      n++;
    }
    if (n > 0) return n > 0 ? n : 0;
  }
  return n;
}
