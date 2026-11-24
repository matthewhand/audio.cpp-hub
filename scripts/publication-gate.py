#!/usr/bin/env python3
"""Local, offline publication evidence gate. Python 3.10+, Linux/amd64."""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import platform
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile

GIB = 1024 ** 3
FORCED = {
    "GOTOOLCHAIN": "local", "GOPROXY": "off", "GOSUMDB": "off",
    "GOTELEMETRY": "off", "GIT_NO_LAZY_FETCH": "1", "GOENV": "off",
    "GOMAXPROCS": "2", "GOFLAGS": "-p=1", "npm_config_offline": "true",
    "npm_config_audit": "false", "npm_config_fund": "false",
    "PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD": "1", "CI": "1",
    "QA121_REAL_SSE_BROWSER": "0", "PYTHONDONTWRITEBYTECODE": "1",
    "GIT_TERMINAL_PROMPT": "0", "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null", "LC_ALL": "C.UTF-8",
}
EXCLUDED = ("docs/media", "docs/screenshots", "docs/assets")
SCREENSHOTS = tuple(
    f"docs/screenshots/diarization-{name}.png"
    for name in ("mobile", "laptop", "desktop")
)
STATIC = ("check:types", "lint", "format:check", "check:i18n", "check:sw")
PYTESTS = (
    "test/unit/test_diarization_fixture_builder.py",
    "test/unit/test_diarization_intake_v2.py",
    "test/unit/test_human_rttm_qa.py",
    "test/unit/test_diarization_adjudication.py",
)
TARGETS = (("windows", "amd64"), ("linux", "amd64"),
           ("linux", "arm64"), ("darwin", "arm64"))


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, sort_keys=True, indent=2) + "\n").encode()


def outside(child, parent):
    return not child.resolve().is_relative_to(parent.resolve())


def offline_env(path, home, modules, browsers):
    # Construct an allowlist environment; inherited proxy/tool settings are discarded.
    env = dict(FORCED, PATH=path, HOME=str(home), TMPDIR=str(home / "tmp"),
               GOTMPDIR=str(home / "gotmp"), GOCACHE=str(home / "gocache"),
               npm_config_cache=str(home / "npm"), XDG_CACHE_HOME=str(home / "cache"),
               XDG_CONFIG_HOME=str(home / "config"), GOMODCACHE=str(modules),
               PLAYWRIGHT_BROWSERS_PATH=str(browsers))
    return env


def stop_group(process):
    for sig, limit in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
        try:
            os.killpg(process.pid, sig)
        except ProcessLookupError:
            break
        end = time.monotonic() + limit
        while time.monotonic() < end:
            process.poll()
            try:
                os.killpg(process.pid, 0)
            except ProcessLookupError:
                return
            time.sleep(0.1)
    process.poll()


def owned_size(root):
    total = 0
    pending = [root]
    while pending:
        with os.scandir(pending.pop()) as entries:
            for entry in entries:
                info = entry.stat(follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode):
                    pending.append(entry.path)
                elif stat.S_ISREG(info.st_mode):
                    total += info.st_size
    return total


def positive_limits(*values):
    require(all(math.isfinite(v) and v > 0 for v in values),
            "Resource limits must be finite and positive")


def resources(root, min_disk, min_memory, output=None, max_run=8, min_output=0.5):
    root_free = shutil.disk_usage("/").free
    output_free = shutil.disk_usage(output or root or "/").free
    require(root_free >= min_disk * GIB,
            "Root filesystem free-space floor breached")
    require(output_free >= min_output * GIB,
            "Output filesystem free-space floor breached")
    fields = Path("/proc/meminfo").read_text().splitlines()
    available = next(int(x.split()[1]) * 1024
                     for x in fields if x.startswith("MemAvailable:"))
    require(available >= min_memory * GIB, "MemAvailable floor breached")
    size = owned_size(root) if root else 0
    require(size <= max_run * GIB,
            f"Run-directory budget exceeded {max_run:g} GiB")
    return {"root_free": root_free, "output_free": output_free,
            "memory_available": available, "run_bytes": size}


PREFLIGHT_OUTPUT_LIMIT = 256 * 1024


