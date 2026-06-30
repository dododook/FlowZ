import {
  resolveCliEarlyExit,
  cliHelpText,
  systemLanguagesFromEnv,
  runCliEarlyExit,
  type CliEarlyExitIo,
} from '../cli-early-exit';

describe('resolveCliEarlyExit', () => {
  const withDisplay = { DISPLAY: ':0' };
  const noDisplay = {};

  it('-V / --version → version（三平台通用，与显示环境无关）', () => {
    expect(resolveCliEarlyExit(['-V'], noDisplay, 'linux')).toBe('version');
    expect(resolveCliEarlyExit(['--version'], withDisplay, 'darwin')).toBe('version');
    expect(resolveCliEarlyExit(['--version'], noDisplay, 'win32')).toBe('version');
  });

  it('-h / --help → help', () => {
    expect(resolveCliEarlyExit(['-h'], withDisplay, 'win32')).toBe('help');
    expect(resolveCliEarlyExit(['--help'], noDisplay, 'linux')).toBe('help');
  });

  it('CLI flag 优先于 headless（-V + 无 DISPLAY → version，不是 headless）', () => {
    expect(resolveCliEarlyExit(['-V'], noDisplay, 'linux')).toBe('version');
  });

  it('Linux 无 DISPLAY/WAYLAND + 非 flag → headless', () => {
    expect(resolveCliEarlyExit([], noDisplay, 'linux')).toBe('headless');
  });

  it('Linux 有 DISPLAY 或 WAYLAND_DISPLAY → none（正常启动）', () => {
    expect(resolveCliEarlyExit([], withDisplay, 'linux')).toBe('none');
    expect(resolveCliEarlyExit([], { WAYLAND_DISPLAY: 'wayland-0' }, 'linux')).toBe('none');
  });

  it('macOS / Windows 无 DISPLAY + 非 flag → none（headless 早退仅覆盖 Linux）', () => {
    expect(resolveCliEarlyExit([], noDisplay, 'darwin')).toBe('none');
    expect(resolveCliEarlyExit([], noDisplay, 'win32')).toBe('none');
  });

  it('正常 GUI 启动（无 flag + 有 DISPLAY）→ none', () => {
    expect(resolveCliEarlyExit(['/path/to/app'], withDisplay, 'linux')).toBe('none');
  });
});

describe('cliHelpText', () => {
  it('含版本 + 用法 + flag 说明', () => {
    const t = cliHelpText('4.1.7');
    expect(t).toContain('FlowZ 4.1.7');
    expect(t).toContain('Usage:');
    expect(t).toContain('--version');
    expect(t).toContain('--help');
  });
});

describe('systemLanguagesFromEnv', () => {
  it('LANGUAGE 冒号分隔优先级列表按序展开', () => {
    expect(systemLanguagesFromEnv({ LANGUAGE: 'de_DE:ru_RU:en_US' })).toEqual([
      'de-DE',
      'ru-RU',
      'en-US',
    ]);
  });

  it('剥 .codeset / @modifier，保留地区子标签（zh_HK.UTF-8 → zh-HK 可判繁体）', () => {
    expect(systemLanguagesFromEnv({ LANG: 'zh_HK.UTF-8' })).toEqual(['zh-HK']);
    expect(systemLanguagesFromEnv({ LANG: 'sr_RS.UTF-8@latin' })).toEqual(['sr-RS']);
  });

  it('GNU 优先级 LANGUAGE > LC_ALL > LC_MESSAGES > LANG', () => {
    expect(
      systemLanguagesFromEnv({
        LANGUAGE: 'ru_RU',
        LC_ALL: 'fa_IR',
        LC_MESSAGES: 'en_US',
        LANG: 'zh_CN',
      })
    ).toEqual(['ru-RU', 'fa-IR', 'en-US', 'zh-CN']);
  });

  it('C / POSIX / 空值滤除；全空 → 空列表', () => {
    expect(systemLanguagesFromEnv({ LANG: 'C' })).toEqual([]);
    expect(systemLanguagesFromEnv({ LC_ALL: 'POSIX', LANG: '' })).toEqual([]);
    expect(systemLanguagesFromEnv({})).toEqual([]);
  });

  it('C-override：messages locale 为 C/POSIX(含 C.UTF-8) → 忽略 LANGUAGE，落空(→en fallback)', () => {
    expect(systemLanguagesFromEnv({ LANGUAGE: 'de_DE:ru_RU', LANG: 'C' })).toEqual([]);
    expect(systemLanguagesFromEnv({ LANGUAGE: 'de_DE', LC_ALL: 'C.UTF-8' })).toEqual([]);
    // messages 非 C → LANGUAGE 正常生效
    expect(systemLanguagesFromEnv({ LANGUAGE: 'ru_RU', LANG: 'en_US.UTF-8' })).toEqual([
      'ru-RU',
      'en-US',
    ]);
  });
});

