/**
 * 口型同步控制器：从 AudioContext 实时分析音频振幅，驱动 Live2D 嘴巴参数。
 *
 * 分析方法：RMS 时域振幅（比频域平均值更灵敏地反映语音开合）
 * - getByteTimeDomainData 读取波形数据
 * - 计算 RMS（均方根）振幅，直接对应音量大小 → 嘴巴开合度
 *
 * 平滑策略：
 * - 使用指数平滑系数 0.6（旧值）+ 0.4（新值），兼顾灵敏度和稳定性
 * - 应用 2.5 倍增益让嘴型变化更明显（RMS 值通常较小）
 *
 * 性能优化：AudioContext / Analyser 只创建一次并全程复用，逐条播放只新建 BufferSource，
 * 避免每条音频都重建 AudioContext + resume，降低句间断隙与抖动（段级连续播放更顺）。
 *
 * 杂音优化：每段经 GainNode 做短淡入淡出，消除逐段硬起硬止造成的 click/pop（开局最明显）。
 */
export class LipSyncController {
  private audioContext: AudioContext | null = null
  private analyser: AnalyserNode | null = null
  private source: AudioBufferSourceNode | null = null
  private gain: GainNode | null = null
  /** 淡入时长（秒）：起播时音量 0→1 */
  private static readonly FADE_IN_SEC = 0.05
  /** 淡出时长（秒）：收尾时音量 1→0 */
  private static readonly FADE_OUT_SEC = 0.08
  /** 时域波形数据缓冲区 */
  private timeData: Uint8Array | null = null
  /** 平滑后的开合值（0~1），避免抖动 */
  private smoothedOpen = 0
  /** 当前播放状态（用于 ticker 判断是否需要应用口型参数） */
  private playing = false

  /**
   * 惰性创建并复用 AudioContext + Analyser（只建一次）。
   * 创建后 Analyser 连接到扬声器输出，供后续每条音频的 source 复用。
   */
  private ensureContext(): AudioContext {
    if (!this.audioContext) {
      const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
      this.audioContext = new AudioCtx()
      this.analyser = this.audioContext.createAnalyser()
      this.analyser.fftSize = 512 // 时域采样点数，512 足够精确
      this.analyser.smoothingTimeConstant = 0.4 // 较低的平滑系数保留更多细节
      this.timeData = new Uint8Array(this.analyser.fftSize)
      this.analyser.connect(this.audioContext.destination)
    }
    return this.audioContext
  }

  /**
   * 播放音频 buffer 并开始分析振幅。
   * 复用既有 AudioContext，仅新建 BufferSource 并接入同一 Analyser。
   * @param arrayBuffer wav/mp3 等格式的二进制音频数据
   * @returns 播放完成的 Promise（onended 时 resolve）
   */
  async play(arrayBuffer: ArrayBuffer): Promise<void> {
    // 先停止上一次的播放（释放 source，保留复用 context）
    this.stop()

    const ctx = this.ensureContext()

    // Electron 自动播放策略可能导致 AudioContext 处于 suspended 状态，需显式 resume
    if (ctx.state === 'suspended') {
      try {
        await ctx.resume()
      } catch {
        // resume 失败不阻塞后续流程
      }
    }

    // 解码音频数据
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer)

    // 创建本次播放源并经 GainNode 接入复用 Analyser：source → gain → analyser（analyser 已在 ensureContext 连到 destination）
    this.source = ctx.createBufferSource()
    this.source.buffer = audioBuffer
    this.gain = ctx.createGain()
    this.gain.connect(this.analyser!)
    this.source.connect(this.gain)

    // 淡入淡出：消除每段硬起硬止的 click/pop（开局第一段最明显）
    const t0 = ctx.currentTime
    const dur = audioBuffer.duration
    const fadeIn = Math.min(LipSyncController.FADE_IN_SEC, dur)
    const fadeOut = Math.min(LipSyncController.FADE_OUT_SEC, dur / 2)
    const tEnd = t0 + dur
    this.gain.gain.setValueAtTime(0, t0)
    this.gain.gain.linearRampToValueAtTime(1, t0 + fadeIn)
    if (fadeOut > 0) {
      this.gain.gain.setValueAtTime(1, Math.max(t0 + fadeIn, tEnd - fadeOut))
      this.gain.gain.linearRampToValueAtTime(0, tEnd)
    }

    this.source.start()

    this.playing = true
    this.smoothedOpen = 0

    // 返回播放结束 Promise
    return new Promise<void>((resolve) => {
      this.source!.onended = () => {
        this.stop()
        resolve()
      }
    })
  }

  /** 停止当前播放并释放本次 source/gain（保留复用 AudioContext / Analyser） */
  stop(): void {
    if (this.source) {
      try {
        this.source.onended = null
        this.source.stop()
      } catch {
        // 已停止的 source.stop() 会抛错，忽略
      }
      try {
        this.source.disconnect()
      } catch {
        // 忽略
      }
      this.source = null
    }
    if (this.gain) {
      try {
        this.gain.disconnect()
      } catch {
        // 忽略
      }
      this.gain = null
    }
    this.smoothedOpen = 0
    this.playing = false
  }

  /**
   * 获取当前嘴巴开合值（0~1），由 ticker 每帧调用。
   * 使用 RMS 时域振幅分析：直接计算波形均方根，对应语音音量 → 嘴巴开合度。
   * 不在播放时返回 0，让嘴型回到默认状态。
   */
  getMouthOpen(): number {
    if (!this.playing || !this.analyser || !this.timeData) return 0

    // 读取时域波形数据（每个采样值 0-255，中心值为 128）
    this.analyser.getByteTimeDomainData(this.timeData as Uint8Array<ArrayBuffer>)

    // 计算 RMS 振幅：偏离中心值（128）的程度
    let sumSquares = 0
    for (let i = 0; i < this.timeData.length; i++) {
      const v = (this.timeData[i]! - 128) / 128 // 归一化到 -1~1
      sumSquares += v * v
    }
    const rms = Math.sqrt(sumSquares / this.timeData.length)

    // 指数平滑：兼顾灵敏度和稳定性
    this.smoothedOpen = this.smoothedOpen * 0.6 + rms * 0.4

    // 2.5 倍增益让嘴型开合更明显（RMS 值通常较小，需要放大）
    // 设 0.005 阈值过滤静音段的微小噪声
    return this.smoothedOpen > 0.005 ? Math.min(1, this.smoothedOpen * 2.5) : 0
  }

  /** 当前是否正在播放音频 */
  get isPlaying(): boolean {
    return this.playing
  }
}