def preflight_capture(argv, cwd, env, timeout, check, row):
    """Capture a bounded prefix without creating a run directory or temp file."""
    process = subprocess.Popen(argv, cwd=cwd, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, start_new_session=True)
    row["pid"] = process.pid
    data = bytearray()
    started = time.monotonic()
    next_check = started
    try:
        os.set_blocking(process.stdout.fileno(), False)
        while True:
            chunk = os.read(process.stdout.fileno(), 65536) if (
                __import__("select").select([process.stdout], [], [], 0)[0]) else b""
            if chunk:
                remaining = PREFLIGHT_OUTPUT_LIMIT - len(data)
                data.extend(chunk[:remaining])
                row["output_truncated"] = len(chunk) > remaining
                require(not row["output_truncated"], "Preflight output limit exceeded")
            if process.poll() is not None and not chunk:
                break
            now = time.monotonic()
            require(now - started < timeout, "Command timeout")
            if now >= next_check:
                row["resources_latest"] = check()
                next_check = now + 2
            time.sleep(0.05)
        return bytes(data)
    finally:
        stop_group(process)
        process.stdout.close()
        row["exit_code"] = process.poll()
        row["preflight_output"] = bytes(data).decode("utf-8", "replace")
        row["captured_bytes"] = len(data)
        row["log_sha256"] = digest(data)


def file_digest(path):
    result = hashlib.sha256()
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), "rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def no_symlink_parents(path):
    require(not any(p.is_symlink() for p in (path, *path.parents)),
            f"Symlink traversal forbidden: {path}")


def tree_snapshot(path):
    no_symlink_parents(path)
    result = {}
    pending = [(path, "")]
    while pending:
        current, name = pending.pop()
        info = current.lstat()
        mode = stat.S_IMODE(info.st_mode)
        if stat.S_ISDIR(info.st_mode):
            result[name] = (mode, None, None)
            with os.scandir(current) as entries:
                for entry in entries:
                    relative = f"{name}/{entry.name}" if name else entry.name
                    safe_name(relative)
                    pending.append((Path(entry.path), relative))
        else:
            require(stat.S_ISREG(info.st_mode), f"Nonregular output: {current}")
            result[name] = (mode, info.st_size, file_digest(current))
    return result


def remove_snapshot(path, snapshot):
    # Remove only inventoried entries; unexpected additions prevent rmdir.
    for name, (_, size, _) in sorted(
            snapshot.items(), key=lambda item: item[0].count("/"), reverse=True):
        current = path / name if name else path
        if size is not None:
            current.unlink()
    for name, (_, size, _) in sorted(
            snapshot.items(), key=lambda item: len(item[0]), reverse=True):
        if size is None:
            (path / name if name else path).rmdir()


def relocate_fresh(source, target):
    """Copy across filesystems, verify, then remove only inventoried originals."""
    no_symlink_parents(target.parent)
    require(not target.exists() and not target.is_symlink(),
            f"Evidence destination already exists: {target}")
    snapshot = tree_snapshot(source)
    for name, (mode, size, _) in sorted(
            snapshot.items(), key=lambda item: (item[0].count("/"), item[0])):
        src = source / name if name else source
        dst = target / name if name else target
        if size is None:
            dst.mkdir()
        else:
            with os.fdopen(os.open(src, os.O_RDONLY | os.O_NOFOLLOW), "rb") as inp:
                with dst.open("xb") as out:
                    shutil.copyfileobj(inp, out, 1024 * 1024)
            dst.chmod(mode)
    for name, (mode, size, _) in sorted(
            snapshot.items(), key=lambda item: len(item[0]), reverse=True):
        if size is None:
            (target / name if name else target).chmod(mode)
    require(tree_snapshot(source) == snapshot, "Source output changed during copy")
    require(tree_snapshot(target) == snapshot, "Evidence copy verification failed")
    remove_snapshot(source, snapshot)


