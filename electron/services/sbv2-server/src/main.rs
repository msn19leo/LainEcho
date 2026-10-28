//! SBV2 sidecar —— 由 Electron 主进程 spawn，通过 stdin/stdout 走 NDJSON 协议。
//!
//! 设计要点：
//! - 只把协议写 stdout，日志一律走 stderr。
//! - 单线程串行处理请求：`TTSModelHolder` 不是 Send + Sync，且同一时刻只会有一次合成。
//! - 输出统一转成 16-bit PCM WAV：`easy_synthesize` 返回的是 float32 WAV，
//!   主进程的 applyAudioSpeed 只认 int16，且 int16 让 IPC 体积减半。
//!
//! 命令（行分隔 JSON，id 由调用方分配，回包原样带回）：
//!   {"id":1,"cmd":"ping"}
//!   {"id":2,"cmd":"devices"}
//!   {"id":3,"cmd":"load","bert":"...","tokenizer":"...","device":"dml:0"}
//!   {"id":4,"cmd":"voice","ident":"tts-model_x","path":"...","warmup":true}
//!   {"id":5,"cmd":"unload-voice","ident":"tts-model_x"}
//!   {"id":6,"cmd":"synth","ident":"...","text":"...","styleId":0,"speakerId":0,
//!    "sdpRatio":0.2,"lengthScale":1.0}
//!   {"id":7,"cmd":"unload"}
//!   {"id":8,"cmd":"quit"}

use std::fs;
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::Engine as _;
use sbv2_core::model::Device;
use sbv2_core::tts::{SynthesizeOptions, TTSModelHolder};
use serde_json::{json, Value};

const MAX_LOADED_VOICES: usize = 2;
const DEFAULT_SDP_RATIO: f32 = 0.2;
const DEFAULT_LENGTH_SCALE: f32 = 1.0;
const WARMUP_TEXT: &str = "あ";

struct Engine {
    holder: Option<TTSModelHolder>,
    device: Device,
}

impl Engine {
    fn new() -> Self {
        Self { holder: None, device: Device::Cpu }
    }

    fn require(&mut self) -> Result<&mut TTSModelHolder, SidecarError> {
        self.holder
            .as_mut()
            .ok_or_else(|| SidecarError::new("NOT_LOADED", "模型尚未加载，请先启动服务"))
    }
}

struct SidecarError {
    code: &'static str,
    message: String,
}

impl SidecarError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self { code, message: message.into() }
    }
}

type CmdResult = Result<Value, SidecarError>;

fn main() {
    let stdin = std::io::stdin();
    let mut engine = Engine::new();
    eprintln!("[sbv2] sidecar started, pid={}", std::process::id());

    for line in stdin.lock().lines() {
        let line = match line {
            Ok(l) => l,
            Err(e) => {
                eprintln!("[sbv2] stdin read error: {e}");
                break;
            }
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let request: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(e) => {
                emit(json!({"id": null, "ok": false,
                    "error": {"code": "BAD_JSON", "message": e.to_string()}}));
                continue;
            }
        };
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let cmd = request.get("cmd").and_then(Value::as_str).unwrap_or("");

        if cmd == "quit" {
            emit(json!({"id": id, "ok": true, "bye": true}));
            break;
        }

        let started = Instant::now();
        match handle(&mut engine, cmd, &request) {
            Ok(mut value) => {
                if let Some(obj) = value.as_object_mut() {
                    obj.insert("id".into(), id);
                    obj.insert("ok".into(), Value::Bool(true));
                    obj.insert("elapsedMs".into(), json!(started.elapsed().as_millis()));
                }
                emit(value);
            }
            Err(e) => {
                eprintln!("[sbv2] error [{}] {}", e.code, e.message);
                emit(json!({"id": id, "ok": false,
                    "error": {"code": e.code, "message": e.message}}));
            }
        }
    }

    engine.holder = None;
    eprintln!("[sbv2] sidecar exiting");
}

