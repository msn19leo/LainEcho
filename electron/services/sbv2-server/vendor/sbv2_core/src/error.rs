use thiserror::Error;

#[derive(Error, Debug)]
pub enum Error {
    #[error("Tokenizer error: {0}")]
    TokenizerError(#[from] tokenizers::Error),
    #[error("JPreprocess error: {0}")]
    JPreprocessError(#[from] jpreprocess::error::JPreprocessError),
    #[error("Lindera error: {0}")]
    LinderaError(String),
    #[cfg(feature = "std")]
    #[error("ONNX error: {0}")]
    OrtError(String),
    #[error("NDArray error: {0}")]
    NdArrayError(#[from] ndarray::ShapeError),
    #[error("Value error: {0}")]
    ValueError(String),
    #[error("Serde_json error: {0}")]
    SerdeJsonError(#[from] serde_json::Error),
    #[error("IO error: {0}")]
    IoError(#[from] std::io::Error),
    #[error("hound error: {0}")]
    HoundError(#[from] hound::Error),
    #[error("model not found error")]
    ModelNotFoundError(String),
    #[cfg(feature = "base64")]
    #[error("base64 error")]
    Base64Error(#[from] base64::DecodeError),
    #[error("other")]
    OtherError(String),
    #[error("Style error: {0}")]
    StyleError(String),
}

pub type Result<T> = std::result::Result<T, Error>;

// ort 2.0.0-rc.12 起，Error 带上了「正在构建的对象」类型参数（Error<SessionBuilder> 等），
// 无法用 #[from] 声明单一转换，这里统一按泛型实现。
#[cfg(feature = "std")]
impl<T> From<ort::Error<T>> for Error {
    fn from(e: ort::Error<T>) -> Self {
        Error::OrtError(e.to_string())
    }
}
