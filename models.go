package main

import (
	_ "embed"
	"encoding/json"
)

// models.json 由 src/main/resources/models.json 复制而来，直接嵌入二进制。
//
//go:embed models.json
var modelsRaw []byte

var models []map[string]any
var modelCatalogJSON []byte

func init() {
	if err := json.Unmarshal(modelsRaw, &models); err != nil {
		panic("models.json 解析失败: " + err.Error())
	}
	// The picker enum is the single source of truth for selectable preset IDs.
	for _, model := range models {
		caps, _ := model["capabilities"].(map[string]any)
		param := optString(caps, "presetVoiceParam")
		if param == "" {
			continue
		}
		schema, _ := model["paramSchema"].(map[string]any)
		preset, _ := schema[param].(map[string]any)
		if optString(preset, "type") != "enum" {
			continue
		}
		values, _ := preset["values"].([]any)
		voices := make([]string, 0, len(values))
		for _, value := range values {
			if id, ok := value.(string); ok && id != "" {
				voices = append(voices, id)
			}
		}
		if len(voices) > 0 {
			caps["presetVoices"] = voices
		}
	}
	encoded, err := json.Marshal(models)
	if err != nil {
		panic("模型清单序列化失败: " + err.Error())
	}
	modelCatalogJSON = encoded
}

// findModel 按 id 查找模型条目，不存在返回 nil。
func findModel(id string) map[string]any {
	for _, m := range models {
		if s, _ := m["id"].(string); s == id {
			return m
		}
	}
	return nil
}

// modelCategory 取模型类别（tts/asr/...），缺省 other。
func modelCategory(id string) string {
	if m := findModel(id); m != nil {
		if s, ok := m["category"].(string); ok {
			return s
		}
	}
	return "other"
}
