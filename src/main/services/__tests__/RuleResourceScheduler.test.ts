/**
 * RuleResourceScheduler.formatRuleUpdateSummary 单测：汇总日志带失败明细（资源名: errorCode）。
 * 纯函数，免 mock scheduler 的 configManager/ruleResourceManager/定时器全套依赖。
 */
jest.mock('electron', () => ({
  app: { getPath: () => '/fake/userData', getAppPath: () => '/fake/app', isPackaged: false },
}));

import { formatRuleUpdateSummary } from '../RuleResourceScheduler';
import type { RuleResourceDownloadResult } from '../../../shared/types';

const r = (over: Partial<RuleResourceDownloadResult>): RuleResourceDownloadResult => ({
  ok: false,
  ...over,
});

describe('formatRuleUpdateSummary', () => {
  it('全成功 → ok=N、failed=0、无失败明细', () => {
    expect(formatRuleUpdateSummary([r({ ok: true }), r({ ok: true })])).toEqual({
      ok: 2,
      failed: 0,
      failures: [],
    });
  });

  it('有失败 → 明细「资源名: errorCode」（排查 timeout / http / invalid_content 不再靠猜）', () => {
    const res = formatRuleUpdateSummary([
      r({ ok: true }),
      r({ ok: false, name: 'geoip-ir', errorCode: 'timeout' }),
      r({ ok: false, name: 'geosite-cn', errorCode: 'invalid_content' }),
    ]);
    expect(res.ok).toBe(1);
    expect(res.failed).toBe(2);
    expect(res.failures).toEqual(['geoip-ir: timeout', 'geosite-cn: invalid_content']);
  });

  it('errorCode 缺 → 退到 error；都缺 → unknown；name 缺 → 退到 id 再退到 ?', () => {
    expect(formatRuleUpdateSummary([r({ ok: false, name: 'x', error: 'boom' })]).failures).toEqual([
      'x: boom',
    ]);
    expect(formatRuleUpdateSummary([r({ ok: false, id: 'rid' })]).failures).toEqual([
      'rid: unknown',
    ]);
    expect(formatRuleUpdateSummary([r({ ok: false })]).failures).toEqual(['?: unknown']);
  });

  it('空 results → 全 0', () => {
    expect(formatRuleUpdateSummary([])).toEqual({ ok: 0, failed: 0, failures: [] });
  });
});
