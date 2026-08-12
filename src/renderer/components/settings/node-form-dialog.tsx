/**
 * 节点协议表单的弹窗外壳（Conduit 标准三段式：`.nd-dlg-h` 头 / `.nd-dlg-body` 滚动正文 / `.nd-dlg-foot` 固定页脚）。
 *
 * **为什么要有这层**（issue #350 的根因）：协议表单（`*-form.tsx`）渲染 `<form id="node-cfg-form">`，但
 * **自身一个提交按钮都没有**——按钮靠 HTML 的 `form=` 属性从表单外面跨节点绑进来。这在组件契约里是一条
 * **不可见、无类型、无强制**的义务：「挂了我，你就得在某处渲染一个 `form="node-cfg-form"` 的按钮」。
 * tsc 查不出、渲染不报错、类型不缺，三个宿主漏了两个（组网 WireGuard 无添加按钮 = #350；Tailscale 设置
 * 无保存按钮 = 同款未被报告的姊妹腿）。逐处补按钮只是把已漏的补上，义务原样留着，下一个宿主照样能漏。
 *
 * 故把义务从宿主手里收走：**页脚由本外壳渲染，宿主默认无从省略**（唯一例外是 `hideFooter`，见其 JSDoc；
 * 它没有被按构造关掉，只是从「不写就坏」变成「得主动写一个明令禁止的 prop 才坏」）。同时顺带收编两件
 * 本来也在各处重复决定的事：
 *  · 滚动结构——正文是唯一滚动区，页脚**不随表单主体滚动**（长表单如 WireGuard 才不会让提交按钮沉到折叠线下）；
 *  · `form="node-cfg-form"` 这个跨节点绑定的字面量——全仓提交按钮只此一处。
 *
 * **已知且刻意不做**：`node-cfg-form` 是全局 DOM id，两个此类弹窗同时挂载时 `form=` 按文档顺序绑第一个。
 * 今天四处调用点互斥、该状态不可达，属 YAGNI。真要治是本外壳用 `useId()` 生成唯一 id 经 context 下发，
 * 代价是 15 个表单文件都要改 `id=`——等真出现并存场景再做。
 */
import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

/** 协议表单的 `<form>` id：页脚按钮经 HTML `form=` 跨节点绑定到它。 */
export const NODE_FORM_ID = 'node-cfg-form';

interface NodeFormDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 视觉标题（同时供 a11y）。 */
  title: string;
  /** a11y 描述（sr-only）。要给用户看的说明请作为 children 的首个段落，别塞这里。 */
  description: string;
  /** 提交按钮文案：新增用「添加」、编辑用「保存」。 */
  submitLabel: string;
  /**
   * 提交处理。**由外壳调用并自管「提交中」态**——宿主不必、也无法再自持提交态。
   *
   * 刻意**不给** `busy` prop：那会造出第二条可选的宿主义务（「记得把提交态透传进来」），
   * 与本外壳收编页脚的理由自相矛盾——三处调用点里已经有两处忘过一次同类义务了。
   * 现在忘无可忘：宿主想手搓提交态，多传的 prop 直接 tsc 报错，是结构性强制而非又一道门。
   *
   * 语义：调用即置灰两个按钮 + 提交按钮转圈，`finally` 复位（抛错也复位，错误处理仍归宿主）。
   */
  onSubmit: (config: any) => Promise<void>;
  /**
   * 不渲染页脚。**唯一合法用途**：正文里挂的不是协议表单，而是自带按钮的面板
   * （WARP 一键注册 / custom 的 JSON 直填）。挂了协议表单还传它 = 复现 #350。
   */
  hideFooter?: boolean;
  /** render-prop：外壳把**包好提交态**的 submit 递下去，宿主原样交给协议表单的 `onSubmit`。 */
  children: (submit: (config: any) => Promise<void>) => ReactNode;
}

export function NodeFormDialog({
  open,
  onOpenChange,
  title,
  description,
  submitLabel,
  onSubmit,
  hideFooter = false,
  children,
}: NodeFormDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);

  // 成功提交后宿主通常会关弹窗，但关的是 radix 的 open——本组件仍挂载，故 finally 里的复位安全。
  const submit = useCallback(
    async (config: any) => {
      setBusy(true);
      try {
        await onSubmit(config);
      } finally {
        setBusy(false);
      }
    },
    [onSubmit]
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* overflow-hidden + flex-col：正文自己滚，头与脚贴住不动。radix 自带关闭按钮隐掉，改用 .nd-dlg-x。 */}
      <DialogContent className="[&>button]:hidden flex max-h-[90vh] w-[min(452px,94vw)] max-w-none flex-col gap-0 overflow-hidden rounded-[12px] border-line bg-surface p-0">
        {/* a11y：radix 需 Title/Description；视觉标题在下方 .nd-dlg-h，此处仅供辅助技术。 */}
        <DialogTitle className="sr-only">{title}</DialogTitle>
        <DialogDescription className="sr-only">{description}</DialogDescription>

        <div className="nd-dlg-h">
          <span className="nd-dlg-title">{title}</span>
          <button
            type="button"
            className="nd-dlg-x"
            aria-label={t('common.cancel', 'Cancel')}
            onClick={() => onOpenChange(false)}
          >
            <X />
          </button>
        </div>

        <div className="nd-dlg-body">{children(submit)}</div>

        {!hideFooter && (
          <div className="nd-dlg-foot">
            <button type="reset" form={NODE_FORM_ID} className="btn ghost sm" disabled={busy}>
              {t('common.reset')}
            </button>
            <button type="submit" form={NODE_FORM_ID} className="btn flow sm" disabled={busy}>
              {busy && <Loader2 className="animate-spin" size={14} />}
              {submitLabel}
            </button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
