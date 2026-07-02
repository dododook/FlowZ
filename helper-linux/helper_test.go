//go:build linux

package main

import (
	"os"
	"path/filepath"
	"testing"
)

// isAuthorized：授权 uid 列表解析 + root 恒授权 + 缺文件失败安全。
func TestIsAuthorized(t *testing.T) {
	dir := t.TempDir()
	f := filepath.Join(dir, "auth")
	if err := os.WriteFile(f, []byte("1000\n1001\n\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	authFile = f
	for _, uid := range []uint32{1000, 1001} {
		if !isAuthorized(uid) {
			t.Errorf("uid %d 应被授权", uid)
		}
	}
	if isAuthorized(1002) {
		t.Error("uid 1002 不在列表，不应被授权")
	}
	if !isAuthorized(0) {
		t.Error("root(0) 应恒被授权")
	}
	// 缺失授权文件 → 非 root 一律未授权（失败安全），root 仍授权。
	authFile = filepath.Join(dir, "nonexistent")
	if isAuthorized(1000) {
		t.Error("授权文件缺失时非 root 应未授权")
	}
	if !isAuthorized(0) {
		t.Error("授权文件缺失时 root 仍应授权")
	}
}

// ownedBy：属主校验（open+fstat）。
func TestOwnedBy(t *testing.T) {
	f := filepath.Join(t.TempDir(), "x")
	if err := os.WriteFile(f, []byte("y"), 0o644); err != nil {
		t.Fatal(err)
	}
	self := uint32(os.Getuid())
	if ok, err := ownedBy(f, self); err != nil || !ok {
		t.Errorf("本进程 uid 应拥有自建文件: ok=%v err=%v", ok, err)
	}
	if ok, _ := ownedBy(f, self+9999); ok {
		t.Error("错误 uid 不应通过属主校验")
	}
	if ok, err := ownedBy(filepath.Join(t.TempDir(), "none"), self); ok || err == nil {
		t.Error("不存在的路径应返回 false + err")
	}
}

// ssPidRe：从 ss 输出行提取 LISTEN 持有者 pid。
func TestSsPidRe(t *testing.T) {
	line := `LISTEN 0 4096 0.0.0.0:9090 0.0.0.0:* users:(("sing-box",pid=1234,fd=7))`
	m := ssPidRe.FindAllStringSubmatch(line, -1)
	if len(m) != 1 || m[0][1] != "1234" {
		t.Errorf("期望提取 pid=1234，实际 %v", m)
	}
	if got := ssPidRe.FindAllStringSubmatch("no match here", -1); len(got) != 0 {
		t.Errorf("无 pid 行不应匹配，实际 %v", got)
	}
}