class Gate:
    def __init__(self, source, env, disk=5, memory=8, output=None,
                 max_run=8, min_output=0.5, rotate=False):
        self.source, self.env = source, env
        self.disk, self.memory = disk, memory
        self.output, self.max_run = output or source, max_run
        self.min_output, self.rotate = min_output, rotate
        self.root = None
        self.receipt = {
            "status": "preflight", "source_label": "pinned source",
            "commands": [], "thresholds": {
                "min_root_free_gib": disk, "min_memory_free_gib": memory,
                "min_output_free_gib": min_output,
                "run_warning_gib": 4, "run_hard_budget_gib": max_run,
                "monitor_seconds": 2},
            "rotate_go_cache": rotate,
            "limitations": [
                "No network namespace is established by this driver.",
                "Axe baseline: 66 contrast violations; not WCAG compliance.",
                "No inference, rights clearance, publication or overall rubric score.",
            ],
        }

    def save(self):
        if self.root:
            temporary = self.root / "receipt.json.tmp"
            temporary.write_bytes(encoded(self.receipt))
            temporary.replace(self.root / "receipt.json")

    def check(self):
        return resources(self.root, self.disk, self.memory,
                         self.root or self.output, self.max_run, self.min_output)

    def rotate_cache(self, phase):
        if not self.rotate:
            return
        require(self.root is not None, "Cache rotation requires an owned run")
        cache = self.root / "home/gocache"
        no_symlink_parents(cache)
        require(cache.resolve().is_relative_to(self.root.resolve())
                and Path(self.env["GOCACHE"]) == cache,
                "Refusing to rotate a non-owned Go cache")
        snapshot = tree_snapshot(cache)
        removed = sum(size or 0 for _, size, _ in snapshot.values())
        remove_snapshot(cache, snapshot)
        cache.mkdir()
        self.receipt.setdefault("cache_rotations", []).append(
            {"phase": phase, "bytes_removed": removed})
        self.save()

    def command(self, argv, timeout=180, extra=None, probe=None, phase=None):
        argv = [str(x) for x in argv]
        env = dict(self.env, **(extra or {}))
        row = {"argv": argv, "cwd": str(self.source), "env_overrides": env,
               "timeout_seconds": timeout, "started_unix": time.time()}
        if phase:
            row["phase"] = phase
        self.receipt["commands"].append(row)
        self.save()
        process = None
        started = time.monotonic()
        content = b""
        try:
            row["resources_before"] = self.check()
            if not self.root:
                content = preflight_capture(
                    argv, self.source, env, timeout, self.check, row)
            else:
                log = self.root / f"{len(self.receipt['commands']):03d}.log"
                row["log"] = log.name
                with log.open("wb") as stream:
                    process = subprocess.Popen(argv, cwd=self.source, env=env,
                                               stdout=stream, stderr=stream,
                                               start_new_session=True)
                    row["pid"] = process.pid
                    self.save()
                    next_check = 0
                    while process.poll() is None:
                        now = time.monotonic()
                        require(now - started < timeout, "Command timeout")
                        if now >= next_check:
                            sample = self.check()
                            row["resources_latest"] = sample
                            if sample["run_bytes"] > 4 * GIB:
                                self.receipt["scratch_warning"] = "Run exceeds 4 GiB"
                            self.save()
                            next_check = now + 2
                        if probe and probe(process, log):
                            row["probe_passed"] = True
                            break
                        time.sleep(0.2)
                if probe:
                    require(row.get("probe_passed"), "Smoke process exited before readiness")
                else:
                    row["exit_code"] = process.wait()
                content = log.read_bytes()
            require(row.get("exit_code", 0) == 0, f"Command failed: {argv!r}")
            return content.decode("utf-8", "replace")
        except BaseException as exc:
            row["error"] = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            if process:
                stop_group(process)
                row["exit_code"] = process.poll()
                content = (self.root / row["log"]).read_bytes()
            row["elapsed_seconds"] = round(time.monotonic() - started, 3)
            row.setdefault("log_sha256", digest(content))
            if not self.root:
                row.setdefault("preflight_output", content.decode("utf-8", "replace"))
            if self.root:
                row["log_sha256"] = digest(content)
            self.save()

    def git(self, *args):
        return self.command(["git", *args]).strip()


def clean(gate, expected, node_modules=None):
    require(re.fullmatch(r"[0-9a-fA-F]{40}", expected), "Expected SHA must be 40 hex")
    require(gate.git("rev-parse", "HEAD").lower() == expected.lower(), "Wrong HEAD")
    gate.git("diff-index", "--quiet", "HEAD", "--")
    require(not gate.git("diff", "--name-only"), "Unstaged tracked changes")
    # --directory avoids descending into dependency trees and ignored caches.
    ordinary = gate.git("ls-files", "--others", "--exclude-standard", "--directory")
    ignored = gate.git("ls-files", "--others", "--ignored", "--exclude-standard",
                       "--directory")
    entries = set((ordinary + "\n" + ignored).splitlines()) - {""}
    link = gate.source / "node_modules"
    if "node_modules/" in entries or "node_modules" in entries:
        require(node_modules is not None and link.is_symlink()
                and link.resolve() == node_modules.resolve(),
                "Only the explicitly selected node_modules symlink is permitted")
        entries -= {"node_modules", "node_modules/"}
        gate.receipt["controlled_exception"] = {
            "path": "node_modules", "target": str(node_modules.resolve())}
    require(not entries, f"Untracked/ignored source files: {sorted(entries)!r}")
    status = gate.git("status", "--porcelain=v1", "--untracked-files=all")
    require(all(line[3:] == "node_modules" and line.startswith("?? ")
                for line in status.splitlines()), f"Dirty status: {status}")


