export interface UpdateInfo {
  version: string;
  title: string;
  releaseNotes: string;
  downloadUrl: string;
  fileSize: number; // 字节
  publishedAt: string;
  isPrerelease: boolean;
  fileName: string;
}

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'no-update'
  | 'update-available'
  | 'downloading'
  | 'downloaded'
  | 'error';

export interface UpdateProgress {
  status: UpdateStatus;
  percentage: number;
  message: string;
  error?: string;
}

export interface UpdateCheckResult {
  hasUpdate: boolean;
  updateInfo?: UpdateInfo;
  error?: string;
}

/**
 * 更新弹窗（独立 mini 更新窗，Conduit 化）四态：
 * remind=发现新版本 / progress=下载中 / done=下载完成 / error=下载失败。
 */
export type UpdatePopupPhase = 'remind' | 'progress' | 'done' | 'error';

/**
 * 弹窗按钮/关闭回传的动作：
 * remind → update|later|skip|viewLog；progress → cancel；error → retry|manualDownload|close。
 * update|later|skip 决定 showUpdateDialog 返回；viewLog|manualDownload 为副作用动作（开外链）；
 * cancel 中断在途下载（abort + 删临时件 + 关窗，不安装）。
 */
export type UpdatePopupAction =
  | 'update'
  | 'later'
  | 'skip'
  | 'viewLog'
  | 'cancel'
  | 'retry'
  | 'manualDownload'
  | 'close';

/**
 * 弹窗静态文案（主进程按当前语言经 mt() 渲染进载荷；弹窗页无 i18n runtime）。
 */
export interface UpdatePopupLabels {
  remindTitle: string;
  progressTitle: string;
  doneTitle: string;
  errorTitle: string;
  /** 「当前」版本前缀（remind 副行「当前 vX」）。 */
  currentPrefix: string;
  /** done 态说明「下载完成，正在安装…」。 */
  installing: string;
  /** 镜像回退说明「正在尝试通过镜像下载…」。 */
  tryingMirror: string;
  update: string;
  later: string;
  skip: string;
  viewLog: string;
  cancel: string;
  retry: string;
  manualDownload: string;
  close: string;
}

/**
 * 主进程 → 弹窗 的状态载荷（结构化，取代旧的 executeJavaScript 字符串拼接）。每次态迁移/进度更新整帧下发。
 */
export interface UpdatePopupState {
  phase: UpdatePopupPhase;
  /** 生效主题（= nativeTheme.shouldUseDarkColors），弹窗首帧即用、避免 matchMedia 竞态。 */
  theme: 'dark' | 'light';
  /** 新版本号（版本 pill）。 */
  version: string;
  /** remind：当前运行版本（如 v1.2.0）。 */
  currentVersion?: string;
  /** progress/done：百分比 0-100。 */
  percentage?: number;
  /** progress：字节计数文本（如 "28.6 MB / 45.3 MB"）。 */
  bytesText?: string;
  /** progress：是否正在镜像回退（显示 tryingMirror 文案）。 */
  mirror?: boolean;
  /** error：错误详情文本。 */
  errorText?: string;
  labels: UpdatePopupLabels;
}
