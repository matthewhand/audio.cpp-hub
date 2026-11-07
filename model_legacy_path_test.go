package main

import (
	"path/filepath"
	"testing"
)

func TestCompletedLegacyDownloadConfiguredRoots(t *testing.T) {
	for _, entry := range []struct{ model, packageID string }{
		{"supertonic", "supertonic_3_q8_0"},
		{"chatterbox", "chatterbox_safetensors"},
	} {
		t.Run(entry.model, func(t *testing.T) {
			pkg := resolvePackage(findPackageFamily(entry.model), entry.packageID)
			if pkg == nil || pkg.PrimaryFile != "" {
				t.Fatalf("expected legacy directory package: %#v", pkg)
			}
			task := &DownloadTask{ID: "legacy-root", ModelID: entry.model, PackageID: pkg.ID, TargetDir: pkg.TargetDir, Status: dlStatusDone}
			for _, f := range pkg.Files {
				local := f.Local
				if local == "" {
					local = f.Remote
				}
				task.Files = append(task.Files, &dlFileEntry{Path: local, Completed: true})
			}
			for _, root := range []string{"models", "weights", filepath.Join(t.TempDir(), "absolute-models")} {
				manager := &DownloadManager{modelsDir: root, tasks: map[string]*DownloadTask{task.ID: task}, order: []*DownloadTask{task}}
				want := filepath.ToSlash(filepath.Join(root, pkg.TargetDir))
				if got := manager.List()[0]["weightsPath"]; got != want {
					t.Fatalf("list directory %v, want %s", got, want)
				}
				detail, err := manager.Get(task.ID)
				if err != nil || detail["weightsPath"] != want {
					t.Fatalf("detail directory %#v, %v", detail, err)
				}
				task.Files[0].Completed = false
				if got := manager.completedDownloadWeightsPath(task); got != "" {
					t.Fatalf("unfinished legacy file selected %q", got)
				}
				task.Files[0].Completed = true
				saved := task.Files
				task.Files = task.Files[1:]
				if got := manager.completedDownloadWeightsPath(task); got != "" {
					t.Fatalf("missing legacy file selected %q", got)
				}
				task.Files = saved
			}
		})
	}
}