fn handle(engine: &mut Engine, cmd: &str, req: &Value) -> CmdResult {
    match cmd {
        "ping" => Ok(json!({
            "loaded": engine.holder.is_some(),
            "device": engine.device.as_spec(),
            "voices": engine
                .holder
                .as_ref()
                .map(|h| h.models())
                .unwrap_or_default(),
        })),
        "devices" => Ok(json!({ "devices": enumerate_gpus() })),
        "load" => load(engine, req),
        "voice" => load_voice(engine, req),
        "unload-voice" => unload_voice(engine, req),
        "synth" => synth(engine, req),
        "unload" => {
            engine.holder = None;
            Ok(json!({ "unloaded": true }))
        }
        other => Err(SidecarError::new("BAD_COMMAND", format!("未知指令：{other}"))),
    }
}

fn load(engine: &mut Engine, req: &Value) -> CmdResult {
    let bert = str_field(req, "bert")?;
    let tokenizer = str_field(req, "tokenizer")?;
    let spec = req.get("device").and_then(Value::as_str).unwrap_or("cpu");
    let device = Device::parse(spec)
        .ok_or_else(|| SidecarError::new("BAD_DEVICE", format!("无法识别的设备：{spec}")))?;

    let bert_bytes = read_file(&bert, "DeBERTa 模型")?;
    let tok_bytes = read_file(&tokenizer, "tokenizer.json")?;

    let t = Instant::now();
    let holder =
        TTSModelHolder::new_with_device(bert_bytes, tok_bytes, Some(MAX_LOADED_VOICES), device)
            .map_err(|e| SidecarError::new("LOAD_FAILED", format!("加载 BERT 失败：{e}")))?;

    engine.holder = Some(holder);
    engine.device = device;
    eprintln!("[sbv2] bert loaded on {:?} in {:?}", device, t.elapsed());
    Ok(json!({ "device": device.as_spec(), "loadMs": t.elapsed().as_millis() }))
}

fn load_voice(engine: &mut Engine, req: &Value) -> CmdResult {
    let ident = str_field(req, "ident")?;
    let path = PathBuf::from(str_field(req, "path")?);
    let warmup = req.get("warmup").and_then(Value::as_bool).unwrap_or(true);

    let form = detect_voice(&path)?;
    let t = Instant::now();
    {
        let holder = engine.require()?;
        match &form {
            VoiceForm::OnnxPair { model, style } => {
                let style_bytes = read_file(style, "style_vectors.json")?;
                let model_bytes = read_file(model, "model.onnx")?;
                holder.load(ident.as_str(), style_bytes, model_bytes).map_err(|e| {
                    SidecarError::new("VOICE_LOAD_FAILED", format!("加载声线失败：{e}"))
                })?;
            }
            VoiceForm::Sbv2File { file } => {
                let bytes = read_file(file, ".sbv2")?;
                holder.load_sbv2file(ident.as_str(), bytes).map_err(|e| {
                    SidecarError::new("VOICE_LOAD_FAILED", format!("加载声线失败：{e}"))
                })?;
            }
        }
    }
    let load_ms = t.elapsed().as_millis();
    eprintln!("[sbv2] voice {ident} loaded in {load_ms}ms");

    // 首次合成要编译 DirectML kernel（实测 2.5–7s），提前摊到启动阶段。
    let mut warmup_ms = 0u128;
    if warmup {
        let t = Instant::now();
        let opts = SynthesizeOptions {
            sdp_ratio: DEFAULT_SDP_RATIO,
            length_scale: DEFAULT_LENGTH_SCALE,
            style_weight: 1.0,
            split_sentences: false,
        };
        let holder = engine.require()?;
        match holder.easy_synthesize(ident.as_str(), WARMUP_TEXT, 0, 0, opts) {
            Ok(_) => {
                warmup_ms = t.elapsed().as_millis();
                eprintln!("[sbv2] warmup done in {warmup_ms}ms");
            }
            Err(e) => eprintln!("[sbv2] warmup failed (non-fatal): {e}"),
        }
    }

    Ok(json!({
        "ident": ident,
        "form": form.label(),
        "loadMs": load_ms,
        "warmupMs": warmup_ms,
    }))
}

fn unload_voice(engine: &mut Engine, req: &Value) -> CmdResult {
    let ident = str_field(req, "ident")?;
    let holder = engine.require()?;
    let removed = holder.unload(ident.as_str());
    Ok(json!({ "unloaded": removed, "voices": holder.models() }))
}

