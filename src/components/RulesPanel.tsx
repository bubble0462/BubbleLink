import { useState } from "react";
import type { HighlightRule, RuleColor } from "../rules";
import { COLOR_HEX, DEFAULT_RULES } from "../rules";

interface Props {
  rules: HighlightRule[];
  onChange: (rules: HighlightRule[]) => void;
}

const COLORS: RuleColor[] = ["red", "amber", "green", "blue"];
const COLOR_NAME: Record<RuleColor, string> = {
  red: "红",
  amber: "琥珀",
  green: "绿",
  blue: "蓝",
};

export default function RulesPanel({ rules, onChange }: Props) {
  const [adding, setAdding] = useState(false);
  const [pattern, setPattern] = useState("");
  const [color, setColor] = useState<RuleColor>("red");

  const addRule = () => {
    const p = pattern.trim();
    if (!p) return;
    try {
      new RegExp(p);
    } catch {
      alert("正则表达式无效");
      return;
    }
    onChange([...rules, { id: `u-${Date.now()}`, pattern: p, color }]);
    setPattern("");
    setAdding(false);
  };

  const delRule = (id: string) => {
    onChange(rules.filter((r) => r.id !== id));
    if (!rules.find((r) => r.id === id)?.builtin && rules.length <= DEFAULT_RULES.length) {
      // 全部自定义规则删完时无特殊处理
    }
  };

  return (
    <div className="panel">
      <h4>高亮规则（按顺序优先命中）</h4>
      {rules.map((r) => (
        <div className="rule-row" key={r.id}>
          <span className="rule-dot" style={{ background: COLOR_HEX[r.color] }} />
          <code>{r.pattern}</code>
          {!r.builtin && (
            <button className="rule-del" title="删除规则" onClick={() => delRule(r.id)}>
              ✕
            </button>
          )}
        </div>
      ))}
      {!adding && (
        <button className="add-rule" onClick={() => setAdding(true)}>
          ＋ 添加规则（支持正则，持久保存）
        </button>
      )}
      {adding && (
        <div>
          <div className="rule-add">
            <input
              autoFocus
              value={pattern}
              placeholder="正则，如 TIMEOUT|0x[0-9A-F]{6}"
              onChange={(e) => setPattern(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addRule()}
            />
            <select
              className="sel-sm"
              value={color}
              onChange={(e) => setColor(e.target.value as RuleColor)}
            >
              {COLORS.map((c) => (
                <option key={c} value={c}>
                  {COLOR_NAME[c]}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="mini-act" onClick={addRule}>
              确定
            </button>
            <button className="mini-act" onClick={() => setAdding(false)}>
              取消
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
