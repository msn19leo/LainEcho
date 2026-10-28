use crate::error::Result;
use ndarray::{array, Array1, Array2, Array3, Axis, Ix3};
use ort::session::{builder::GraphOptimizationLevel, Session};

/// 推理设备。DirectML 的 `Some(n)` 表示 DXGI 枚举序号的第 n 块显卡。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Device {
    #[default]
    Cpu,
    /// DirectML；`None` = 系统默认适配器（等价于 device_id 0）
    Dml(Option<i32>),
}

impl Device {
    /// 从协议字符串解析：`cpu` / `dml` / `dml:0` / `dml:1` …
    pub fn parse(spec: &str) -> Option<Self> {
        let spec = spec.trim().to_ascii_lowercase();
        match spec.as_str() {
            "" | "cpu" => Some(Device::Cpu),
            "dml" | "gpu" => Some(Device::Dml(None)),
            other => other
                .strip_prefix("dml:")
                .and_then(|n| n.trim().parse::<i32>().ok())
                .map(|id| Device::Dml(Some(id))),
        }
    }

    pub fn as_spec(&self) -> String {
        match self {
            Device::Cpu => "cpu".to_string(),
            Device::Dml(None) => "dml".to_string(),
            Device::Dml(Some(id)) => format!("dml:{id}"),
        }
    }
}

#[allow(clippy::vec_init_then_push, unused_variables)]
pub fn load_model<P: AsRef<[u8]>>(model_file: P, bert: bool, device: Device) -> Result<Session> {
    let mut exp = Vec::new();
    #[cfg(feature = "tensorrt")]
    {
        if bert {
            exp.push(
                ort::execution_providers::TensorRTExecutionProvider::default()
                    .with_fp16(true)
                    .with_profile_min_shapes("input_ids:1x1,attention_mask:1x1")
                    .with_profile_max_shapes("input_ids:1x100,attention_mask:1x100")
                    .with_profile_opt_shapes("input_ids:1x25,attention_mask:1x25")
                    .build(),
            );
        }
    }
    #[cfg(feature = "cuda")]
    {
        #[allow(unused_mut)]
        let mut cuda = ort::execution_providers::CUDAExecutionProvider::default();
        #[cfg(feature = "cuda_tf32")]
        {
            cuda = cuda.with_tf32(true);
        }
        exp.push(cuda.build());
    }
    #[cfg(feature = "directml")]
    {
        // 只有显式选择 DML 时才注册；CPU 档必须保持纯 CPU，
        // 否则 int8 模型会悄悄落到 DirectML 上，"CPU 模式"就名不副实了。
        if let Device::Dml(device_id) = device {
            let mut dml = ort::execution_providers::DirectMLExecutionProvider::default();
            if let Some(id) = device_id {
                dml = dml.with_device_id(id);
            }
            exp.push(dml.build());
        }
    }
    #[cfg(feature = "coreml")]
    {
        exp.push(ort::execution_providers::CoreMLExecutionProvider::default().build());
    }
    exp.push(ort::execution_providers::CPUExecutionProvider::default().build());
    Ok(Session::builder()?
        .with_execution_providers(exp)?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_intra_threads(num_cpus::get_physical())?
        .with_parallel_execution(true)?
        .with_inter_threads(num_cpus::get_physical())?
        .commit_from_memory(model_file.as_ref())?)
}

#[allow(clippy::too_many_arguments)]
pub fn synthesize(
    session: &mut Session,
    bert_ori: Array2<f32>,
    x_tst: Array1<i64>,
    spk_ids: Array1<i64>,
    tones: Array1<i64>,
    lang_ids: Array1<i64>,
    style_vector: Array1<f32>,
    sdp_ratio: f32,
    length_scale: f32,
    noise_scale: f32,
    noise_scale_w: f32,
) -> Result<Array3<f32>> {
    // 不同导出脚本产出的 ONNX 输入签名不一样：有的把 noise_scale / noise_scale_w
    // 固化成图内常量（如 tsukuyomi.sbv2），有的则保留成可调输入。
    // 一律硬编码传 11 个输入会在前者上触发 `ONNX error: Invalid input name: noise_scale`，
    // 所以这里先读模型自己声明的输入，只传它认识的（缺的项本来也不生效）。
    let declared: Vec<String> = session.inputs().iter().map(|i| i.name().to_string()).collect();
    let has = |name: &str| declared.iter().any(|d| d == name);

    // 转换时用 owned Tensor（不是 TensorRef），因为 Vec 里要放不同元素类型的张量
    let mut feeds: Vec<(&str, ort::session::SessionInputValue)> = Vec::with_capacity(declared.len());

    // 先记下序列长度：x_tst 在下面会被 insert_axis 消费掉
    let seq_len = x_tst.len() as i64;

    if has("x_tst") {
        let x_tst = x_tst.insert_axis(Axis(0));
        feeds.push(("x_tst", ort::value::Tensor::from_array(x_tst)?.into()));
    }
    if has("x_tst_lengths") {
        let x_tst_lengths = array![seq_len];
        feeds.push((
            "x_tst_lengths",
            ort::value::Tensor::from_array(x_tst_lengths)?.into(),
        ));
    }
    if has("sid") {
        // 注意：sid 是 rank-1（[1]），不能 insert_axis——那是 x_tst/tones 等 rank-2 输入才需要的
        feeds.push(("sid", ort::value::Tensor::from_array(spk_ids)?.into()));
    }
    if has("tones") {
        let tones = tones.insert_axis(Axis(0));
        feeds.push(("tones", ort::value::Tensor::from_array(tones)?.into()));
    }
    if has("language") {
        let lang_ids = lang_ids.insert_axis(Axis(0));
        feeds.push(("language", ort::value::Tensor::from_array(lang_ids)?.into()));
    }
    if has("bert") {
        let bert = bert_ori.insert_axis(Axis(0)).as_standard_layout().to_owned();
        feeds.push(("bert", ort::value::Tensor::from_array(bert)?.into()));
    }
    if has("style_vec") {
        let style_vector = style_vector.insert_axis(Axis(0));
        feeds.push((
            "style_vec",
            ort::value::Tensor::from_array(style_vector)?.into(),
        ));
    }
    if has("sdp_ratio") {
        let v = ort::value::Tensor::from_array((vec![1_i64], vec![sdp_ratio]))?;
        feeds.push(("sdp_ratio", v.into()));
    }
    if has("length_scale") {
        let v = ort::value::Tensor::from_array((vec![1_i64], vec![length_scale]))?;
        feeds.push(("length_scale", v.into()));
    }
    if has("noise_scale") {
        let v = ort::value::Tensor::from_array((vec![1_i64], vec![noise_scale]))?;
        feeds.push(("noise_scale", v.into()));
    }
    if has("noise_scale_w") {
        let v = ort::value::Tensor::from_array((vec![1_i64], vec![noise_scale_w]))?;
        feeds.push(("noise_scale_w", v.into()));
    }

    if feeds.is_empty() {
        return Err(crate::error::Error::ModelNotFoundError(
            "模型未声明任何可用的输入（ONNX 签名异常）".to_string(),
        ));
    }

    let outputs = session.run(feeds)?;
    let audio_array = outputs["output"]
        .try_extract_array::<f32>()?
        .into_dimensionality::<Ix3>()?
        .to_owned();
    Ok(audio_array)
}
