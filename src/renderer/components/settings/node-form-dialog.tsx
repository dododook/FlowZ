/**
 * 节点弹窗的两个外壳（Conduit 标准三段式：`.nd-dlg-h` 头 / `.nd-dlg-body` 滚动正文 / `.nd-dlg-foot` 固定页脚）。
 *
 * **为什么要有这层**（issue #350 的根因）：协议表单（`*-form.tsx`）渲染 `<form id="node-cfg-form">`，但
 * **自身一个提交按钮都没有**——按钮靠 HTML 的 `form=` 属性从表单外面跨节点绑进来。这在组件契约里是一条
 * **不可见、无类型、无强制**的义务：「挂了我，你就得在某处渲染一个 `form="node-cfg-form"` 的按钮」。
 * tsc 查不出、渲染不报错，三个宿主漏了两个（组网 WireGuard 无添加按钮 = #350；Tailscale 设置无保存按钮）。
 *
 * 故把义务从宿主手里收走，并**按构造分成两个组件**，而不是靠一个 `hideFooter` 开关：
 *
 * | 组件 | 页脚 | 正文 | 用于 |
 * |---|---|---|---|
 * | `NodeFormDialog`  | **恒渲染**，无从关闭 | render-prop，拿到包好提交态的 `submit` | 挂协议表单 |
 * | `NodePanelDialog` | **恒不渲染** | 普通 children | 挂自带按钮的面板（今天仅 WARP 一键注册） |
 *
 * 早期版本是单组件 + `hideFooter?: boolean`。那把「不写就坏」换成了「写一个 token 就坏」——给挂着协议表单的
 * 宿主加一个 `hideFooter`，#350 原样长回来，而接线门四条断言无一读它（实测全绿）。拆开之后页脚的有无由
 * **选哪个组件**决定，`hideFooter` 这个 prop 不存在了。
 *
 * **但「选哪个组件」本身可以是运行时分支，故等价性不是白来的**：宿主同时持有两个外壳时（今天
 * `server-config-dialog` 与 `mesh-access-entry` 都是），用哪个由一个谓词决定，而接线门的「宿主只能经
 * `NodeFormDialog` 挂」是**文件级**子串判据，读不到这个谓词——往谓词里多放一个协议，表单就落进无页脚
 * 外壳、#350 原样复发，而那条断言仍全绿（实测）。差别只是可达面从「任意宿主」收窄到了「双外壳文件」。
 * 补法不在本组件而在宿主 + 门：宿主把谓词提成 `PANEL_PROTOCOLS` 常量集，门对账「该集合 ∩ 挂了协议表单的
 * 协议 = ∅」（接线门第 ⑤ 条）。**新增双外壳宿主时必须照此声明谓词，否则那个宿主不受门约束。**
 *
 * 同理不给 `busy` prop：提交态由 `NodeFormDialog` 自持，宿主想手搓多传的 prop 直接 tsc 报错。
 * 面板不需要——`WarpPanel` 自持 `loading` 驱动自己的按钮。
 *
 * **`CustomForm` 已归一到协议表单契约**（渲染 `<form id="node-cfg-form">`、不自带按钮），于是 custom 档
 * 不再走面板外壳。这消掉了宿主 `server-config-dialog` 里的**运行时组件类型翻转**：切到该协议时
 * `isPanel` 由 false 翻 true，React 视作不同组件类型 → 弹窗整树卸载重挂（焦点掉出模态、`FormSection`
 * 折叠区与正文滚动复位、开场动画重放）。代价：失去「JSON 非法则按钮置灰」这一处 affordance，
 * 校验改由提交时的 `jsonError` 红字承担，与其余 14 个表单口径一致。
 *
 * a11y：`DialogTitle` / `DialogDescription` 都用 `asChild` 套在**可见元素**上。早期版本额外渲染一份
 * `sr-only` 的标题与说明，而 `sr-only` 是 clip 不是 `display:none`、仍在可访问性树内 → 辅助技术把标题和
 * 说明各读两遍。现在各只有一个节点。
 *
 * **已知且刻意不做**：`node-cfg-form` 是全局 DOM id，两个此类弹窗并存时 `form=` 按文档顺序绑第一个。
 * 今天各调用点互斥、该状态不可达，属 YAGNI。真要治是本外壳用 `useId()` 生成唯一 id 经 context 下发，
 * 代价是 15 个表单文件都要改 `id=`——等真出现并存场景再做。
 */
import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';

/** 协议表单的 `<form>` id：页脚按钮经 HTML `form=` 跨节点绑定到它。 */
export const NODE_FORM_ID = 'node-cfg-form';

