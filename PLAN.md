# BubbleLink Studio · 三模烧录器上位机 实施计划

> 配套效果图：`mockup/page1_flash.png`（烧录工作台）、`mockup/page2_serial.png`（串口终端）
> 效果图源码：`mockup/index.html`（可直接双击在浏览器打开，Tab 可切换两页）
> 视觉基调：**蓝白简洁主题**——白卡片 + 浅蓝灰页面底，主色蓝 #1668dc；绿色 #16a34a 只用于成功/在线状态；红色 #e5484d 只用于报错（含终端 ERROR 高亮与 ERROR 统计）；WARN 在终端内用琥珀色区分。串口终端区为深藏青底（#0f1a30）保证彩色日志可读性。
> 组件实现参考 `前端/` 组件库（glass-card、progress、tabs、toggle-switch 等实现方式），视觉不沿用其紫青渐变色。

---

## 0. 技术选型结论：Tauri 2（Rust 壳）+ React

**为什么换掉 Electron**：应用对三个候选来说都是 WebView 显示同一套 React 页面，烧录又固定走外部引擎（CubeProgrammer CLI / pyOCD CLI），宿主语言不影响核心能力。此时差异只剩资源占用：

| | Electron | **Tauri 2 ✅** |
|---|---|---|
| 安装包 | ~90 MB | **~10–20 MB** |
| 典型内存占用 | ~200–280 MB | **~70–120 MB** |
| 渲染层 | 自带 Chromium | 系统 WebView2（Win10/11 内置） |
| 后端语言 | Node.js | Rust |

**本机前置条件（已逐项核实，全部就绪）**：rustc/cargo 1.95.0（stable-x86_64-pc-windows-msvc）、VS2022 Community 含 MSVC C++ 工具链（`D:\app\Microsoft Visual Studio\2022\Community`）、WebView2 运行时 151.x。

**接受的真实弊端**（换来的就是低内存小体积）：
1. 编译迭代慢于 JS：改后端代码后 cargo 重编需要数十秒级（增量），首次构建数分钟
2. Rust 串口/USB 生态（serialport、nusb）可用但轮子少，Windows 特殊问题资料少
3. 后续自行维护门槛高于 JS —— 用"模块小而清晰"缓解

## 1. 目标与范围

一个 Windows 桌面应用（Tauri 2），两个页面：

| 页面 | 功能 |
|---|---|
| ① 烧录工作台 | 识别三模烧录器当前模式（ST-Link / DAPLink / BMP）→ 选择固件文件（.hex/.bin/.elf）→ 一键烧录到**目标板**（擦除→写入→校验→复位运行），带进度与日志。布局参考 STM32CubeProgrammer |
| ② 串口终端 | 枚举串口 → 连接烧录器 CDC 串口（↔ 目标板 USART1 PA9/PA10）→ 实时日志高亮 + **串口助手全套功能**（见 §4.2） |

**本期不做**（二期）：烧录器自身固件升级（11 恢复模式自刷机）、BMP gdb 集成、内存读写编辑器、多设备管理。

## 2. 总体架构

```
┌────────────────────────────────────────────────────┐
│  BubbleLink Studio.exe（Tauri 2，单进程宿主）        │
│  ┌──────────────────────────────────────────┐      │  invoke / event / Channel
│  │ WebView2  React + TypeScript（Vite 构建）  │◄────┼───────────────────┐
│  │ 页面1 烧录工作台    页面2 串口终端          │      │                   │
│  └──────────────────────────────────────────┘      │                   │
│  ┌──────────────────────────────────────────┐      │                   │
│  │ Rust 核心（src-tauri）                    │──────┘                   │
│  │  · serialsrv   tokio 串口服务             │                          │
│  │  · identify    USB 枚举识别模式（nusb）    │                          │
│  │  · flasher     烧录调度（spawn 子进程）    │──► 外部烧录引擎            │
│  │  · settings    tauri-plugin-store         │    见下方映射表            │
│  └──────────────────────────────────────────┘                           │
└────────────────────────────────────────────────────────────────────────┘
```

烧录引擎映射（按烧录器开关模式自动选择，VID/PID 识别）：

| 开关 | 模式 | USB 枚举 | 烧录引擎 |
|---|---|---|---|
| 00 | ST-Link | `0483:3748`（非 CDC 设备，需 USB 层枚举） | **STM32CubeProgrammer CLI**（官方不抢驱动；机器已装，自动探测路径） |
| 01 | DAPLink | `0d28:0204`（DAP+CDC 复合） | 首选 **pyOCD CLI**（`pip install pyocd` 一次装好，F103 内置算法）；备选捆绑 OpenOCD 免 Python |
| 10 | BMP | `1d50:6018` | 本期不驱动，检测到则提示切到 01（BMP 走 gdb/VS Code） |
| 11 | 恢复 DAP | 同 DAPLink（接 J_SELF） | 二期：给烧录器自己刷固件（自升级/救砖） |

流程状态机：`扫描设备 → 识别模式 → 连接目标(SWD 读 IDCODE/芯片名) → 解析固件 → 擦除 → 写入(进度回调) → 校验 → 复位运行`

固件支持：`.hex`（Intel HEX 解析地址范围+CRC32）、`.bin`（默认基址 0x08000000 可改）、`.elf`。

