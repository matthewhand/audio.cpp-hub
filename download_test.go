package main

import (
	"testing"
)

func TestBuildSegments(t *testing.T) {
	const mib = int64(1024 * 1024)
	const minSeg = int64(dlSegmentMin)

	cases := []struct {
		name          string
		size          int64
		supportsRange bool
		segmentsPer   int
		wantN         int
		wantSingle    bool // 退化为单段整流 {0,-1}
	}{
		{name: "zero size single", size: 0, supportsRange: true, segmentsPer: 4, wantSingle: true},
		{name: "negative size single", size: -5, supportsRange: true, segmentsPer: 4, wantSingle: true},
		{name: "no range single", size: 100 * mib, supportsRange: false, segmentsPer: 4, wantSingle: true},
		{name: "small file single segment", size: 1 * mib, supportsRange: true, segmentsPer: 4, wantN: 1},
		{name: "exactly 32MiB single segment", size: minSeg, supportsRange: true, segmentsPer: 4, wantN: 1},
		{name: "32MiB+1 two segments", size: minSeg + 1, supportsRange: true, segmentsPer: 4, wantN: 2},
		{name: "100MiB capped at segmentsPerFile=4", size: 100 * mib, supportsRange: true, segmentsPer: 4, wantN: 4},
		{name: "100MiB capped at segmentsPerFile=2", size: 100 * mib, supportsRange: true, segmentsPer: 2, wantN: 2},
		{name: "100MiB segmentsPerFile=1", size: 100 * mib, supportsRange: true, segmentsPer: 1, wantN: 1},
		{name: "3x32MiB no cap needed", size: 3 * minSeg, supportsRange: true, segmentsPer: 4, wantN: 3},
		{name: "5x32MiB capped to 4", size: 5 * minSeg, supportsRange: true, segmentsPer: 4, wantN: 4},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := &DownloadManager{segmentsPerFile: tc.segmentsPer}
			segs := m.buildSegments(tc.size, tc.supportsRange)

			if tc.wantSingle {
				if len(segs) != 1 || segs[0].Start != 0 || segs[0].End != -1 {
					t.Fatalf("got %+v, want single {Start:0 End:-1}", segs)
				}
				return
			}
			if len(segs) != tc.wantN {
				t.Fatalf("segment count = %d, want %d (%+v)", len(segs), tc.wantN, segs)
			}
			if segs[0].Start != 0 {
				t.Fatalf("first segment start = %d, want 0", segs[0].Start)
			}
			if got, want := segs[len(segs)-1].End, tc.size-1; got != want {
				t.Fatalf("last segment end = %d, want %d", got, want)
			}
			var total int64
			for i, s := range segs {
				if s.End < s.Start {
					t.Fatalf("segment %d invalid: %+v", i, s)
				}
				if i > 0 && s.Start != segs[i-1].End+1 {
					t.Fatalf("gap/overlap between segment %d (%+v) and %d (%+v)", i-1, segs[i-1], i, s)
				}
				total += s.End - s.Start + 1
			}
			if total != tc.size {
				t.Fatalf("sum of segment sizes = %d, want %d", total, tc.size)
			}
		})
	}
}

func TestParseContentRangeTotal(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want int64
	}{
		{name: "full range", in: "bytes 0-0/12345", want: 12345},
		{name: "unknown total", in: "bytes 100-199/*", want: -1},
		{name: "empty", in: "", want: -1},
		{name: "no slash", in: "bytes 0-0", want: -1},
		{name: "non-numeric total", in: "bytes 0-0/abc", want: -1},
		{name: "whitespace tolerated", in: "  bytes 5-10/20  ", want: 20},
		{name: "garbage", in: "no-space", want: -1},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseContentRangeTotal(tc.in); got != tc.want {
				t.Fatalf("parseContentRangeTotal(%q) = %d, want %d", tc.in, got, tc.want)
			}
		})
	}
}

func TestParseContentRangeStart(t *testing.T) {
	cases := []struct {
		name      string
		in        string
		wantStart int64
		wantOK    bool
	}{
		{name: "normal range", in: "bytes 5-10/20", wantStart: 5, wantOK: true},
		{name: "zero start", in: "bytes 0-0/12345", wantStart: 0, wantOK: true},
		{name: "no slash still parses start", in: "bytes 5-10", wantStart: 5, wantOK: true},
		{name: "leading/trailing whitespace", in: "  bytes 7-9/20  ", wantStart: 7, wantOK: true},
		{name: "empty", in: "", wantOK: false},
		{name: "no space", in: "no-space", wantOK: false},
		{name: "no dash", in: "bytes 5/20", wantOK: false},
		{name: "non-numeric start", in: "bytes abc-10/20", wantOK: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, ok := parseContentRangeStart(tc.in)
			if ok != tc.wantOK {
				t.Fatalf("parseContentRangeStart(%q) ok = %v, want %v", tc.in, ok, tc.wantOK)
			}
			if ok && got != tc.wantStart {
				t.Fatalf("parseContentRangeStart(%q) start = %d, want %d", tc.in, got, tc.wantStart)
			}
		})
	}
}
