/**
 * RuleResourceManager.syncMissingNow 单测：备份恢复后只补「磁盘文件缺失」的用户规则资源。
 *
 * 备份只含 config(ruleResources 元数据)、不含 .srs 本体 → 跨机/全新恢复后文件缺失 → fail-closed 跳过引用规则；
 * syncMissingNow 即时补回（仅缺失、不重下已在、不受自动更新开关门控），download 内部对引用中+缺失资源触发 core reload。
 *
 * 用真实临时目录写/删 .srs 控制「文件是否在」（fs.existsSync 在本环境不可 spy）+ stub buildRedownloadItem/download
 * （不触网），断言：只重下缺失项、全在则零下载、计数正确、空列表安全。
 */
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'flowz-syncmissing-'));
jest.mock('electron', () => ({
  app: { getPath: () => TMP },
  net: {},
}));

import { RuleResourceManager } from '../RuleResourceManager';
import { getRuleResourcesPath } from '../../utils/paths';

const DIR = getRuleResourcesPath();
fs.mkdirSync(DIR, { recursive: true });

const AMAZON = 'geosite-amazon.srs';
const NETFLIX = 'geosite-netflix.srs';
const writeRes = (fileName: string) => fs.writeFileSync(path.join(DIR, fileName), 'SRS');
const rmRes = (fileName: string) => {
  try {
    fs.unlinkSync(path.join(DIR, fileName));
  } catch {
    /* 不存在即可 */
  }
};

const RES = [
  {
    id: 'geosite-amazon',
    name: 'amazon',
    category: 'geosite',
    sourceUrl: 'https://x/a.srs',
    fileName: AMAZON,
    format: 'binary',
    size: 1,
    downloadedAt: '',
  },
  {
    id: 'geosite-netflix',
    name: 'netflix',
    category: 'geosite',
    sourceUrl: 'https://x/n.srs',
    fileName: NETFLIX,
    format: 'binary',
    size: 1,
    downloadedAt: '',
  },
];

function makeRM(ruleResources: unknown[]) {
  const configManager = { loadConfig: jest.fn().mockResolvedValue({ ruleResources }) };
  const rm = new RuleResourceManager(
    configManager as never,
    jest.fn(), // emitProgress
    jest.fn(), // broadcastConfigChanged
    jest.fn() // notifyCoreReload
  );
  return { rm, configManager };
}

beforeEach(() => {
  rmRes(AMAZON);
  rmRes(NETFLIX);
});
afterEach(() => jest.restoreAllMocks());

describe('RuleResourceManager.syncMissingNow（备份恢复补缺）', () => {
  it('仅重下「文件缺失」的资源，不动已在的', async () => {
    writeRes(AMAZON); // amazon 在、netflix 缺失
    const { rm } = makeRM(RES);
    const buildSpy = jest
      .spyOn(rm as any, 'buildRedownloadItem')
      .mockImplementation(async (r: any) => ({ catalogId: r.id }));
    const downloadSpy = jest
      .spyOn(rm, 'download')
      .mockResolvedValue([{ ok: true, id: 'geosite-netflix' }] as never);

    const res = await rm.syncMissingNow();

    expect(buildSpy).toHaveBeenCalledTimes(1); // 只为缺失项构造重下项
    expect(downloadSpy).toHaveBeenCalledWith([{ catalogId: 'geosite-netflix' }], { silent: true });
    expect(res).toEqual({ missing: 1, ok: 1, failed: 0 });
  });

  it('全部文件已在 → 不下载，返回 missing:0', async () => {
    writeRes(AMAZON);
    writeRes(NETFLIX);
    const { rm } = makeRM(RES);
    const downloadSpy = jest.spyOn(rm, 'download').mockResolvedValue([] as never);

    const res = await rm.syncMissingNow();

    expect(downloadSpy).not.toHaveBeenCalled();
    expect(res).toEqual({ missing: 0, ok: 0, failed: 0 });
  });

  it('多个缺失 + 部分失败 → 计数正确', async () => {
    // 两个都不写 → 都缺
    const { rm } = makeRM(RES);
    jest
      .spyOn(rm as any, 'buildRedownloadItem')
      .mockImplementation(async (r: any) => ({ catalogId: r.id }));
    jest.spyOn(rm, 'download').mockResolvedValue([
      { ok: true, id: 'geosite-amazon' },
      { ok: false, id: 'geosite-netflix', errorCode: 'network' },
    ] as never);

    const res = await rm.syncMissingNow();
    expect(res).toEqual({ missing: 2, ok: 1, failed: 1 });
  });

  it('无 ruleResources → 安全返回 missing:0，不下载', async () => {
    const { rm } = makeRM([]);
    const downloadSpy = jest.spyOn(rm, 'download');
    const res = await rm.syncMissingNow();
    expect(downloadSpy).not.toHaveBeenCalled();
    expect(res).toEqual({ missing: 0, ok: 0, failed: 0 });
  });
});
