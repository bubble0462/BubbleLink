/** Tauri IPC 封装：本应用唯一的后端出入口。 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

export interface PortEntry {
  name: string;
  friendly: string;
  vid: number | null;
  pid: number | null;
}

export interface PacketEvent {
  ts_millis: number;
  len: number;
  hex: string; // "A1 B2 C3"
}

export interface SerialDataEvent {
  port: string;
  packets: PacketEvent[];
}

export interface ProbeDevice {
  kind: "stlink" | "daplink" | "bmp";
  label: string;
  hint: string;
  count: number;
}

export interface FirmwareMeta {
  kind: "hex" | "bin" | "elf";
  size_bytes: number;
  crc32?: number;
  min_addr?: number;
  max_addr?: number;
  error?: string;
}

export interface FlashArgs {
  engine: "pyocd" | "stm32cli";
  target: string;
  file: string;
  format: "hex" | "bin" | "elf";
  base_addr?: string | null;
  chip_erase: boolean;
  verify: boolean;
}

export interface TargetInfo {
  detected: boolean;
  dev_id?: number | null;
  rev_id?: number | null;
  flash_kb?: number | null;
  density: string;
  guess: string;
  message?: string | null;
}

function hasTauri(): boolean {
  return !!(window as unknown as { __TAURI_INTERNALS__?: object }).__TAURI_INTERNALS__;
}

async function ipc<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!hasTauri()) throw new Error("请在 BubbleLink Studio 桌面应用中运行");
  return invoke<T>(cmd, args);
}

/** 订阅后端事件，resolve 为取消订阅函数。 */
export function onEvent<T>(name: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  if (!hasTauri()) {
    return Promise.reject(new Error("请在 BubbleLink Studio 桌面应用中运行"));
  }
  return listen<T>(name, (ev) => handler(ev.payload));
}

/** 批量订阅帮助器：统一处理异步竞态——unmount 后才 resolve 的订阅立即被撤销。 */
export function subscribeAll(
  subs: Array<Promise<UnlistenFn>>,
): { cancel: () => void } {
  let alive = true;
  const offs: UnlistenFn[] = [];
  for (const p of subs) {
    p.then(
      (off) => {
        if (alive) offs.push(off);
        else off();
      },
      () => {
        /* 桌面外环境 */
      },
    );
  }
  return {
    cancel: () => {
      alive = false;
      offs.forEach((o) => o());
    },
  };
}

export const api = {
  listPorts: (): Promise<PortEntry[]> => ipc<PortEntry[]>("cmd_list_ports"),

  openPort: (name: string, baud: number, gapMs: number): Promise<{ name: string }> =>
    ipc("cmd_open_port", { name, baud, gapMs }),

  closePort: (): Promise<void> => ipc("cmd_close_port"),

  send: (data: Uint8Array): Promise<number> => ipc("cmd_send", { data: Array.from(data) }),

  setPins: (dtr: boolean, rts: boolean): Promise<void> =>
    ipc("cmd_set_pins", { dtr, rts }),

  startCapture: (path: string): Promise<void> => ipc("cmd_start_capture", { path }),

  stopCapture: (): Promise<number> => ipc("cmd_stop_capture"),

  settingsGet: (): Promise<Record<string, unknown>> => ipc("cmd_settings_get"),

  settingsSave: (patch: Record<string, unknown>): Promise<void> =>
    ipc("cmd_settings_save", { value: patch }),

  writeTextFile: (path: string, content: string): Promise<void> =>
    ipc("cmd_write_text_file", { path, content }),

  // ---- 烧录 ----

  identifyProbes: (): Promise<ProbeDevice[]> => ipc("cmd_identify_probes"),

  pyocdCheck: (): Promise<string> => ipc("cmd_pyocd_check"),

  stm32cliCheck: (): Promise<string> => ipc("cmd_stm32cli_check"),

  firmwareMeta: (path: string): Promise<FirmwareMeta> =>
    ipc("cmd_firmware_meta", { path }),

  flashStart: (args: FlashArgs): Promise<void> => ipc("cmd_flash_start", { args }),

  flashCancel: (): Promise<void> => ipc("cmd_flash_cancel"),

  probeTarget: (): Promise<TargetInfo> => ipc("cmd_probe_target"),
};