def safe_name(name):
    p = PurePosixPath(name)
    require(name and "\\" not in name and ":" not in name
            and not p.is_absolute() and p.as_posix() == name
            and all(x not in ("", ".", "..") for x in name.split("/")),
            f"Unsafe archive path: {name}")
    return name


def regular_bytes(root, name):
    safe_name(name)
    current = root
    for part in name.split("/"):
        current = current / part
        require(not current.is_symlink(), f"Symlink forbidden: {name}")
    require(current.is_file(), f"Missing regular file: {name}")
    return current.read_bytes()


def verify_zip(path, files, timestamp):
    with zipfile.ZipFile(path) as archive:
        members = archive.infolist()
        require(sorted(x.filename for x in members) == sorted(files),
                "Archive member set differs")
        for member in members:
            safe_name(member.filename)
            data, mode = files[member.filename]
            require(member.create_system == 3
                    and member.external_attr >> 16 == stat.S_IFREG | mode,
                    "Archive permissions/type differ")
            require(member.date_time == timestamp, "Archive timestamp differs")
            require(digest(archive.read(member)) == digest(data),
                    "Archive content digest differs")


def deterministic_zip(path, files, epoch, guard=None):
    moment = dt.datetime.fromtimestamp(epoch, dt.timezone.utc)
    year = min(2107, max(1980, moment.year))
    timestamp = (year, moment.month, moment.day, moment.hour,
                 moment.minute, moment.second // 2 * 2)
    for name in files:
        safe_name(name)
    if guard:
        guard()
    # Exclusive creation preserves all preexisting results.
    with path.open("xb") as output:
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED,
                             compresslevel=9) as archive:
            for name, (data, mode) in sorted(files.items()):
                info = zipfile.ZipInfo(name, timestamp)
                info.create_system = 3
                info.external_attr = (stat.S_IFREG | mode) << 16
                info.compress_type = zipfile.ZIP_DEFLATED
                if guard:
                    guard()
                next_check = time.monotonic() + 2
                with archive.open(info, "w") as member:
                    for offset in range(0, len(data), 1024 * 1024):
                        member.write(data[offset:offset + 1024 * 1024])
                        if guard and time.monotonic() >= next_check:
                            guard()
                            next_check = time.monotonic() + 2
                if guard:
                    guard()
    verify_zip(path, files, timestamp)
    if guard:
        guard()


def browser_preflight(modules, cache, platform_key=None, resolved=None):
    metadata = json.loads((modules / "playwright-core/browsers.json").read_text())
    required = [b for b in metadata["browsers"]
                if b["name"] in ("chromium-headless-shell", "ffmpeg")]
    require({b["name"] for b in required} ==
            {"chromium-headless-shell", "ffmpeg"}, "Browser metadata incomplete")
    require(resolved is not None or platform_key is not None,
            "Actual Playwright platform or installed resolver results required")
    executables = {"chromium-headless-shell":
                   "chrome-headless-shell-linux64/chrome-headless-shell",
                   "ffmpeg": "ffmpeg-linux"}
    evidence = []
    for browser in required:
        name = browser["name"]
        if resolved is not None:
            require(isinstance(resolved.get(name), str),
                    f"Installed resolver returned no path for {name}")
            executable = Path(resolved[name])
        else:
            revision = browser.get("revisionOverrides", {}).get(
                platform_key, browser["revision"])
            base = cache / f"{name.replace('-', '_')}-{revision}"
            executable = base / executables[name]
        require(executable.resolve().is_relative_to(cache.resolve())
                and executable.is_file() and os.access(executable, os.X_OK),
                f"Required cached executable absent or outside cache: {name}")
        evidence.append({"name": name, "executable": str(executable),
                         "metadata": browser})
    return evidence


BROWSER_RESOLVER = """
const path = require('node:path');
const fs = require('node:fs');
const core = path.join(process.argv[1], 'playwright-core/lib');
const legacy = path.join(core, 'server/registry/index.js');
const loaded = require(fs.existsSync(legacy) ? legacy : path.join(core, 'coreBundle.js'));
const registry = typeof loaded.registry?.findExecutable === 'function'
  ? loaded.registry : loaded.registry?.registry;
if (typeof registry?.findExecutable !== 'function')
  throw new Error('Unsupported installed Playwright registry API');
const names = ['chromium-headless-shell', 'ffmpeg'];
console.log(JSON.stringify(Object.fromEntries(names.map(name => {
  const executable = registry.findExecutable(name);
  if (!executable) throw new Error('Missing installed resolver: ' + name);
  return [name, executable.executablePath()];
}))));
"""


