/**
 * 辅助 LLM 配置解析（P0-2B，2026-10-15）：ja 翻译与 JSON 结构修复是"机械型"小任务，
 * 走主对话模型（可能是思考型/昂贵模型）时延迟波动极大（实测单次 1.3~28.8s，串行在
 * 首声关键路径上）。允许为它们配置独立的快速小模型。
 *
 * 档案制（2026-10-19）：辅助模型是否启用 = activeAuxProfileId 是否指向档案；
 * 未启用（null）返回 null，调用方回落主模型激活的档案（resolveProfile('main')）。
 */
import { resolveProfile, type ResolvedLlmConfig } from './apiProfiles'

/** 辅助模型配置（与档案解析三元组同形，保留旧导出名减少调用方改动） */
export type AuxLlmConfig = ResolvedLlmConfig

/** 解析辅助模型配置；未启用返回 null（调用方回落主对话模型三件套） */
export async function resolveAuxLlmConfig(): Promise<AuxLlmConfig | null> {
  return resolveProfile('aux')
}