fn synth(engine: &mut Engine, req: &Value) -> CmdResult {
    let ident = str_field(req, "ident")?;
    let text = str_field(req, "text")?;
    let style_id = req.get("styleId").and_then(Value::as_i64).unwrap_or(0) as i32;
    let speaker_id = req.get("speakerId").and_then(Value::as_i64).unwrap_or(0);
    let opts = SynthesizeOptions {
        sdp_ratio: req
            .get("sdpRatio")
            .and_then(Value::as_f64)
            .unwrap_or(DEFAULT_SDP_RATIO as f64) as f32,
        length_scale: req
            .get("lengthScale")
            .and_then(Value::as_f64)
            .unwrap_or(DEFAULT_LENGTH_SCALE as f64) as f32,
        style_weight: 1.0,
        split_sentences: true,
    };

    let t = Instant::now();
    let raw = {
        let holder = engine.require()?;
        holder
            .easy_synthesize(ident.as_str(), &text, style_id, speaker_id, opts)
            .map_err(|e| SidecarError::new("SYNTH_FAILED", format!("合成失败：{e}")))?
    };
    let synth_ms = t.elapsed().as_millis();

    let (wav, sample_rate, audio_ms) = to_i16_wav(&raw)?;
    Ok(json!({
        "wav": base64::engine::general_purpose::STANDARD.encode(&wav),
        "sampleRate": sample_rate,
        "audioMs": audio_ms,
        "synthMs": synth_ms,
        "bytes": wav.len(),
    }))
}

// ---------------------------------------------------------------- 设备枚举

#[cfg(windows)]
fn enumerate_gpus() -> Vec<Value> {
    use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};

    // 部分驱动（AMD 核显常见）会把同一块物理显卡枚举出多条相同条目，
    // 按 (VendorId, DeviceId) 去重，保留首次出现的 DXGI 序号 —— 那个序号才是
    // DirectML 的 device_id。软件适配器（Microsoft Basic Render Driver，
    // vendor 0x1414）对推理没有意义，直接滤掉。
    const VENDOR_MICROSOFT: u32 = 0x1414;

    let mut out = Vec::new();
    let mut seen: std::collections::HashSet<(u32, u32)> = std::collections::HashSet::new();
    unsafe {
        if let Ok(factory) = CreateDXGIFactory1::<IDXGIFactory1>() {
            for i in 0u32..16 {
                match factory.EnumAdapters1(i) {
                    Ok(adapter) => {
                        if let Ok(desc) = adapter.GetDesc1() {
                            if desc.VendorId == VENDOR_MICROSOFT {
                                continue;
                            }
                            if !seen.insert((desc.VendorId, desc.DeviceId)) {
                                continue;
                            }
                            let name = String::from_utf16_lossy(&desc.Description)
                                .trim_end_matches('\0')
                                .trim()
                                .to_string();
                            out.push(json!({
                                "id": i,
                                "name": name,
                                "vendorId": desc.VendorId,
                                "deviceId": desc.DeviceId,
                            }));
                        }
                    }
                    Err(_) => break,
                }
            }
        }
    }
    out
}

#[cfg(not(windows))]
fn enumerate_gpus() -> Vec<Value> {
    Vec::new()
}

// ---------------------------------------------------------------- 声线形态

enum VoiceForm {
    OnnxPair { model: PathBuf, style: PathBuf },
    Sbv2File { file: PathBuf },
}

impl VoiceForm {
    fn label(&self) -> &'static str {
        match self {
            VoiceForm::OnnxPair { .. } => "onnx",
            VoiceForm::Sbv2File { .. } => "sbv2",
        }
    }
}

