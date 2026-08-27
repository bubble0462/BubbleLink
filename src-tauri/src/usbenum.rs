//! 当前在线 USB 设备枚举（Windows cfgmgr32，无第三方依赖）。
//!
//! 用 `CM_Get_Device_ID_ListW` 以 "USB" 枚举器 + `PRESENT` 标志一次性拿到
//! **当前在场**的全部 USB 设备实例 ID（形如 `USB\VID_0483&PID_3748\序列号`，
//! 无幻影残留；复合设备的接口子节点带 `&MI_xx`，跳过后剩下的就是设备本体，
//! 每台设备恰好一条）。
//!
//! 这是探针识别的主来源：像经典 ST-Link/V2（0483:3748）这种只有厂商类
//! 调试接口、既无 CDC 也无 HID 的设备，串口/HID 两路枚举都看不到它，
//! 只有 PnP 枚举能可靠给出存在性。CDC/HID 仅用于补充真实序列号。

/// 在线 USB 设备三元组：(vid, pid, 实例段)。实例段是设备序列号（无序列号时
/// 为 Windows 生成的父实例 ID，形如 `5&2c3cbb7&0&1`）。
#[cfg(windows)]
pub fn present_usb_devices() -> Vec<(u16, u16, String)> {
    const CR_SUCCESS: u32 = 0;
    const CR_BUFFER_SMALL: u32 = 0x1A;
    const CM_GETIDLIST_FILTER_ENUMERATOR: u32 = 0x0000_0001;
    const CM_GETIDLIST_FILTER_PRESENT: u32 = 0x0000_0100;

    #[link(name = "cfgmgr32")]
    extern "system" {
        /// pszFilter="USB"（枚举器名），Buffer 为 REG_MULTI_SZ 的设备实例 ID 表
        fn CM_Get_Device_ID_ListW(
            filter: *const u16,
            buffer: *mut u16,
            buffer_len: u32,
            flags: u32,
        ) -> u32;
    }

    let filter: Vec<u16> = "USB".encode_utf16().chain(Some(0)).collect();
    let mut cap: usize = 8192;
    let list: Vec<u16> = loop {
        let mut buf = vec![0u16; cap];
        let cr = unsafe {
            CM_Get_Device_ID_ListW(
                filter.as_ptr(),
                buf.as_mut_ptr(),
                cap as u32,
                CM_GETIDLIST_FILTER_ENUMERATOR | CM_GETIDLIST_FILTER_PRESENT,
            )
        };
        match cr {
            CR_SUCCESS => break buf,
            CR_BUFFER_SMALL if cap < 1 << 20 => cap *= 2,
            // 其他返回值（服务不可用等）：交给调用方的 CDC/HID 兜底路径
            _ => return Vec::new(),
        }
    };

    // REG_MULTI_SZ：空串结尾；逐条解析 `usb\vid_xxxx&pid_yyyy\实例`
    let mut out = Vec::new();
    let mut start = 0usize;
    while start < list.len() {
        let Some(end) = list[start..].iter().position(|&c| c == 0).map(|i| start + i) else {
            break;
        };
        if end == start {
            break; // 结尾空串
        }
        let id = String::from_utf16_lossy(&list[start..end]);
        start = end + 1;
        // 只取设备本体：`vid_x&pid_y&mi_xx\...` 是复合设备的接口子节点
        if id.to_lowercase().contains("&mi_") {
            continue;
        }
        if let Some(t) = parse_usb_devid(id.trim_start_matches(r"\\?\\")) {
            out.push(t);
        }
    }
    out
}

/// 解析 `usb\vid_xxxx&pid_yyyy\实例`（用 get() 切片，畸形输入不会 panic）。
#[cfg(windows)]
fn parse_usb_devid(lower: &str) -> Option<(u16, u16, String)> {
    let lower = lower.to_lowercase();
    let vid_pos = lower.find("vid_")?;
    let vid = u16::from_str_radix(lower.get(vid_pos + 4..vid_pos + 8)?, 16).ok()?;
    let pid_rel = lower[vid_pos..].find("&pid_")?;
    let pid_abs = vid_pos + pid_rel + 5;
    let rest = &lower[pid_abs..];
    let pid_end = rest.find(|c: char| !c.is_ascii_hexdigit()).unwrap_or(rest.len());
    let pid = u16::from_str_radix(rest.get(..pid_end)?, 16).ok()?;
    let inst = rest[pid_end..].strip_prefix('\\').unwrap_or(&rest[pid_end..]);
    if inst.is_empty() {
        return None;
    }
    Some((vid, pid, inst.to_string()))
}

#[cfg(not(windows))]
pub fn present_usb_devices() -> Vec<(u16, u16, String)> {
    Vec::new()
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn devid_parse() {
        let t = parse_usb_devid(r"USB\VID_0483&PID_3748\066BFF565051494867152252");
        assert_eq!(t, Some((0x0483, 0x3748, "066bff565051494867152252".to_string())));

        // 无序列号设备：实例段是 Windows 生成的父实例 ID
        let t = parse_usb_devid(r"USB\VID_0D28&PID_0204\5&2C3CBB7&0&1");
        assert_eq!(t, Some((0x0d28, 0x0204, "5&2c3cbb7&0&1".to_string())));

        // 畸形/截断输入不 panic、返回 None
        assert_eq!(parse_usb_devid(r"USB\VID_04"), None);
        assert_eq!(parse_usb_devid(""), None);
    }

    /// 实机检查（--nocapture 时打印在场 USB 设备；无 USB 的机器上平凡通过）。
    #[test]
    fn present_devices_sane() {
        let devs = present_usb_devices();
        eprintln!("cfgmgr32 在线 USB 设备数: {}", devs.len());
        for (vid, pid, sn) in &devs {
            eprintln!("  {vid:04x}:{pid:04x} {sn}");
            assert!(!sn.contains('\\'), "实例段不应包含 '\\'");
        }
    }
}