def regression_identity(directory):
    files = {p.name: digest(regular_bytes(directory, p.name))
             for p in sorted(directory.glob("test_publication_gate*.py"))}
    require("test_publication_gate.py" in files,
            "External adjacent driver regression suite is required")
    return files


def bind_free(port):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", port))
        return sock.getsockname()[1]


def harvest(gate):
    moved = []
    for name in SCREENSHOTS:
        source = gate.source / name
        if source.exists() or source.is_symlink():
            require(not source.is_symlink() and source.is_file(),
                    f"Unexpected screenshot type: {name}")
            target = gate.root / "synthetic-screenshots" / source.name
            target.parent.mkdir(exist_ok=True)
            relocate_fresh(source, target)
            moved.append(name)
    for name in ("test-results", "playwright-report"):
        source = gate.source / name
        if source.exists() or source.is_symlink():
            require(source.is_dir() and not source.is_symlink(), "Unexpected report type")
            relocate_fresh(source, gate.root / name)
    if moved:
        gate.git("sparse-checkout", "reapply")
    gate.receipt.setdefault("synthetic_screenshots", []).extend(moved)
    gate.save()


def package_sources(gate):
    records = gate.git("ls-files", "--stage", "-z").split("\0")
    files = {}
    common = {"README.md", "LICENSE", "THIRD_PARTY_NOTICES",
              "hub.config.example.json"}
    for record in filter(None, records):
        metadata, name = record.split("\t", 1)
        mode, oid, stage = metadata.split()
        if name.startswith("web/") or name in common:
            require(stage == "0" and mode in ("100644", "100755"),
                    f"Nonregular packaging source: {name}")
            data = regular_bytes(gate.source, name)
            actual = gate.git("hash-object", "--no-filters", "--", name)
            require(actual == oid, f"Working bytes differ from Git blob: {name}")
            files[name] = (data, 0o644)
    require(common <= files.keys() and any(n.startswith("web/") for n in files),
            "Incomplete packaging source")
    return files


def listener(gate, port, pid=None):
    output = gate.command(["ss", "-H", "-ltnp", f"sport = :{port}"], timeout=10)
    lines = output.splitlines()
    if pid is None:
        require(not lines, "Smoke listener survived cleanup")
        return False
    if not lines:
        return False
    require(all(len(line.split()) >= 5 and
                line.split()[3] == f"127.0.0.1:{port}" and
                re.findall(r"pid=(\d+)", line) == [str(pid)] for line in lines),
            "Listener address/PID does not belong exclusively to smoke process")
    return True


def smoke(gate, archive, prefix, version):
    directory = gate.root / "smoke"
    directory.mkdir()
    with zipfile.ZipFile(archive) as package:
        for info in package.infolist():
            safe_name(info.filename)
            relative = PurePosixPath(info.filename).relative_to(prefix)
            target = directory.joinpath(*relative.parts)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(package.read(info))
            target.chmod((info.external_attr >> 16) & 0o777)
    port = bind_free(0)
    (directory / "hub.config.json").write_bytes(encoded({
        "httpBindHost": "127.0.0.1", "httpPort": port,
        "instancePortBase": bind_free(0), "modelsDir": "models"}))
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    title = re.search(rb"<title[^>]*>(.*?)</title>",
                      (directory / "web/index.html").read_bytes(), re.S)
    require(title is not None, "No source index title marker")
    def request(path, method="GET"):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}",
                                     data=b"" if method == "POST" else None,
                                     method=method)
        try:
            with opener.open(req, timeout=2) as response:
                return response.status, response.read(2 * 1024 * 1024)
        except urllib.error.HTTPError as error:
            return error.code, error.read(65536)
    def probe(process, log):
        if not listener(gate, port, process.pid):
            return False
        try:
            code, body = request("/api/models")
        except (OSError, TimeoutError):
            return False
        if code != 200:
            return False
        models = json.loads(body)
        def ids(value):
            if isinstance(value, dict):
                return any(k in ("id", "modelId") and isinstance(v, str) and v
                           for k, v in value.items()) or any(ids(v) for v in value.values())
            return isinstance(value, list) and any(ids(v) for v in value)
        require(ids(models), "Models JSON contains no model IDs")
        code, body = request("/")
        require(code == 200 and title.group(0) in body, "Index marker mismatch")
        endpoint = "/v1/audio/transcriptions/live?sample_rate=16000"
        require(request(endpoint, "POST")[0] == 400, "Missing model must return 400")
        require(request(endpoint + "&model=publication-gate-unknown", "POST")[0] == 404,
                "Unknown model must return 404")
        require(version in log.read_text(errors="replace"), "Version absent from process log")
        return True
    old = gate.source
    try:
        # The packaged process must start in its own empty runtime directory.
        gate.source = directory
        gate.command([directory / "audio.cpp-hub"], timeout=30, probe=probe)
    finally:
        gate.source = old
        listener(gate, port)
    gate.receipt["smoke"] = {"linux/amd64": "executed packaged binary",
                            "others": "crosscompiled/package-inspected only"}


