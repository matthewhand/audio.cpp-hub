package main

import (
	"path/filepath"
	"strings"
	"testing"
)

func TestNemotronCompletedDownloadPrimaryFiles(t *testing.T) {
	cases := map[string]string{
		"nemotron_transcribe_iq4_nl": "nemotron-transcribe-30b-a4b-experts-IQ4_NL.gguf",
		"nemotron_transcribe_q4_k":   "nemotron-transcribe-30b-a4b-experts-Q4_K_S.gguf",
		"nemotron_transcribe_q3_k":   "nemotron-transcribe-30b-a4b-experts-Q3_K_S.gguf",
		"nemotron_transcribe_q2_k":   "nemotron-transcribe-30b-a4b-experts-Q2_K.gguf",
	}
	for id, filename := range cases {
		t.Run(id, func(t *testing.T) {
			pkg := resolvePackage(findPackageFamily("nemotron_transcribe"), id)
			if pkg == nil || pkg.PrimaryFile != filename {
				t.Fatalf("wrong primary decoder: %#v", pkg)
			}
			task := &DownloadTask{ID: "download-primary", ModelID: "nemotron_transcribe", PackageID: id, TargetDir: pkg.TargetDir, Status: dlStatusDone}
			for _, f := range pkg.Files {
				task.Files = append(task.Files, &dlFileEntry{Path: f.Local, Completed: true})
			}
			for _, root := range []string{"models", "weights", filepath.Join(t.TempDir(), "absolute-models")} {
				want := filepath.ToSlash(filepath.Join(root, pkg.TargetDir, filename))
				manager := &DownloadManager{modelsDir: root, tasks: map[string]*DownloadTask{task.ID: task}, order: []*DownloadTask{task}}
				list := manager.List()
				if len(list) != 1 || list[0]["weightsPath"] != want {
					t.Fatalf("list weights: %#v", list)
				}
				detail, err := manager.Get(task.ID)
				if err != nil || detail["weightsPath"] != want {
					t.Fatalf("detail weights: %#v, %v", detail, err)
				}
				if strings.Contains(want, "mmproj-") {
					t.Fatal("selected encoder instead of decoder")
				}
			}
		})
	}
}

func TestCompletedDownloadPrimaryFileFallbacks(t *testing.T) {
	pkg := resolvePackage(findPackageFamily("nemotron_transcribe"), "nemotron_transcribe_q2_k")
	good := func() *DownloadTask {
		return &DownloadTask{ModelID: "nemotron_transcribe", PackageID: pkg.ID, TargetDir: pkg.TargetDir, Status: dlStatusDone, Files: []*dlFileEntry{{Path: pkg.PrimaryFile, Completed: true}}}
	}
	for _, name := range []string{"legacy", "missing-package", "wrong-package", "wrong-target", "incomplete", "missing-primary", "unfinished-file"} {
		t.Run(name, func(t *testing.T) {
			task := good()
			switch name {
			case "legacy":
				task.ModelID = "supertonic"
				task.PackageID = ""
			case "missing-package":
				task.PackageID = ""
			case "wrong-package":
				task.PackageID = "unknown"
			case "wrong-target":
				task.TargetDir = "different"
			case "incomplete":
				task.Status = dlStatusRunning
			case "missing-primary":
				task.Files = []*dlFileEntry{{Path: "mmproj-Encoder.gguf", Completed: true}}
			case "unfinished-file":
				task.Files[0].Completed = false
			}
			if got := (&DownloadManager{}).completedDownloadWeightsPath(task); got != "" {
				t.Fatalf("unsafe/legacy selection: %q", got)
			}
		})
	}
}
