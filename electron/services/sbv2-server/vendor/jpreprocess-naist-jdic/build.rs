use std::error::Error;

// 原版直接请求 github.com/.../v0.1.3.tar.gz（18.6 MB）。在国内网络下通过代理
// 常被截断（reqwest IncompleteMessage），构建会随机失败。
// 这里改为：优先读环境变量 NAIST_JDIC_URL，否则默认走 gh-proxy 镜像。
const DEFAULT_MIRROR: &str =
    "https://gh-proxy.org/https://github.com/jpreprocess/naist-jdic/archive/refs/tags/v0.1.3.tar.gz";

fn download_url() -> &'static str {
    match std::env::var("NAIST_JDIC_URL") {
        Ok(v) if !v.trim().is_empty() => Box::leak(v.into_boxed_str()),
        _ => DEFAULT_MIRROR,
    }
}

#[cfg(feature = "naist-jdic")]
#[tokio::main]
async fn main() -> Result<(), Box<dyn Error>> {
    let url = download_url();
    println!("cargo:rerun-if-env-changed=NAIST_JDIC_URL");
    println!("cargo:warning=naist-jdic source: {url}");
    lindera_dictionary::assets::fetch(
        lindera_dictionary::assets::FetchParams {
            file_name: "v0.1.3.tar.gz",
            input_dir: "naist-jdic-0.1.3",
            output_dir: "naist-jdic",
            download_url: url,
            dummy_input:
                "テスト,1343,1343,3195,名詞,サ変接続,*,*,*,*,テスト,テスト,テスト,1/3,C1\n",
        },
        jpreprocess_dictionary::dictionary::to_dict::JPreprocessDictionaryBuilder::new(),
    )
    .await
}

#[cfg(not(feature = "naist-jdic"))]
fn main() -> Result<(), Box<dyn Error>> {
    Ok(())
}