fn detect_voice(p: &Path) -> Result<VoiceForm, SidecarError> {
    if p.is_file() {
        if p.extension()
            .map(|x| x.eq_ignore_ascii_case("sbv2"))
            .unwrap_or(false)
        {
            return Ok(VoiceForm::Sbv2File { file: p.to_path_buf() });
        }
        return Err(SidecarError::new(
            "BAD_VOICE",
            format!("{} 不是 .sbv2 文件", p.display()),
        ));
    }
    if !p.is_dir() {
        return Err(SidecarError::new(
            "BAD_VOICE",
            format!("声线路径不存在：{}", p.display()),
        ));
    }

    // 1) 规范命名优先：model.onnx + style_vectors.json
    let model = p.join("model.onnx");
    let style = p.join("style_vectors.json");
    if model.is_file() {
        if !style.is_file() {
            return Err(SidecarError::new(
                "BAD_VOICE",
                format!(
                    "{} 里有 model.onnx 但缺少 style_vectors.json（该形式必须成对）",
                    p.display()
                ),
            ));
        }
        return Ok(VoiceForm::OnnxPair { model, style });
    }

    // 2) 放宽匹配：目录里恰好一个 .onnx 且恰好一个 style_vector*.json 时自动配对。
    //    很多 SBV2 发布包解压出来是 model_xxx.onnx / style_vectors_xxx.json，
    //    只认固定名会让用户必须手工改名（2026-10-28 实测：改名后一切正常）。
    //    只在"唯一"时配对——多套模型混放时不做猜测，避免配错声线。
    let entries: Vec<PathBuf> = fs::read_dir(p)
        .map_err(|e| SidecarError::new("BAD_VOICE", format!("读取目录失败：{e}")))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|q| q.is_file())
        .collect();
    let ext_is = |q: &PathBuf, want: &str| {
        q.extension()
            .map(|x| x.eq_ignore_ascii_case(want))
            .unwrap_or(false)
    };
    let mut onnxs: Vec<PathBuf> = entries.iter().filter(|q| ext_is(q, "onnx")).cloned().collect();
    let mut style_jsons: Vec<PathBuf> = entries
        .iter()
        .filter(|q| ext_is(q, "json"))
        .filter(|q| {
            q.file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase().contains("style_vector"))
                .unwrap_or(false)
        })
        .cloned()
        .collect();
    onnxs.sort();
    style_jsons.sort();

    if onnxs.len() == 1 && style_jsons.len() == 1 {
        eprintln!(
            "[sbv2] 声线目录使用非标准命名，已自动配对：{} + {}",
            onnxs[0].file_name().unwrap_or_default().to_string_lossy(),
            style_jsons[0].file_name().unwrap_or_default().to_string_lossy()
        );
        return Ok(VoiceForm::OnnxPair {
            model: onnxs.remove(0),
            style: style_jsons.remove(0),
        });
    }
    if onnxs.len() == 1 && style_jsons.is_empty() {
        return Err(SidecarError::new(
            "BAD_VOICE",
            format!(
                "{} 里找到 {} 但没有配套的 style_vectors*.json",
                p.display(),
                onnxs[0].file_name().unwrap_or_default().to_string_lossy()
            ),
        ));
    }
    if onnxs.len() > 1 || style_jsons.len() > 1 {
        return Err(SidecarError::new(
            "BAD_VOICE",
            format!(
                "{} 里有 {} 个 .onnx 和 {} 个 style_vectors*.json，无法确定配对；\
                 请把要用的改名为 model.onnx + style_vectors.json，或改用 .sbv2 单文件",
                p.display(),
                onnxs.len(),
                style_jsons.len()
            ),
        ));
    }

    let mut cands: Vec<PathBuf> = fs::read_dir(p)
        .map_err(|e| SidecarError::new("BAD_VOICE", format!("读取目录失败：{e}")))?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|q| q.is_file())
        .filter(|q| {
            q.extension()
                .map(|x| x.eq_ignore_ascii_case("sbv2"))
                .unwrap_or(false)
        })
        .collect();
    cands.sort();

    match cands.len() {
        0 => Err(SidecarError::new(
            "BAD_VOICE",
            format!(
                "{} 里没有可用的声线：需要 model.onnx + style_vectors.json（或目录里唯一的 \
                 xxx.onnx 与 style_vectors*.json），也可以直接放一个 .sbv2 文件",
                p.display()
            ),
        )),
        1 => Ok(VoiceForm::Sbv2File { file: cands.remove(0) }),
        _ => {
            let named = cands.iter().find(|q| {
                q.file_stem()
                    .map(|s| s.eq_ignore_ascii_case("model"))
                    .unwrap_or(false)
            });
            match named {
                Some(f) => Ok(VoiceForm::Sbv2File { file: f.clone() }),
                None => Err(SidecarError::new(
                    "BAD_VOICE",
                    format!(
                        "{} 里有 {} 个 .sbv2，无法确定用哪个（可把其中一个改名为 model.sbv2）",
                        p.display(),
                        cands.len()
                    ),
                )),
            }
        }
    }
}

