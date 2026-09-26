// Package idvalidate 集中校验会被拼进文件系统路径的 ID 与下载路径，
// 避免每个 handler 各写一条正则导致放行范围漂移。不依赖 hub 其余代码，便于独立单测。
package idvalidate

import (
	"regexp"
	"strings"
)

// Error 带 code/params 的校验错误；由调用方转换成各自的用户错误类型。
type Error struct {
	Code   string
	Params map[string]any
	Msg    string
}

func (e *Error) Error() string { return e.Msg }

// ID 允许表：
//
//	SafeID  —— 短不透明 ID 的文件名片段（任务 id、上传件 id、音色 vid）。
//	           约定为 32 位随机 hex（newID 16 字节），故只放行 [a-zA-Z0-9-]，长度 1..32。
//	SafeKey —— 历史索引键（modelId / taskId / groupId）。modelID 取自 models.json，
//	           允许下划线，故放宽到 [a-zA-Z0-9_-]，长度 1..64。
var (
	safeIDRe  = regexp.MustCompile(`^[a-zA-Z0-9-]{1,32}$`)
	safeKeyRe = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,64}$`)
)

// SafeID 校验短 ID 是否可安全用作文件名/目录名片段（[a-zA-Z0-9-]，1..32 位）。
func SafeID(id string) bool { return safeIDRe.MatchString(id) }

// SafeKey 校验历史索引键是否可安全用作目录/文件名片段（[a-zA-Z0-9_-]，1..64 位）。
func SafeKey(s string) bool { return safeKeyRe.MatchString(s) }

// 下载路径校验属于同一套允许表的“路径”分支：
// 目标目录名允许点号，文件相对路径逐段拒绝 .. / 绝对路径 / 盘符，不复用 SafeID。
var targetDirRe = regexp.MustCompile(`^[a-zA-Z0-9._-]{1,64}$`)

// TargetDir 校验目标目录名；纯 "."/".." 这类无字母数字的名字一并拒绝。
func TargetDir(targetDir string) (string, error) {
	ok := targetDirRe.MatchString(targetDir) &&
		strings.ContainsAny(targetDir, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")
	if !ok {
		return "", &Error{Code: "INVALID_TARGET_DIR",
			Params: map[string]any{"targetDir": targetDir}, Msg: "非法目标目录名: " + targetDir}
	}
	return targetDir, nil
}

// FilePath 校验并规范化文件相对路径：防路径穿越，统一为 / 分隔。
func FilePath(raw string) (string, error) {
	p := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	ok := p != "" && len(p) <= 256 && !strings.HasPrefix(p, "/") && !strings.Contains(p, ":")
	if ok {
		for _, seg := range strings.Split(p, "/") {
			if seg == "" || seg == "." || seg == ".." {
				ok = false
				break
			}
		}
	}
	if !ok {
		return "", &Error{Code: "INVALID_FILE_PATH",
			Params: map[string]any{"path": raw}, Msg: "非法文件路径: " + raw}
	}
	return p, nil
}