def execute(gate, args, tools, modules):
    regression = gate.receipt["driver_regressions"]
    directory = Path(regression["directory"])
    require(regression_identity(directory) == regression["files"],
            "External regression inputs changed since preflight")
    require(digest(Path(__file__).read_bytes()) == gate.receipt["driver_sha256"],
            "Driver changed since preflight")
    gate.command(regression["argv"], 180, phase="driver-regressions")
    require(regression_identity(directory) == regression["files"],
            "External regression inputs changed during execution")
    require(digest(Path(__file__).read_bytes()) == gate.receipt["driver_sha256"],
            "Driver changed during regressions")
    regression["status"] = "passed"
    gate.save()
    go, npm, playwright = tools
    gate.command([go, "mod", "verify"])
    tracked = gate.git("ls-files", "-z", "*.go").split("\0")
    for offset in range(0, len(tracked), 100):
        batch = list(filter(None, tracked[offset:offset + 100]))
        if batch:
            require(not gate.command([Path(go).with_name("gofmt"), "-l", *batch]).strip(),
                    "gofmt check failed; apply the separately reviewed whitespace patch")
    gate.command([go, "vet", "-p=1", "./..."], 300)
    gate.command([go, "test", "-race", "-count=1", "-p=1", "-parallel=2",
                  "-timeout=180s", "./..."], 300, {"CGO_ENABLED": "1"})
    gate.rotate_cache("after-backend")
    gate.command([sys.executable, "-B", "scripts/check-diagrams.py", "docs/diagrams"])
    for script in (*STATIC, "test:unit"):
        gate.command([npm, "run", script], 300)
    for script in PYTESTS:
        gate.command([sys.executable, "-B", script, "-q"])
    for pattern, warnings in (("test_startup_warmup_policy.py", []),
                              ("test_audiocpp_client.py", ["-W", "error"])):
        gate.command([sys.executable, "-B", *warnings, "-m", "unittest", "discover",
                      "-s", "tests", "-p", pattern])
    for script in ("ui:inventory:check", "perf:budget"):
        gate.command([npm, "run", script])
    try:
        gate.command([npm, "run", "a11y:audit"], 300)
        bind_free(4173)
        gate.command([playwright, "test", "--config", "e2e/playwright.config.mjs",
                      "--workers=1", "--retries=0", "--reporter=list",
                      "--output", gate.root / "e2e-output"], 600)
    finally:
        harvest(gate)
    clean(gate, args.expected_sha, modules)
    common = package_sources(gate)
    version = "dev-" + args.expected_sha[:7].lower()
    packages = []
    for goos, arch in TARGETS:
        clean(gate, args.expected_sha, modules)
        binary = gate.root / f"binary-{goos}-{arch}"
        flags = "-s -w -X main.version=" + version
        if goos == "windows":
            flags = "-H windowsgui " + flags
        gate.command([go, "build", "-trimpath", "-buildvcs=true",
                      "-ldflags=" + flags, "-o", binary, "."], 300,
                     {"CGO_ENABLED": "0", "GOOS": goos, "GOARCH": arch})
        metadata = gate.command([go, "version", "-m", binary])
        settings = dict(re.findall(r"^\s*build\s+([^=\s]+)=(.*)$", metadata, re.M))
        require(all(settings.get(k) == v for k, v in {
            "vcs.revision": args.expected_sha.lower(), "vcs.modified": "false",
            "GOOS": goos, "GOARCH": arch, "CGO_ENABLED": "0"}.items()),
            "Binary VCS/platform metadata mismatch")
        clean(gate, args.expected_sha, modules)
        prefix = f"audio.cpp-hub-{version}-{goos}-{arch}"
        files = {f"{prefix}/{n}": v for n, v in common.items()}
        name = "audio.cpp-hub.exe" if goos == "windows" else "audio.cpp-hub"
        files[f"{prefix}/{name}"] = (binary.read_bytes(), 0o755)
        info = {"source_sha": args.expected_sha.lower(),
                "source_tree": gate.receipt["source_tree"], "version": version,
                "GOOS": goos, "GOARCH": arch, "CGO_ENABLED": "0",
                "go_version": gate.receipt["tools"]["go"],
                "flags": ["-trimpath", "-buildvcs=true", "-ldflags=" + flags]}
        files[f"{prefix}/BUILD-INFO.json"] = (encoded(info), 0o644)
        manifest = "".join(f"{digest(data)}  {name.removeprefix(prefix + '/')}\n"
                           for name, (data, _) in sorted(files.items()))
        files[f"{prefix}/MANIFEST.sha256"] = (manifest.encode(), 0o644)
        archive = gate.root / f"{prefix}.zip"
        gate.check()
        deterministic_zip(archive, files, gate.receipt["commit_epoch"], gate.check)
        packages.append((archive, prefix))
        gate.rotate_cache(f"after-crossbuild-{goos}-{arch}")
    gate.check()
    (gate.root / "SHA256SUMS").write_text("".join(
        f"{digest(p.read_bytes())}  {p.name}\n" for p, _ in sorted(packages)))
    gate.receipt["packages"] = {p.name: digest(p.read_bytes()) for p, _ in packages}
    gate.save()
    linux = next(item for item in packages if item[1].endswith("-linux-amd64"))
    smoke(gate, *linux, version)
    clean(gate, args.expected_sha, modules)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "expected-sha", "output-parent"):
        parser.add_argument("--" + name, required=True)
    for name in ("go", "node", "node-modules", "browser-cache", "gomodcache"):
        parser.add_argument("--" + name)
    parser.add_argument("--preflight-only", action="store_true")
    parser.add_argument("--min-root-free-gib", type=float, default=5)
    parser.add_argument("--min-memory-free-gib", type=float, default=8)
    parser.add_argument("--max-run-gib", type=float, default=8)
    parser.add_argument("--min-output-free-gib", type=float, default=0.5)
    parser.add_argument("--rotate-go-cache", action="store_true")
    args = parser.parse_args()
    gate = None
    def interrupted(signum, frame):
        raise KeyboardInterrupt(f"signal {signum}")
    for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
        signal.signal(sig, interrupted)
    try:
        source, parent = Path(args.source).resolve(), Path(args.output_parent).resolve()
        require(platform.system() == "Linux" and platform.machine() in ("x86_64", "amd64"),
                "Linux/amd64 host required")
        require(outside(parent, source) and outside(Path(__file__), source),
                "Output parent and driver must be outside tested source")
        require(parent.is_dir() and os.access(parent, os.W_OK | os.X_OK),
                "Output parent must already exist and be writable")
        positive_limits(args.min_root_free_gib, args.min_memory_free_gib,
                        args.max_run_gib, args.min_output_free_gib)
        go = shutil.which(args.go or "go")
        node = shutil.which(args.node or "node")
        require(go and node, "Existing Go and Node executables required")
        path = os.pathsep.join(dict.fromkeys(
            [str(Path(go).parent), str(Path(node).parent), "/usr/bin", "/bin"]))
        npm = shutil.which("npm", path=path)
        require(npm and shutil.which("ss", path=path) and shutil.which("cc", path=path),
                "Existing npm, ss and C compiler required")
        require(Path(go).with_name("gofmt").is_file(), "Matching gofmt required")
        modules = Path(args.node_modules or source / "node_modules").resolve()
        browsers = Path(args.browser_cache or Path.home() / ".cache/ms-playwright").resolve()
        gomod = Path(args.gomodcache or Path.home() / "go/pkg/mod").resolve()
        require(all(p.is_dir() and outside(p, source) for p in (modules, browsers, gomod)),
                "Existing external dependency/browser caches required")
        require((source / "node_modules").is_symlink()
                and (source / "node_modules").resolve() == modules,
                "Pre-provision the explicitly controlled node_modules symlink")
        env = offline_env(path, Path("/nonexistent/publication-gate"), gomod, browsers)
        gate = Gate(source, env, args.min_root_free_gib, args.min_memory_free_gib,
                    parent, args.max_run_gib, args.min_output_free_gib,
                    args.rotate_go_cache)
        gate.check()
        try:
            gate.git("check-ignore", "--quiet", "node_modules")
        except RuntimeError as exc:
            raise RuntimeError(
                "node_modules must be ignored for VCS-clean builds; add only "
                "/node_modules to this isolated checkout's .git/info/exclude "
                "during preparation; the gate will not change Git configuration") from exc
        clean(gate, args.expected_sha, modules)
        require(gate.git("rev-parse", "--show-toplevel") == str(source), "Source must be Git root")
        require(gate.git("config", "--get", "core.sparseCheckout") == "true",
                "Sparse checkout required")
        require(all(not (source / name).exists() for name in EXCLUDED),
                "Excluded private media directories must be absent")
        require(all(not (source / n).exists() for n in
                    (*SCREENSHOTS, "test-results", "playwright-report")),
                "Preexisting browser outputs forbidden")
        gate.receipt.update(source_sha=args.expected_sha.lower(),
                            source_tree=gate.git("rev-parse", "HEAD^{tree}"),
                            commit_epoch=int(gate.git("show", "-s", "--format=%ct", "HEAD")),
                            driver_sha256=digest(Path(__file__).read_bytes()),
                            lockfile_sha256=digest(regular_bytes(source, "package-lock.json")))
        versions = {"go": gate.command([go, "version"]).strip(),
                    "node": gate.command([node, "--version"]).strip(),
                    "npm": gate.command([npm, "--version"]).strip(),
                    "python": sys.version, "git": gate.git("--version")}
        match = re.search(r"go(\d+)\.(\d+)", versions["go"])
        require(match and tuple(map(int, match.groups())) >= (1, 27), "Go 1.27+ required")
        require(int(versions["node"].lstrip("v").split(".")[0]) >= 22, "Node 22+ required")
        gate.receipt["tools"] = versions
        resolved = json.loads(gate.command([node, "-e", BROWSER_RESOLVER, modules]))
        gate.receipt["browsers"] = browser_preflight(
            modules, browsers, resolved=resolved)
        regression_dir = Path(__file__).resolve().parents[1] / "tests"
        require(outside(regression_dir, source),
                "Driver regression directory must be external to candidate")
        gate.receipt["driver_regressions"] = {
            "directory": str(regression_dir),
            "files": regression_identity(regression_dir),
            "argv": [sys.executable, "-B", "-m", "unittest", "discover",
                     "-s", str(regression_dir), "-p", "test_publication_gate*.py"],
            "status": "not-run"}
        playwright = modules / ".bin/playwright"
        require(playwright.is_file() and os.access(playwright, os.X_OK),
                "Existing Playwright CLI required")
        scripts = json.loads((source / "package.json").read_text())["scripts"]
        require(set((*STATIC, "test:unit", "ui:inventory:check", "perf:budget",
                     "a11y:audit")) <= scripts.keys(), "Required npm scripts missing")
        for name in (*PYTESTS, "tests/test_startup_warmup_policy.py",
                     "tests/test_audiocpp_client.py", "e2e/playwright.config.mjs"):
            regular_bytes(source, name)
        bind_free(4173)
        gate.check()
        clean(gate, args.expected_sha, modules)
        if args.preflight_only:
            gate.receipt["status"] = "preflight-passed"
            print(encoded(gate.receipt).decode(), end="")
            return 0
        gate.root = Path(tempfile.mkdtemp(prefix="publication-gate-", dir=parent))
        home = gate.root / "home"
        gate.env = offline_env(path, home, gomod, browsers)
        for name in ("tmp", "gotmp", "gocache", "npm", "cache", "config"):
            (home / name).mkdir(parents=True, exist_ok=True)
        gate.receipt["status"] = "running"
        gate.save()
        try:
            execute(gate, args, (go, npm, playwright), modules)
            gate.receipt["status"] = "passed-local-milestone"
        finally:
            try:
                harvest(gate)
                clean(gate, args.expected_sha, modules)
            except BaseException as exc:
                gate.receipt["final_source_check_error"] = str(exc)
                raise
        gate.save()
        print(gate.root / "receipt.json")
        return 0
    except BaseException as exc:
        if gate:
            gate.receipt.update(status="failed", error=f"{type(exc).__name__}: {exc}")
            gate.save()
            if gate.root:
                print(gate.root / "receipt.json", file=sys.stderr)
            else:
                print(encoded(gate.receipt).decode(), file=sys.stderr, end="")
        else:
            print(f"Preflight failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
