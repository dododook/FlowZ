/** 解析 macOS `route -n get <target>` 输出中的实际出口接口。 */
export function parseMacRouteInterface(output: string): string | null {
  const match = output.match(/^\s*interface:\s*([^\s]+)\s*$/m);
  if (!match) return null;
  const name = match[1];
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(name) ? name : null;
}
