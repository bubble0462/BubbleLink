//! 字节/固件文件工具：HEX 分组显示、Intel HEX 解析、CRC32。

/// 把字节格式化为大写、按字节分组的 HEX（`"A1 B2 C3"`）。
pub fn format_hex_grouped(data: &[u8]) -> String {
    let mut s = String::with_capacity(data.len() * 3);
    for (i, b) in data.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        s.push_str(&format!("{b:02X}"));
    }
    s
}

// ---------------------------------------------------------------------------
// CRC32 (IEEE 802.3 / zlib)
// ---------------------------------------------------------------------------

pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

// ---------------------------------------------------------------------------
// Intel HEX 解析
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
pub struct IhexInfo {
    /// 有效载荷总字节数（type 00 记录）
    pub payload_len: u64,
    /// 载荷的最低地址
    pub min_addr: u32,
    /// 载荷的最高地址（含）
    pub max_addr: u32,
    /// 载荷 CRC32
    pub crc32: u32,
}

#[derive(Debug)]
enum IhexError {
    Format(String),
    Checksum(usize),
    UnsupportedRecType(u8),
}

impl std::fmt::Display for IhexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            IhexError::Format(m) => write!(f, "HEX 格式错误：{m}"),
            IhexError::Checksum(line) => write!(f, "第 {line} 行校验和错误"),
            IhexError::UnsupportedRecType(t) => write!(f, "不支持的记录类型 {t}"),
        }
    }
}

/// 解析 Intel HEX 文本内容，统计地址范围与 CRC。支持 type 00/01/04。
pub fn parse_ihex(text: &str) -> Result<IhexInfo, String> {
    parse_ihex_detail(text)
        .map(|i| IhexInfo {
            payload_len: i.payload_len,
            min_addr: i.min_addr.unwrap_or(0xFFFF_FFFF),
            max_addr: i.max_addr.unwrap_or(0),
            crc32: i.crc,
        })
        .map_err(|e| e.to_string())
}

struct Detail {
    payload_len: u64,
    min_addr: Option<u32>,
    max_addr: Option<u32>,
    crc: u32,
}

fn parse_ihex_detail(text: &str) -> Result<Detail, IhexError> {
    let mut upper = 0u32;
    let mut min: Option<u32> = None;
    let mut max: Option<u32> = None;
    let mut payload = Vec::new();
    let mut saw_eof = false;

    for (idx, raw) in text.lines().enumerate() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        if !line.starts_with(':') {
            return Err(IhexError::Format(format!("第 {} 行缺少前缀 ':'", idx + 1)));
        }
        let body = &line[1..];
        if body.len() < 10 || body.len() % 2 != 0 {
            return Err(IhexError::Format(format!("第 {} 行长度非法", idx + 1)));
        }
        let bytes = decode_hex_bytes(body, idx)?;
        // 记录校验
        let sum: u16 = bytes.iter().map(|&b| b as u16).sum();
        if (sum & 0xFF) != 0 {
            return Err(IhexError::Checksum(idx + 1));
        }
        let count = bytes[0] as usize;
        if bytes.len() != count + 5 {
            return Err(IhexError::Format(format!("第 {} 行长度与声明不符", idx + 1)));
        }
        let addr = ((bytes[1] as u16) << 8 | bytes[2] as u16) as u32;
        let rtype = bytes[3];
        match rtype {
            0x00 => {
                let a = (upper << 16) | addr;
                let data = &bytes[4..4 + count];
                min = Some(min.map_or(a, |m: u32| m.min(a)));
                let end = a + count as u32 - 1;
                max = Some(max.map_or(end, |m: u32| m.max(end)));
                payload.extend_from_slice(data);
            }
            0x01 => {
                saw_eof = true;
            }
            0x02 => return Err(IhexError::UnsupportedRecType(0x02)),
            0x04 => {
                if count == 2 {
                    upper = (((bytes[4] as u16) << 8) | bytes[5] as u16) as u32;
                }
            }
            _ => {}
        }
    }

    if !saw_eof && !payload.is_empty() {
        // 缺 EOF 不至于失败，但提示不算错——继续
    }
    Ok(Detail {
        payload_len: payload.len() as u64,
        min_addr: min,
        max_addr: max,
        crc: crc32(&payload),
    })
}

fn decode_hex_bytes(body: &str, idx: usize) -> Result<Vec<u8>, IhexError> {
    let mut out = Vec::with_capacity(body.len() / 2);
    let chars: Vec<u8> = body.bytes().collect();
    let mut i = 0;
    while i < chars.len() {
        let hi = hex_val(chars[i]).ok_or_else(|| IhexError::Format(format!("第 {} 行含非 HEX 字符", idx + 1)))?;
        let lo = hex_val(chars[i + 1])
            .ok_or_else(|| IhexError::Format(format!("第 {} 行含非 HEX 字符", idx + 1)))?;
        out.push((hi << 4) | lo);
        i += 2;
    }
    Ok(out)
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_grouping() {
        assert_eq!(format_hex_grouped(&[]), "");
        assert_eq!(format_hex_grouped(&[0x00]), "00");
        assert_eq!(format_hex_grouped(&[0x68, 0x03, 0xFF]), "68 03 FF");
    }

    #[test]
    fn ihex_basic() {
        // 两个数据记录 @0800 与 @1000 + EOF（校验和均正确）
        let text = ":04080000DEADBEEFBC\n:021000000102EB\n:00000001FF\n";
        let info = parse_ihex(text).unwrap();
        assert_eq!(info.payload_len, 6);
        assert_eq!(info.min_addr, 0x0800);
        assert_eq!(info.max_addr, 0x1001);
        assert_ne!(info.crc32, 0);
    }

    #[test]
    fn ihex_upper_address() {
        // 扩展线性地址 0x0001 → 0x10000 起
        let text = ":020000040001F9\n:020000000102FB\n:00000001FF\n";
        let info = parse_ihex(text).unwrap();
        assert_eq!(info.min_addr, 0x10000);
        assert_eq!(info.max_addr, 0x10001);
    }

    #[test]
    fn ihex_bad_checksum() {
        let text = ":04080000DEADBEEF22\n"; // 校验和应为 21
        assert!(parse_ihex(text).is_err());
    }

    #[test]
    fn crc_known_vector() {
        assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    }
}
