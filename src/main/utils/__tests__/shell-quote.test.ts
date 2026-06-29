import { shq } from '../shell-quote';

describe('shq（shell 单引号转义）', () => {
  it('普通字符串：整体单引号包裹', () => {
    expect(shq('/usr/bin/sing-box')).toBe(`'/usr/bin/sing-box'`);
  });

  it("含单引号：闭合-转义-重开（'\\''）", () => {
    expect(shq(`a'b`)).toBe(`'a'\\''b'`);
  });

  it('shell 元字符（$ ` ; & | 空格）单引号内全部失活', () => {
    const raw = `$(touch /tmp/x)\`id\`; rm -rf / & echo hi`;
    // 仅被单引号包裹，内部不含未转义单引号 → POSIX sh 视为纯字面量，无命令替换/分隔
    expect(shq(raw)).toBe(`'${raw}'`);
  });

  it('空字符串：一对空单引号', () => {
    expect(shq('')).toBe(`''`);
  });

  it('多个单引号：逐个转义', () => {
    expect(shq(`''`)).toBe(`''\\'''\\'''`);
  });
});
