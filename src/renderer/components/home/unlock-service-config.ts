/**
 * 解锁检测 —— 服务清单 + 状态语义映射（渲染端）。
 *
 * 服务清单做成配置：检测端点会漂移（社区半年变一次），后端 checker 逻辑挂在
 * 各 service id 上，此处只描述「展示什么 + 归哪组」。
 * 状态色**复用设计系统 Badge 语义变体**（success/warning/destructive），不自绘。
 */

// 状态枚举 / 结果结构的单一真值在 shared（main 检测引擎与本视图共用，双份必漂移）。此处 import 供本地类型标注用 + re-export 给消费方。
import type { UnlockStatus, UnlockResult } from '../../../shared/unlock-detection';

export type { UnlockStatus, UnlockResult };

export type UnlockGroup = 'ai' | 'media';

export interface UnlockService {
  id: string;
  name: string; // 全名（hover title 用）
  short: string; // 短名（内联一行展示用，省宽）
  group: UnlockGroup;
  // partial 态的 per-service 文案 key（覆盖默认 STATUS_LABEL_KEY.partial）：partial 语义按服务不同——Netflix=「仅自制剧」
  // （部分可看），Disney=「即将上线」（region 识别但全部未开服，非部分可看）。缺省用通用 partial 文案。
  partialLabelKey?: string;
}

export const UNLOCK_SERVICES: UnlockService[] = [
  { id: 'chatgpt', name: 'ChatGPT', short: 'ChatGPT', group: 'ai' },
  { id: 'claude', name: 'Claude', short: 'Claude', group: 'ai' },
  { id: 'gemini', name: 'Gemini', short: 'Gemini', group: 'ai' },
  { id: 'netflix', name: 'Netflix', short: 'Netflix', group: 'media' },
  {
    id: 'disney',
    name: 'Disney+',
    short: 'Disney+',
    group: 'media',
    partialLabelKey: 'home.unlockStateSoon', // partial=「即将上线」（region 识别但未开服），非 Netflix 的「仅自制剧」
  },
  { id: 'spotify', name: 'Spotify', short: 'Spotify', group: 'media' },
];

/** 状态 → i18n key。 */
export const STATUS_LABEL_KEY: Record<UnlockStatus, string> = {
  ok: 'home.unlockStateOk',
  partial: 'home.unlockStatePartial',
  blocked: 'home.unlockStateBlocked',
  checking: 'home.unlockStateChecking',
  timeout: 'home.unlockStateTimeout',
  idle: 'home.unlockStateIdle',
};