describe('runCliEarlyExit（IO 注入编排）', () => {
  const baseIo = (
    over: Partial<CliEarlyExitIo>
  ): { io: CliEarlyExitIo; calls: Record<string, jest.Mock> } => {
    const calls = {
      writeStdout: jest.fn(),
      writeStderr: jest.fn(),
      setLanguage: jest.fn(),
      exit: jest.fn(),
    };
    const io: CliEarlyExitIo = {
      argv: [],
      env: {},
      platform: 'linux',
      getVersion: () => '9.9.9',
      writeStdout: calls.writeStdout,
      writeStderr: calls.writeStderr,
      setLanguage: calls.setLanguage,
      headlessMessage: () => 'HEADLESS_MSG',
      exit: calls.exit,
      ...over,
    };
    return { io, calls };
  };

  it('version：stdout 写版本 + exit(0)，返 true，不碰 stderr/语言', () => {
    const { io, calls } = baseIo({ argv: ['-V'] });
    expect(runCliEarlyExit(io)).toBe(true);
    expect(calls.writeStdout).toHaveBeenCalledWith('FlowZ 9.9.9\n');
    expect(calls.exit).toHaveBeenCalledWith(0);
    expect(calls.writeStderr).not.toHaveBeenCalled();
    expect(calls.setLanguage).not.toHaveBeenCalled();
  });

  it('help：stdout 写用法 + exit(0)', () => {
    const { io, calls } = baseIo({ argv: ['--help'] });
    expect(runCliEarlyExit(io)).toBe(true);
    expect(calls.writeStdout.mock.calls[0][0]).toContain('Usage:');
    expect(calls.exit).toHaveBeenCalledWith(0);
  });

  it('headless：setLanguage 收 env 解析列表 → stderr 写提示 + exit(1)', () => {
    const { io, calls } = baseIo({ argv: [], env: { LANG: 'ru_RU.UTF-8' } });
    expect(runCliEarlyExit(io)).toBe(true);
    expect(calls.setLanguage).toHaveBeenCalledWith(['ru-RU']); // 经 systemLanguagesFromEnv
    expect(calls.writeStderr).toHaveBeenCalledWith('HEADLESS_MSG\n');
    expect(calls.exit).toHaveBeenCalledWith(1);
    expect(calls.writeStdout).not.toHaveBeenCalled();
  });

  it('none（有 DISPLAY，无 flag）：零副作用，返 false', () => {
    const { io, calls } = baseIo({ argv: [], env: { DISPLAY: ':0' } });
    expect(runCliEarlyExit(io)).toBe(false);
    expect(calls.writeStdout).not.toHaveBeenCalled();
    expect(calls.writeStderr).not.toHaveBeenCalled();
    expect(calls.setLanguage).not.toHaveBeenCalled();
    expect(calls.exit).not.toHaveBeenCalled();
  });
});
