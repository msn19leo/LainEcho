/**
 * 辅助 LLM 配置解析（P0-2B，2026-10-15）：ja 翻译与 JSON 结构修复是"机械型"小任务，
 * 走主对话模型（可能是思考型/昂贵模型）时延迟波动极大（实测单次 1.3~28.8s，串行在
 * 首声关键路径上）。允许为它们配置独立的快速小模型：可与主模型同服务商（共用 Key），
 * 也可完全独立（独立 Key）。未配置（地址与模型均为空）时返回 null，调用方回落主模型。
 *
 * 配置解析规则：
 *  - translationModel / translationBaseURL 任一非空即视为启用辅助模型；
 *  - 缺省的字段回落主对话模型对应字段（只填模型名 = 主服务商换小模型的常见场景）；
 *  - Key 优先读独立加密存储（translationApiKey.enc），为空回落主 LLM Key。
 */
import { getSettings } from './repository'
import { readApiKey, readSecret } from './crypto'
import { paths } from './storage'

export interface AuxLlmConfig {
  model: string
  baseURL: string
  apiKey: string
}

/** 解析辅助模型配置；未启用返回 null（调用方回落主对话模型三件套） */
export async function resolveAuxLlmConfig(): Promise<AuxLlmConfig | null> {
  const settings = await getSettings()
  const model = settings.translationModel?.trim() ?? ''
  const baseURL = settings.translationBaseURL?.trim() ?? ''
  if (!model && !baseURL) return null
  let apiKey = (await readSecret(paths.translationApiKeyFile).catch(() => null)) ?? ''
  if (!apiKey) apiKey = (await readApiKey()) ?? ''
  return {
    model: model || settings.model,
    baseURL: baseURL || settings.baseURL,
    apiKey,
  }
}
