package main

// 行为常量集中定义，避免魔法数字散落在各文件里、含义漂移。
// 注意：即使数值相同，语义不同的常量也各自命名，不合并复用。

const (
	// 任务队列：单实例排队上限、已完成任务内存保留条数、文本预览截断字数。
	taskQueueSize      = 100
	finishedKeep       = 100
	taskTextPreviewMax = 100

	// 实例：事件日志缓冲上限、日志尾部读取字节数与保留行数。
	instanceEventCap = 20
	logTailBytes     = 64 << 10
	logTailLines     = 10

	// 内部（非代理）HTTP 错误响应体读取上限，防止异常大响应撑爆内存。
	maxErrorBodyBytes = 1 << 20

	// 下载：单分段最小字节数，小于该值不分段。
	dlSegmentMin = 32 * 1024 * 1024
)