## 3. 页面设计

### 3.1 页面 1 · 烧录工作台（mockup/page1_flash.png）
顶栏（应用名 + 设备状态胶囊含模式徽章）；主区三步卡片：① 烧录器设备（识别结果 + 00/01/10/11 模式条；未识别时变引导）；② 固件文件（拖拽选择，显示大小/地址范围/CRC32）；③ 设置与执行（擦除方式/校验/复位 + 大按钮 + 条纹进度条 + 速度）；右栏：烧录器信息 / 目标芯片 / 注意事项；底部运行日志条。

### 3.2 页面 2 · 串口终端（mockup/page2_serial.png）——串口助手全套
参考 XCOM/SSCOM 功能集现代化实现：
- **接收侧**：文本/HEX 显示切换；时间戳；分包显示+超时 ms（按字节间隙 20ms 切逻辑包）；高亮规则（内置 ERROR 红/WARN 琥珀/OK·RDY 绿/地址数值蓝 + 自定义正则持久化）；关键字过滤；保存数据（可见日志导出）/接收数据到文件（原始字节流边收边落盘）；会话统计（行数/ERROR/WARN/RX 字节）
- **发送侧**：文本/HEX 发送；加回车换行；加校验（None/SUM/CRC8/CRC16-MODBUS 帧尾附加）；定时发送（周期 ms/次循环发）；发送历史 ↑↓
- **连接侧**：端口枚举带描述、波特率 9600–921600、编码 UTF-8/GBK、DTR/RTS 手动控制、状态栏

## 4. 关键技术点

- **流式推送**：Rust 端 serialport 读线程按 50ms 窗口聚合，经 Tauri Channel 推给前端；前端环形缓冲保留最近 10 万行 + 虚拟列表渲染；"暂停滚动"只冻结视图不丢数据
- **落盘**：接收数据到文件用带缓冲的独立写入任务，不阻塞读线程
- **HEX 解析**：Rust 实现 Intel HEX parser，得到地址范围/CRC32
- **烧录进度**：子进程 stdout 行解析（每引擎一个 parser，归一化 `{phase, percent}` 事件）；完成后回读 CRC 校验
- **热插拔**：轮询 serialport::available_ports + nusb USB 枚举（nusb 仅枚举不需要驱动配合）
- **设置持久化**：tauri-plugin-store（波特率/规则/校验方式/定时周期/窗口尺寸）
- **安全模型**：capability 白名单，仅注册所需 invoke 命令

## 5. 里程碑

| 阶段 | 内容 | 验收标准 |
|---|---|---|
| **M1 串口终端完整版** | Tauri 工程 + Rust 串口服务 + 终端页全功能（HEX 收发/时间戳/分包/过滤/高亮规则/定时发送/加校验/双路保存/统计） | 连上烧录器 CDC 口跑通全部功能项 |
| **M2 烧录工作台（DAPLink）** | 设备识别 + pyOCD 引擎 + 三步 UI + 进度 | 拨 01 给 F103 目标板烧 demo 成功并复位运行 |
| **M3 ST-Link 支持** | CubeProgrammer CLI 引擎接入 | 拨 00 同样能烧 |
| **M4 打磨打包** | tauri-bundler 出 NSIS 安装包 + 便携 exe；引导页；（可选二期）恢复模式自升级 | 双击安装即用 |

## 6. 目录结构（规划）

```
LINK/host_app/
├── PLAN.md                ← 本文档
├── mockup/                ← 效果图
├── package.json           # 仅前端工具链：vite + react + ts + @tauri-apps/cli
├── index.html  vite.config.ts  tailwind(可选)
├── src/                   # 渲染层 React
│   ├── pages/FlashWorkbench/
│   ├── pages/SerialMonitor/   # Terminal / RecvOptions / SendBar / RulePanel
│   ├── components/            # Card/Tabs/Toggle/Progress/Toast
│   └── api.ts                 # invoke/event 封装（唯一 IPC 出入口）
└── src-tauri/             # Rust 后端
    ├── Cargo.toml  tauri.conf.json  capabilities/
    ├── icons/
    └── src/
        ├── main.rs        # 入口/窗口/命令注册
        ├── serialsrv.rs   # 串口服务（聚合分包/落盘/DTR RTS）
        ├── identify.rs    # nusb + serialport 枚举 → 模式识别
        ├── flasher/       # mod.rs engine_pyocd.rs engine_stm32cli.rs hexfile.rs
        └── settings.rs    # store 封装
```

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| ST-Link 的 ST 驱动被 libusb/Zadig 抢占 | 模式 00 只走官方 CLI；nusb 只做**枚举**不需要接管驱动 |
| pyOCD 依赖 Python 环境 | 文档写明 `pip install pyocd` 一次；或改捆绑 OpenOCD 实现零依赖 |
| cargo 首次构建慢/体积大（debug 模式） | 平时用 debug 迭代，发布用 release；Tauri release 单体几 MB～十几 MB 正常 |
| 两套 CLI 输出格式不同 | 每引擎独立 parser，统一进度事件模型 |
| 串口长跑内存膨胀 | 环形缓冲 + 虚拟滚动 + 单行截断 |
| BMP 模式无常规库 | UI 明确降级提示 |
