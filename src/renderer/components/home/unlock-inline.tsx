import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/store/app-store';
import { useUnlockDetection } from './use-unlock-detection';
import { isRestrictedEgressRegion } from '../../../shared/unlock-detection';
import {
  UNLOCK_SERVICES,
  STATUS_LABEL_KEY,
  type UnlockService,
  type UnlockStatus,
} from './unlock-service-config';

/**
 * 解锁检测内联行 —— 嵌进「连接控制卡」出口节点标签行右侧（`出口节点` 那行的空白处，见 connection-control-card）。
 *
 * 为何内联而非独立块：任何独立卡/条都会把卡片内容往下挤、吃垂直空间。塞进已有的标签行
 * 则**零挤占**——标签行本就占一行，卡片高度不变。
 * 一行到底：短名 + 状态色点（绿解锁/琥珀仅自制/红未解锁），分组 AI/流媒体，无计数；
 * 窄窗横向滚动保证不折行。区域/状态文案落 hover title。数据源 useUnlockDetection（真实检测引擎，
 * 经当前代理出口跑 AI/流媒体解锁 checker）。
 *
 * 刷新钮联动：点击除触发解锁重检（proxy off 时 hook 早退无害），并 force+visible 重探状态栏出口 IP
 * （reprobeExitIp；proxy on 探 direct+proxy、off 仅探 direct）——两出口物理独立、仅联动触发不复用结果。
 * 重探走可见流程：状态栏全程显「检测中…→新IP/检测超时」，失败丢旧值显检测超时（用户定：触发即按流程走、失败要可见）。
 */

const DOT_CLASS: Record<UnlockStatus, string> = {
  ok: 'bg-ok',
  partial: 'bg-warn',
  blocked: 'bg-err',
  checking: 'bg-fg-faint animate-pulse',
  timeout: 'bg-fg-faint',
  idle: 'bg-fg-faint',
};

