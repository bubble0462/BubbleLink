/** Tauri IPC 封装：本应用唯一的后端出入口。 */

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
  const core = await import("@tauri-apps/api/core");
  return core.invoke<T>(cmd, args);
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