// ---------------------------------------------------------------- WAV 处理

/// 把 easy_synthesize 返回的 WAV 统一转成 16-bit PCM。
/// 返回 (wav 字节, 采样率, 音频时长毫秒)。
fn to_i16_wav(raw: &[u8]) -> Result<(Vec<u8>, u32, u64), SidecarError> {
    let parsed = parse_wav(raw)
        .ok_or_else(|| SidecarError::new("BAD_AUDIO", "模型返回的不是可解析的 WAV"))?;

    let channels = parsed.channels as usize;
    let samples: Vec<i16> = match parsed.bits {
        16 => parsed
            .data
            .chunks_exact(2)
            .map(|c| i16::from_le_bytes([c[0], c[1]]))
            .collect(),
        32 => parsed
            .data
            .chunks_exact(4)
            .map(|c| {
                let f = f32::from_le_bytes([c[0], c[1], c[2], c[3]]);
                (f.clamp(-1.0, 1.0) * 32767.0).round() as i16
            })
            .collect(),
        other => {
            return Err(SidecarError::new(
                "BAD_AUDIO",
                format!("不支持的位深：{other}"),
            ))
        }
    };

    let frames = if channels > 0 { samples.len() / channels } else { 0 };
    let audio_ms = if parsed.sample_rate > 0 {
        (frames as u64) * 1000 / parsed.sample_rate as u64
    } else {
        0
    };

    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&(channels as u16).to_le_bytes());
    out.extend_from_slice(&parsed.sample_rate.to_le_bytes());
    let block_align = (channels as u32) * 2;
    out.extend_from_slice(&(parsed.sample_rate * block_align).to_le_bytes());
    out.extend_from_slice(&(block_align as u16).to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in &samples {
        out.extend_from_slice(&s.to_le_bytes());
    }

    Ok((out, parsed.sample_rate, audio_ms))
}

struct ParsedWav<'a> {
    channels: u16,
    sample_rate: u32,
    bits: u16,
    data: &'a [u8],
}

fn parse_wav(b: &[u8]) -> Option<ParsedWav<'_>> {
    if b.len() < 44 || &b[0..4] != b"RIFF" || &b[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12;
    let mut channels = 0u16;
    let mut sample_rate = 0u32;
    let mut bits = 0u16;
    let mut data: Option<&[u8]> = None;

    while pos + 8 <= b.len() {
        let id = &b[pos..pos + 4];
        let size = u32::from_le_bytes([b[pos + 4], b[pos + 5], b[pos + 6], b[pos + 7]]) as usize;
        let body = pos + 8;
        if id == b"fmt " && body + 16 <= b.len() {
            channels = u16::from_le_bytes([b[body + 2], b[body + 3]]);
            sample_rate = u32::from_le_bytes([b[body + 4], b[body + 5], b[body + 6], b[body + 7]]);
            bits = u16::from_le_bytes([b[body + 14], b[body + 15]]);
        } else if id == b"data" {
            let avail = b.len().saturating_sub(body).min(size);
            data = Some(&b[body..body + avail]);
            if sample_rate > 0 {
                break;
            }
        }
        pos = body + size + (size & 1);
    }

    Some(ParsedWav {
        channels: channels.max(1),
        sample_rate,
        bits,
        data: data?,
    })
}

// ---------------------------------------------------------------- 工具

fn str_field(req: &Value, key: &str) -> Result<String, SidecarError> {
    req.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or_else(|| SidecarError::new("BAD_PARAM", format!("缺少参数：{key}")))
}

fn read_file(path: impl AsRef<Path>, what: &str) -> Result<Vec<u8>, SidecarError> {
    let p = path.as_ref();
    fs::read(p)
        .map_err(|e| SidecarError::new("FILE_READ_FAILED", format!("读取{what}失败 {}：{e}", p.display())))
}

fn emit(value: Value) {
    let stdout = std::io::stdout();
    let mut lock = stdout.lock();
    if writeln!(lock, "{value}").is_err() || lock.flush().is_err() {
        eprintln!("[sbv2] stdout write failed, exiting");
        std::process::exit(1);
    }
}
