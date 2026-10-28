package main

import (
	"fmt"
	"strings"
)

// psEscape 转义 PowerShell 单引号字符串内部的单引号（单引号替换为两个单引号）。
func psEscape(s string) string {
	return strings.ReplaceAll(s, "'", "''")
}

// makeAutoStartShortcutScript 生成在 Windows Startup 目录创建 .lnk 快捷方式的 PowerShell 脚本。
func makeAutoStartShortcutScript(link, exe, workDir string) string {
	return fmt.Sprintf(
		"$shell = New-Object -ComObject WScript.Shell; "+
			"$sc = $shell.CreateShortcut('%s'); "+
			"$sc.TargetPath = '%s'; "+
			"$sc.WorkingDirectory = '%s'; "+
			"$sc.WindowStyle = 7; "+
			"$sc.Description = 'audio.cpp-hub (Go)'; "+
			"$sc.Save();",
		psEscape(link), psEscape(exe), psEscape(workDir))
}
