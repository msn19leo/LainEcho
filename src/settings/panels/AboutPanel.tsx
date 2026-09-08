/**
 * 「关于 / 检查更新」面板。
 * 提供两个入口：手动「检查更新」按钮，以及订阅托盘触发（updater:check-request）。
 * 更新流程全程由用户决定：发现新版 → 是否下载 → 下载完成 → 是否重启安装。
 */
import { useEffect, useState } from 'react'
import { ArrowUpCircle, RefreshCw, RotateCw } from 'lucide-react'
import { api } from '../../api'
import { Button, Card, Modal } from '../../components/ui'

type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'error' | 'latest'

export function AboutPanel() {
  const [phase, setPhase] = useState<UpdatePhase>('idle')
  const [availableVersion, setAvailableVersion] = useState('')
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState('')
  /** 应用当前版本号（从主进程动态读取） */
  const [version, setVersion] = useState('')

  useEffect(() => {
    // 读取当前应用版本号用于展示
    void api.updater.getVersion().then(setVersion).catch(() => {})

    const offAvailable = api.updater.onAvailable((v) => {
      setAvailableVersion(v)
      setPhase('available')
    })
    // 检查完成且无新版本：结束"检查中"，提示已是最新
    const offNotAvailable = api.updater.onNotAvailable(() => {
      setPhase('latest')
    })
    const offDownloaded = api.updater.onDownloaded(() => setPhase('downloaded'))
    const offProgress = api.updater.onProgress((p) => {
      setProgress(p)
      setPhase('downloading')
    })
    const offError = api.updater.onError((msg) => {
      setError(msg || '检查更新出错')
      setPhase('error')
    })
    // 托盘「检查更新」触发：进入检查态并主动发起检查
    const offRequest = api.updater.onCheckRequest(async () => {
      await handleCheck()
    })
    return () => {
      offAvailable()
      offNotAvailable()
      offDownloaded()
      offProgress()
      offError()
      offRequest()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 发起「检查更新」：开发模式会抛错，捕获后提示 */
  const handleCheck = async () => {
    setPhase('checking')
    setError('')
    try {
      await api.updater.check()
    } catch (err) {
      setError(err instanceof Error ? err.message : '检查更新失败')
      setPhase('error')
    }
  }

  /** 用户确认「下载新版本」 */
  const handleDownload = async () => {
    setPhase('downloading')
    setProgress(0)
    try {
      await api.updater.download()
    } catch (err) {
      setError(err instanceof Error ? err.message : '下载失败')
      setPhase('error')
    }
  }

  /** 用户确认「立即重启安装」 */
  const handleInstall = () => {
    void api.updater.install()
  }

  const checking = phase === 'checking'
  const currentPhrase =
    phase === 'idle' ? '检查是否有新版本可更新' : phase === 'error' ? '检查出错' : phase === 'latest' ? '当前已是最新版本' : ''

  return (
    <Card className="space-y-4">
      <div className="flex items-center gap-2">
        <RotateCw size={15} strokeWidth={1.75} color="var(--primary-400)" />
        <span className="text-sm font-medium text-text-2">软件更新</span>
      </div>

      <Button onClick={() => void handleCheck()} disabled={checking}>
        {checking ? (
          <>
            <RefreshCw size={14} className="animate-spin" /> 检查中…
          </>
        ) : (
          '检查更新'
        )}
      </Button>
      {phase === 'latest' && (
        <div className="rounded-[var(--radius-sm)] bg-primary-500/10 px-3 py-2">
          <p className="text-xs leading-relaxed text-primary-400">当前已是最新版本。</p>
        </div>
      )}

      {phase === 'idle' && <p className="text-xs leading-relaxed text-text-muted">{currentPhrase}</p>}

      {/* 发现新版：询问是否下载 */}
      <Modal
        open={phase === 'available'}
        title="发现新版本"
        width={380}
        onClose={() => setPhase('idle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => void api.updater.skip()}>
              稍后再说
            </Button>
            <Button autoFocus onClick={() => void handleDownload()}>
              <ArrowUpCircle size={14} /> 立即下载
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-text-2">
          检测到新版本 v{availableVersion}，是否立即下载并安装？
        </p>
      </Modal>

      {/* 下载进度 */}
      <Modal
        open={phase === 'downloading'}
        title="正在下载更新"
        width={380}
        onClose={() => setPhase('idle')}
        footer={<Button variant="ghost" onClick={() => setPhase('idle')}>后台下载</Button>}
      >
        <div className="flex items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full transition-all"
              style={{ width: `${progress}%`, background: 'var(--gradient-brand)' }}
            />
          </div>
          <span className="text-xs tabular-nums text-text-muted">{progress}%</span>
        </div>
      </Modal>

      {/* 下载完成：询问是否重启安装 */}
      <Modal
        open={phase === 'downloaded'}
        title="更新已就绪"
        width={380}
        onClose={() => setPhase('idle')}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPhase('idle')}>稍后</Button>
            <Button autoFocus onClick={handleInstall}>立即重启安装</Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-text-2">
          新版本已下载完成，是否立即重启以完成安装？
        </p>
      </Modal>

      {/* 检查出错 */}
      {phase === 'error' && (
        <div className="rounded-[var(--radius-sm)] bg-danger/10 px-3 py-2">
          <p className="text-xs leading-relaxed text-danger">{error}</p>
        </div>
      )}

      <div className="border-t border-border pt-3">
        <p className="text-xs leading-relaxed text-text-muted">
          LainEcho · AI 桌宠（v{version || '0.1.0'}）<br />
          更新需在 GitHub Releases 发布新版本后，由你在本页面或系统托盘手动触发检查。
        </p>
      </div>
    </Card>
  )
}