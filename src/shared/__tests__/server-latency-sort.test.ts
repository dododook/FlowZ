/**
 * 节点延迟排序比较器单测（渲染下拉 + 托盘 + 服务器页 sortServers 共用）：
 * 有效延迟按 order 升/降序；无结果（未测 undefined / 超时 -1 或 null）沉底且不随 order 翻转；
 * 两者无结果按名称升序；同延迟稳定（保留入参序）；name 缺失不崩；不原地修改入参。
 */
import { sortServersByLatency } from '../server-latency-sort';

type S = { id: string; name: string };
const s = (id: string, name: string): S => ({ id, name });
const ids = (arr: S[]) => arr.map((x) => x.id);

describe('sortServersByLatency', () => {
  it('全有结果 → 按延迟升序（默认 order=asc）', () => {
    const arr = [s('1', 'A'), s('2', 'B'), s('3', 'C')];
    const lat: Record<string, number> = { '1': 120, '2': 30, '3': 80 };
    expect(ids(sortServersByLatency(arr, (id) => lat[id]))).toEqual(['2', '3', '1']);
  });

  it('order=desc → 有效延迟降序，但无结果仍沉底（不随 order 翻转）', () => {
    const arr = [s('1', 'A'), s('2', 'B'), s('3', 'C')];
    const lat: Record<string, number | undefined> = { '1': 120, '2': 30, '3': undefined };
    // 30,120 降序 → 1(120),2(30)，未测 3 仍沉底
    expect(ids(sortServersByLatency(arr, (id) => lat[id], 'desc'))).toEqual(['1', '2', '3']);
  });

  it('部分有结果 → 已测在前按延迟，未测沉底且按名称', () => {
    const arr = [s('1', 'A'), s('2', 'B'), s('3', 'C'), s('4', 'D')];
    const lat: Record<string, number | undefined> = { '1': 80, '3': 30 };
    // 有效: 3(30),1(80) → 未测: B,D（按名称）
    expect(ids(sortServersByLatency(arr, (id) => lat[id]))).toEqual(['3', '1', '2', '4']);
  });

  it('超时 -1（渲染语义）与 null（托盘语义）均视同无结果沉底', () => {
    const arr = [s('1', 'A'), s('2', 'B'), s('3', 'C')];
    const lat: Record<string, number | null> = { '1': -1, '2': 50, '3': null };
    // 仅 2(50) 有效在前；1,3 无结果沉底按名称（A<C）
    expect(ids(sortServersByLatency(arr, (id) => lat[id]))).toEqual(['2', '1', '3']);
  });

  it('全员无结果 → 按名称升序（无测速结果默认按名称），与 order 无关', () => {
    const arr = [s('1', 'zeta'), s('2', 'alpha'), s('3', 'mid')];
    expect(ids(sortServersByLatency(arr, () => undefined))).toEqual(['2', '3', '1']);
    expect(ids(sortServersByLatency(arr, () => undefined, 'desc'))).toEqual(['2', '3', '1']);
  });

  it('同延迟 → 稳定保留入参顺序（不额外按名称打散）', () => {
    const arr = [s('1', 'Y'), s('2', 'X')];
    expect(ids(sortServersByLatency(arr, () => 50))).toEqual(['1', '2']);
  });

  it('name 缺失/为空 → 不崩、空名按 locale 比较', () => {
    const arr = [{ id: '1' } as unknown as S, s('2', 'b')];
    expect(() => sortServersByLatency(arr, () => undefined)).not.toThrow();
  });

  it('不原地修改入参', () => {
    const arr = [s('1', 'b'), s('2', 'a')];
    const before = [...arr];
    sortServersByLatency(arr, () => undefined);
    expect(arr).toEqual(before);
  });
});
