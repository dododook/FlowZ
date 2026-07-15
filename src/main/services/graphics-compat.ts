/**
 * 图形兼容逃生门（用户自救，早期 flag）——纯函数层。
 *
 * 背景：主窗白屏的 D 类向量（Windows Mica 合成 bug 群、GPU 进程反复崩溃、mac 透明/vibrancy）用户此前无自救手段。
 * hardwareAcceleration 开关关闭（=== false）时须在 app ready **之前**调用 app.disableHardwareAcceleration()
 *（Electron 硬约束）——那时 ConfigManager 尚未初始化，只能由 index.ts 早期同步 fs.readFileSync 读 config.json 原文本。
 *
 * 本函数只负责「原文本 → 该不该禁用硬件加速」的解析判定（IO 分离，便于单测）；文件读取由调用方（index.ts）完成。
 *
 * 字段语义为**正向**（对齐本仓 autoCheckUpdate 惯例）：hardwareAcceleration 默认开（true），消费一律 `!== false`。
 * 故此处仅当严格 === false 才判「禁用」；字段缺失/undefined = 默认开 = 不禁（也防 "false"/0 等脏值误禁用户硬件加速）。
 *
 * 容错第一（早期崩 = 整个启动失败）：文件缺失/损坏/空文件/字段缺失/类型非法一律返回 false（=不禁），**绝不抛**。
 */
export function shouldDisableHardwareAcceleration(
  rawConfigText: string | null | undefined
): boolean {
  if (typeof rawConfigText !== 'string' || rawConfigText.trim() === '') return false;
  try {
    const parsed = JSON.parse(rawConfigText) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return (parsed as Record<string, unknown>).hardwareAcceleration === false;
  } catch {
    // JSON 解析失败（损坏/截断配置）：视为默认开，不禁，绝不抛。
    return false;
  }
}