interface ChromeProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 标题：既是视觉标题，也是 radix 的 a11y 标题（同一个节点）。 */
  title: string;
  /** 说明：正文首段可见，同时是 radix 的 a11y 描述（同一个节点）。 */
  description: string;
}

/** 两个外壳共用的 chrome。不导出——页脚的有无必须由「选哪个组件」决定，不给第三条路。 */
function DialogChrome({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
}: ChromeProps & { footer?: ReactNode; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* overflow-hidden + flex-col：正文自己滚，头与脚贴住不动。radix 自带关闭按钮隐掉，改用 .nd-dlg-x。 */}
      <DialogContent className="[&>button]:hidden flex max-h-[90vh] w-[min(452px,94vw)] max-w-none flex-col gap-0 overflow-hidden rounded-[12px] border-line bg-surface p-0">
        <div className="nd-dlg-h">
          {/* asChild：可见标题本身就是 radix 的 Title，不再额外渲染 sr-only 副本（否则辅助技术读两遍）。
              child 必须是 h1–h6：radix 的 DialogTitle 本体是 Primitive.h2，asChild 后渲染的是 child 的标签，
              套 span 会让弹窗子树内 heading 数归零（按 H 跳标题 / rotor 标题列表少一项）——那正是本组件
              要消除重复朗读时顺手弄丢的东西，与改进方向相反。视觉零变化：preflight 已把 h1–h6 的
              font-size/font-weight 置 inherit、margin 置 0，字号字重仍由 .nd-dlg-title 决定。 */}
          <DialogTitle asChild>
            <h2 className="nd-dlg-title">{title}</h2>
          </DialogTitle>
          <button
            type="button"
            className="nd-dlg-x"
            aria-label={t('common.cancel', 'Cancel')}
            onClick={() => onOpenChange(false)}
          >
            <X />
          </button>
        </div>

        <div className="nd-dlg-body">
          {/* asChild + 不自带 class：字号/配色沿用 DialogDescription 的设计系统默认，
              自己再写 text-xs 会与 radix 注入的 text-sm 打架（class 串里两个字号，胜负由样式表顺序定）。 */}
          <DialogDescription asChild>
            <p>{description}</p>
          </DialogDescription>
          {children}
        </div>

        {footer}
      </DialogContent>
    </Dialog>
  );
}

interface NodeFormDialogProps extends ChromeProps {
  /** 提交按钮文案：新增用「添加」、编辑用「保存」。 */
  submitLabel: string;
  /**
   * 提交处理。**由外壳调用并自管「提交中」态**——宿主不必、也无法再自持提交态。
   * 语义：调用即置灰两个按钮 + 提交按钮转圈，`finally` 复位（抛错也复位，错误处理仍归宿主）。
   */
  onSubmit: (config: any) => Promise<void>;
  /** render-prop：外壳把**包好提交态**的 submit 递下去，宿主原样交给协议表单的 `onSubmit`。 */
  children: (submit: (config: any) => Promise<void>) => ReactNode;
}

/** 挂协议表单的弹窗：页脚恒在。 */
export function NodeFormDialog({
  submitLabel,
  onSubmit,
  children,
  ...chrome
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
    <DialogChrome
      {...chrome}
      footer={
        <div className="nd-dlg-foot">
          <button type="reset" form={NODE_FORM_ID} className="btn ghost sm" disabled={busy}>
            {t('common.reset')}
          </button>
          <button type="submit" form={NODE_FORM_ID} className="btn flow sm" disabled={busy}>
            {busy && <Loader2 className="animate-spin" size={14} />}
            {submitLabel}
          </button>
        </div>
      }
    >
      {children(submit)}
    </DialogChrome>
  );
}

/**
 * 挂**自带按钮的面板**的弹窗：无页脚。
 * 只有这一种正当用途（今天仅 WARP 一键注册面板）；挂协议表单请用 `NodeFormDialog`，
 * 否则用户填完无从提交（= issue #350）。
 *
 * 门的射程如实记：宿主**不**引用 `NodeFormDialog` 而直挂表单 → 判红；宿主**同时**引用两个外壳、
 * 靠运行时谓词把表单送进本组件 → 文件级判据读不到，须由宿主声明 `PANEL_PROTOCOLS` 常量集配合
 * 接线门第 ⑤ 条才判得出。
 */
export function NodePanelDialog({ children, ...chrome }: ChromeProps & { children: ReactNode }) {
  return <DialogChrome {...chrome}>{children}</DialogChrome>;
}