export function UnlockInline() {
  const { t } = useTranslation();
  const { results, running, cooldown, egress, run } = useUnlockDetection();
  const reprobeExitIp = useAppStore((s) => s.reprobeExitIp);
  const [reprobing, setReprobing] = useState(false);

  // 手动刷新钮 = 解锁重检 + 出口 IP force+visible 可见重探（两出口独立、仅联动触发不复用结果）。proxy on：解锁跑
  // + 探 direct+proxy；proxy off：hook run() 早退（不检解锁）+ refresh(true,true) 裸 fetch 探 direct 出口。重探全程
  // 状态栏显「检测中…→结果」，失败丢旧值显检测超时。联动只在此点击 handler，绝不进挂载 effect 的 run()——否则每次
  // 进首页都 force 重探 ipInfo、架空 60s TTL（启动/起停/切节点的 ipInfo 刷新已由主进程事件驱动）。reprobeExitIp
  // 内部已吞异常，.finally 收口 reprobing 即可。
  const handleRefresh = () => {
    run();
    if (reprobing) return; // in-flight 去重，同 home-status-bar 的 reprobe 模式
    setReprobing(true);
    void reprobeExitIp().finally(() => setReprobing(false));
  };

  // issue 2：不再挂载即 run()。检测态现驻 store（切页存活）、发起由主进程 backend self-run 驱动；hook 的冷水合只在
  // store 无态时补一次。挂载即 run() 会使每次进首页都强制检测（架空缓存 + 与「切页不重跑」目标冲突），故删除。
  const ai = UNLOCK_SERVICES.filter((s) => s.group === 'ai');
  const media = UNLOCK_SERVICES.filter((s) => s.group === 'media');

  // 状态/地区经 HoverCard 展示（原生 title 在 Electron 不稳、用户悬停看不到；radix HoverCard 稳、portal 不被裁）。
  const renderItem = (s: UnlockService) => {
    const r = results[s.id];
    const status = r?.status ?? 'idle';
    // partial 的 per-service 文案覆盖默认；单一真值供 hover 内容 + aria-label 复用。
    const statusText = t(
      status === 'partial' && s.partialLabelKey ? s.partialLabelKey : STATUS_LABEL_KEY[status]
    );
    return (
      <HoverCard key={s.id} openDelay={500} closeDelay={40}>
        <HoverCardTrigger asChild>
          {/* Low-4 a11y：状态原本仅靠色点 + hover-only HoverCard（非可聚焦 span）传达，键盘/屏阅不可达。
              补 aria-label「服务名: 状态」，配合下方滚动容器 role=group + tabIndex 使其可被读到。 */}
          <span
            className="inline-flex cursor-default items-center gap-1 whitespace-nowrap"
            aria-label={`${s.name}: ${statusText}`}
          >
            <span className="text-[11.5px] font-medium text-fg-dim">{s.short}</span>
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', DOT_CLASS[status])} />
          </span>
        </HoverCardTrigger>
        <HoverCardContent
          side="top"
          align="center"
          className="w-auto whitespace-nowrap p-2 text-[11.5px]"
        >
          <span className="font-medium text-fg">{s.name}</span>
          <span className="text-fg-dim">
            {' · '}
            {statusText}
            {r?.region ? ` · ${r.region}` : ''}
          </span>
          {/* X3（§12.2 P12）：timeout 且出口本身连通（egress 非空）→ 诚实提示「服务经该出口不可达（可能被服务方网络层
              拦截），非检测故障」。不显「已封锁」——无 marker 证据不下 blocked 结论（checkers「绝不误 block」契约）。 */}
          {status === 'timeout' && egress && (
            <div className="mt-1 max-w-[13rem] whitespace-normal text-fg-faint">
              {t(
                isRestrictedEgressRegion(egress.region)
                  ? 'home.unlockRestrictedEgressHint'
                  : 'home.unlockTimeoutHint'
              )}
            </div>
          )}
        </HoverCardContent>
      </HoverCard>
    );
  };

  // 组标签（AI 服务 / 流媒体）已删：服务短名自明、标签占宽易挤占；AI↔流媒体的分隔靠中间竖线，色义靠 per-dot hover 状态文案。
  const renderGroup = (list: UnlockService[]) => (
    <span className="inline-flex items-center gap-2 whitespace-nowrap">{list.map(renderItem)}</span>
  );

  return (
    // 刷新按钮钉死在滚动区外（shrink-0），只有中段服务点分组随窄窗横向滚动 —— 保证刷新永不被挤出。
    <div className="flex min-w-0 items-center gap-2">
      {/* Low-4 a11y：滚动容器补 role=group + tabIndex + aria-label——键盘可 Tab 聚焦、屏阅可作为一组解锁状态读出。 */}
      <div
        className="flex min-w-0 flex-1 items-center gap-2.5 overflow-x-auto"
        role="group"
        tabIndex={0}
        aria-label={t('home.unlockSection')}
      >
        {renderGroup(ai)}
        <span className="h-3 w-px shrink-0 bg-line" />
        {renderGroup(media)}
      </div>
      <HoverCard openDelay={500} closeDelay={40}>
        <HoverCardTrigger asChild>
          {/* wrapper span 承接 hover：禁用态（冷却/在飞）按钮本身不派发 hover 事件，套一层 span 才能显提示 */}
          <span className="inline-flex shrink-0">
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              disabled={running || cooldown || reprobing}
              onClick={handleRefresh}
              aria-label={t('home.unlockRefresh')}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', (running || reprobing) && 'animate-spin')} />
            </Button>
          </span>
        </HoverCardTrigger>
        <HoverCardContent
          side="top"
          align="end"
          className="w-auto whitespace-nowrap p-2 text-[11.5px] text-fg-dim"
        >
          {cooldown ? t('home.unlockCooldown') : t('home.unlockRefresh')}
        </HoverCardContent>
      </HoverCard>
    </div>
  );
}
