//go:build !darwin

package main

// procStartTimeOS 非 darwin 无 sysctl kern.proc.pid，返回 "" 让调用方回退 `ps -o lstart=`（秒级）。
func procStartTimeOS(_ int) string {
	return ""
}
