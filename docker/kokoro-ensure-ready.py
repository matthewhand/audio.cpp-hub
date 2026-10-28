#!/usr/bin/env python3
# kokoro-ensure-ready.py — narrowly scoped Kokoro reboot-safe startup orchestrator.
#
# STDLIB ONLY. Python 3.8+. Loopback only, no synthesis, no credentials.
# Security invariants: never logs secrets or request/response bodies, never
# performs a DELETE, never restarts or kills anything, POSTs at most once.
#
# Purpose: as an ExecStartPost, attempt to verify/establish the pinned hub at
# http://127.0.0.1:18280 has exactly one instance:
#   instanceName=kokoro, modelId=kokoro_tts, backend=cpu, threads=2,
#   engine port 18290, weights at the pinned Q8 path — READY, and that
#   /v1/models advertises exactly the alias "kokoro".
#
# Read-only installed-state verification, 2026-10-27: GTX has enabled the
# candidate unit and ExecStartPost completed once with status=0. This is
# startup evidence only; Restart=no means this is not a crash watchdog.
# Source changes here do not affect installed bytes until separately deployed.
# See docs/gtx-kokoro-reboot-recovery.md for verification and limitations.

#
# Production service identity guard (ExecStartPost context):
#   - MAINPID must exist and be digits; it is the systemd main-process PID
#     (systemd sets MAINPID for ExecStartPost processes).
#   - KOKORO_ENSURE_UNIT must match the pinned unit name, and the
#     ExecStartPost environment must contain systemd's INVOCATION_ID.
#   - /proc/<mainpid>/cgroup must match the pinned systemd service.
#   - /proc/<mainpid>/exe must resolve to the pinned binary; its SHA256 must
#     match the pinned value; it must not be a symlink.
#   - Never inspect /proc/<mainpid>/environ (may contain credentials).
#   - The identity is re-verified before POST and before declaring READY, so
#     a swapped binary or PID recycle fails the run instead of proceeding.
#
# Fail-closed rules:
#   - wrong target service executable / identity,
#     binary SHA256 mismatch
#   - symlinks on binary or weights, missing/changed weights
#   - identity/port/model/backend/threads/weights mismatch on EVERY poll
#   - any foreign instance (any extra /api/instances entry)
#   - invalid/malformed/oversize JSON, HTTP failure, unreachable API
#   - POST must happen at most once with a fixed payload; never DELETE;
#     never restart/kill/retry-loop anything
#   - unexpected instance status (anything other than STARTING/READY)
#   - resource pressure (bounded free-disk / MemAvailable thresholds)
#   - total time budget <= 120s wall clock INCLUDING HTTP call time, with
#     bounded per-request HTTP timeouts and bounded inter-poll sleeps
# Exit codes: 0 ok; 11 bad env/config; 12 identity guard failure; 13 pressure;
#   14 registry/model missing; 15 path/weights failure; 16 HTTP/JSON failure;
#   17 target mismatch / foreign instance; 18 POST failure; 19 unexpected
#   status; 20 time budget exceeded; 21 /v1/models alias verification failure.
#
# It MUST NOT be pointed at any other host, port, or service; the live
# production hub on :18080 is never touched (loopback URL is hard-validated).
#
# TEST MODE: KOKORO_ENSURE_TEST_MODE=1 exists ONLY for fully synthetic,
# isolated unit tests that inject fake HTTP clients, fake /proc reads, temp
# files and a controlled clock. It relaxes the strictest pinned-fact surface
# (URL/exe/weights/threshold overrides) so offline tests can use tempdirs.
# It is NEVER set in an installed systemd service: the production unit shall
# not define it, and any TEST_MODE=1 run outside the test harness is by
# definition not a production run. Production keeps all pinned facts baked in.

from __future__ import annotations

import hashlib
import http.client
import json
import os
import stat
import sys
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple, Union

# ---------------------------------------------------------------- pinned facts

EXPECTED_EXE = "/home/matthewh/dev/audio.cpp-hub-bluegreen-20261024/audio.cpp-hub"
EXPECTED_EXE_SHA256 = "217d0a913b194701fc50400e99fa868fd96bfc2be87de5236bc44ecb6590490c"
HUB_BASE = "http://127.0.0.1:18280"
EXPECTED_MODEL_ID = "kokoro_tts"
EXPECTED_INSTANCE_NAME = "kokoro"
EXPECTED_BACKEND = "cpu"
EXPECTED_THREADS = 2
EXPECTED_ENGINE_PORT = 18290
WEIGHTS_PATH = "/home/matthewh/audio.cpp-hub/models/Kokoro-82M-GGUF/kokoro-82m-q8_0.gguf"
EXPECTED_V1_ALIASES = ("kokoro",)  # exactly this set, nothing else

GPU_DEVICE = 0

MAX_TOTAL_SECONDS = 120
POLL_INTERVAL_SECONDS = 2.0
HTTP_TIMEOUT_SECONDS = 5
MAX_JSON_BYTES = 65536

MIN_FREE_DISK_BYTES = 2 * 1024 * 1024 * 1024      # 2 GiB
MIN_MEM_AVAILABLE_BYTES = 1536 * 1024 * 1024      # 1.5 GiB

# Environment overrides are ONLY honored when KOKORO_ENSURE_TEST_MODE=1 is set
# (isolated synthetic-test context). In production (test mode off), the mere
# PRESENCE of any of these variables is a hard config error (fail closed), so
# an installed service cannot drift from the pinned facts.
ENV_HUB_BASE = "KOKORO_ENSURE_HUB_BASE"
ENV_EXE = "KOKORO_ENSURE_EXE"
ENV_EXE_SHA256 = "KOKORO_ENSURE_EXE_SHA256"
ENV_WEIGHTS = "KOKORO_ENSURE_WEIGHTS"
ENV_MIN_DISK = "KOKORO_ENSURE_MIN_FREE_DISK_BYTES"
ENV_MIN_MEM = "KOKORO_ENSURE_MIN_MEM_AVAILABLE_BYTES"
ENV_TEST_MODE = "KOKORO_ENSURE_TEST_MODE"          # must be exactly "1"
ENV_UNIT = "KOKORO_ENSURE_UNIT"                    # pinned unit identity

# Injectable seams for offline unit tests (module-level, monkeypatched).
_sleep = time.sleep
_now = time.monotonic
_disk_free_bytes = None   # set lazily to a default impl; see _disk_free
_mem_available = None     # set lazily to a default impl; see _mem_avail
_proc_exe = None          # /proc/<pid>/exe readlink
_proc_net_tcp = None      # /proc/net/tcp table text
_proc_cgroup = None       # /proc/<pid>/cgroup text
_fd_links = None          # /proc/<pid>/fd/* readlink targets

# Listener-owner guard pinning: the unit that must exclusively own the
# loopback listening socket; check is read-only /proc inspection only.
EXPECTED_UNIT = "audio-cpp-hub-kokoro-bluegreen.service"
SYSTEM_SLICE = "system.slice"
LOOPBACK_IPV4_HEX = "0100007F"   # 127.0.0.1 in /proc/net/tcp byte order
MAX_FD_WALK = 1024               # bounded /proc/<pid>/fd walk


class Fail(Exception):
    def __init__(self, code, msg):
        super().__init__(msg)
        self.code = code


class ListenerNotBound(Fail):
    """Candidate port is not yet bound; retry only during bounded initial boot."""


def log(msg):
    # type: (str) -> None
    # Never log request/response bodies or credentials; callers pass only
    # already-sanitized short fragments.
    sys.stderr.write("[kokoro-ensure-ready] %s\n" % msg)
    sys.stderr.flush()


# ------------------------------------------------------------- injectable impls

def _default_disk_free(path):
    # type: (str) -> int
    st = os.statvfs(path)
    return int(st.f_bavail) * int(st.f_frsize)


def _default_mem_available():
    # type: () -> int
    with open("/proc/meminfo", "r", encoding="ascii") as f:
        for line in f:
            if line.startswith("MemAvailable:"):
                return int(line.split()[1]) * 1024
    raise Fail(13, "MemAvailable not found in /proc/meminfo")


def _default_proc_exe(pid):
    # type: (str) -> str
    return os.readlink("/proc/%s/exe" % pid)


def disk_free(path):
    # type: (str) -> int
    fn = _disk_free_bytes or _default_disk_free
    return fn(path)


def mem_available():
    # type: () -> int
    fn = _mem_available or _default_mem_available
    return fn()


def proc_exe(pid):
    # type: (str) -> str
    return (_proc_exe or _default_proc_exe)(pid)


def _default_proc_net_tcp():
    # type: () -> str
    with open("/proc/net/tcp", "r", encoding="ascii") as f:
        return f.read(MAX_JSON_BYTES * 8)


def _default_proc_cgroup(pid):
    # type: (str) -> str
    with open("/proc/%s/cgroup" % pid, "r", encoding="ascii") as f:
        return f.read(MAX_JSON_BYTES)


def _default_fd_links(pid):
    # type: (str) -> List[str]
    # Bounded read-only walk: at most MAX_FD_WALK fds, no network access.
    fd_dir = "/proc/%s/fd" % pid
    links = []
    for name in os.listdir(fd_dir)[:MAX_FD_WALK]:
        try:
            links.append(os.readlink(os.path.join(fd_dir, name)))
        except OSError:
            continue
    return links


def proc_net_tcp():
    # type: () -> str
    return (_proc_net_tcp or _default_proc_net_tcp)()


def proc_cgroup(pid):
    # type: (str) -> str
    return (_proc_cgroup or _default_proc_cgroup)(pid)


def fd_links(pid):
    # type: (str) -> List[str]
    return (_fd_links or _default_fd_links)(pid)


def _port_hex(port):
    # type: (int) -> str
    return "%04X" % int(port)


def _cgroup_has_exact_service(cgroup_text, unit):
    # type: (str, str) -> bool
    # Exact membership: some cgroup path's components must be exactly
    # ["system.slice", unit] — a substring anywhere else is not enough.
    want = [SYSTEM_SLICE, unit]
    for line in cgroup_text.splitlines():
        parts = line.split(":", 2)
        if len(parts) < 3 or not parts[2]:
            continue
        comps = [c for c in parts[2].split("/") if c]
        if comps == want:
            return True
    return False


def _tcp_listen_inodes_on_loopback_port(table, port):
    # type: (str, int) -> int
    # Parse /proc/net/tcp: require exactly one TCP_LISTEN (state 0A) socket
    # with local 127.0.0.1:<port>; reject any wildcard/foreign LISTEN on the
    # same port or ambiguous extra listings. Returns the unique socket inode.
    want_local = "%s:%s" % (LOOPBACK_IPV4_HEX, _port_hex(port))
    want_ftport = _port_hex(port)
    loopback = []  # type: List[str]
    for line in table.splitlines()[1:]:
        fields = line.split()
        if len(fields) < 10:
            continue
        local, state = fields[1], fields[3]
        if state.upper() != "0A":
            continue
        addr, _, lport = local.partition(":")
        if lport.upper() != want_ftport:
            continue
        if local.upper() == want_local:
            loopback.append(fields[9])
        else:
            raise Fail(12, "foreign/wildcard LISTEN occupies pinned hub port %d" % port)
    if not loopback:
        raise ListenerNotBound(12, "candidate TCP listener not bound yet")
    if len(loopback) != 1:
        raise Fail(12, "ambiguous LISTEN entries on 127.0.0.1:%d" % port)
    inode = loopback[0]
    if not _digits(inode):
        raise Fail(12, "malformed socket inode for 127.0.0.1:%d" % port)
    return int(inode)


def check_listener_owner_guard(env, cfg):
    # type: (Dict[str, str], Dict[str, Any]) -> None
    """Read-only Linux guard: MAINPID must own 127.0.0.1:<hub_port> LISTEN.

    Fails closed (code 12) when /proc data is unavailable or the MAINPID
    process/cgroup/fd surface does not exactly match the pinned listener.
    """
    mainpid = env.get("MAINPID", "")
    if not _digits(mainpid) or int(mainpid) <= 0:
        raise Fail(12, "MAINPID missing/invalid for listener-owner guard")
    if env.get(ENV_UNIT, "") != EXPECTED_UNIT:
        raise Fail(12, "unit identity is not the pinned %s" % EXPECTED_UNIT)
    try:
        cgroup = proc_cgroup(mainpid)
    except OSError as e:
        raise Fail(12, "unavailable /proc cgroup: %s" % _safe(str(e)))
    if not _cgroup_has_exact_service(cgroup, EXPECTED_UNIT):
        raise Fail(12, "MAINPID cgroup is not exactly system.slice/%s" % EXPECTED_UNIT)
    try:
        table = proc_net_tcp()
    except OSError as e:
        raise Fail(12, "unavailable /proc/net/tcp: %s" % _safe(str(e)))
    inode = _tcp_listen_inodes_on_loopback_port(table, cfg["hub_port"])
    want_link = "socket:[%d]" % inode
    try:
        links = fd_links(mainpid)[:MAX_FD_WALK]
    except OSError as e:
        raise Fail(12, "unavailable /proc fd walk: %s" % _safe(str(e)))
    if want_link not in links:
        raise Fail(12, "MAINPID does not own the LISTEN socket inode of 127.0.0.1:%d" % cfg["hub_port"])


# ------------------------------------------------------------ strict validation

def _digits(s):
    # type: (str) -> bool
    return s.isascii() and s.isdigit()


def _env_bool_test_mode(env):
    # type: (Dict[str, str]) -> bool
    return env.get(ENV_TEST_MODE, "") == "1"


_LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")


def validate_hub_base(hub):
    # type: (str) -> int
    """Strictly validate a loopback http(s?) base URL; return the explicit port."""
    parsed = urllib.parse.urlparse(hub)
    if parsed.scheme != "http":
        raise Fail(11, "hub base URL must be plain http on loopback")
    if (parsed.hostname or "").lower() not in _LOOPBACK_HOSTS:
        raise Fail(11, "hub base URL must be loopback http://127.0.0.1[:port]")
    if parsed.port is not None and not (0 < parsed.port < 65536):
        # parsed.port raises ValueError on out-of-range values; trapped below.
        raise Fail(11, "bad hub port")
    if parsed.path not in ("", "/"):
        raise Fail(11, "hub base URL must not carry a path")
    return parsed.port if parsed.port is not None else 80


def resolve_config(env):
    # type: (Dict[str, str]) -> Dict[str, Any]
    test_mode = _env_bool_test_mode(env)
    if not test_mode:
        for var in (ENV_HUB_BASE, ENV_EXE, ENV_EXE_SHA256, ENV_WEIGHTS,
                    ENV_MIN_DISK, ENV_MIN_MEM):
            if var in env:
                # Strict production context: overrides are only meaningful in
                # test mode, so fail closed rather than silently ignoring them.
                raise Fail(11, "%s present without %s=1; refusing (production is pinned)" % (var, ENV_TEST_MODE))
        hub = HUB_BASE
        exe = EXPECTED_EXE
        exe_sha = EXPECTED_EXE_SHA256
        weights = WEIGHTS_PATH
        min_disk = MIN_FREE_DISK_BYTES
        min_mem = MIN_MEM_AVAILABLE_BYTES
    else:
        hub = env.get(ENV_HUB_BASE, HUB_BASE)
        exe = env.get(ENV_EXE, EXPECTED_EXE)
        exe_sha = env.get(ENV_EXE_SHA256, EXPECTED_EXE_SHA256)
        weights = env.get(ENV_WEIGHTS, WEIGHTS_PATH)
        min_disk = MIN_FREE_DISK_BYTES
        if env.get(ENV_MIN_DISK) is not None:
            if not _digits(env.get(ENV_MIN_DISK, "")):
                raise Fail(11, "bad %s" % ENV_MIN_DISK)
            min_disk = int(env.get(ENV_MIN_DISK, ""))
        min_mem = MIN_MEM_AVAILABLE_BYTES
        if env.get(ENV_MIN_MEM) is not None:
            if not _digits(env.get(ENV_MIN_MEM, "")):
                raise Fail(11, "bad %s" % ENV_MIN_MEM)
            min_mem = int(env.get(ENV_MIN_MEM, ""))

    try:
        port = validate_hub_base(hub)
    except ValueError:
        # urllib raises ValueError when parsing an out-of-range port.
        raise Fail(11, "bad hub port")

    if not _digits(str(EXPECTED_ENGINE_PORT)) or not (0 < EXPECTED_ENGINE_PORT < 65536):
        raise Fail(11, "bad engine port constant")
    if isinstance(EXPECTED_THREADS, bool) or EXPECTED_THREADS <= 0:
        raise Fail(11, "bad threads constant")
    return {
        "test_mode": test_mode,
        "hub": hub,
        "hub_port": port,
        "exe": exe,
        "exe_sha256": exe_sha.lower(),
        "weights": weights,
        "min_disk": min_disk,
        "min_mem": min_mem,
    }


# ------------------------------------------------------------------ bootstrap

def check_bootstrap_guard(env, cfg):
    # type: (Dict[str, str], Dict[str, Any]) -> None
    """Production/service identity: MAINPID + pinned unit + pinned binary.

    This run is a systemd ExecStartPost of the hub unit only if:
      - MAINPID is set and is a positive decimal PID;
      - /proc/<MAINPID>/exe is exactly cfg["exe"] (no symlink, no repaint);
      - KOKORO_ENSURE_UNIT is exactly the pinned unit name;
      - the hook's own environment contains systemd's INVOCATION_ID;
      - MAINPID has the pinned cgroup and owns the loopback listener.
      - /proc/<MAINPID>/environ is never opened (protect credentials).
    """
    mainpid = env.get("MAINPID", "")
    if not _digits(mainpid) or int(mainpid) <= 0:
        raise Fail(12, "MAINPID missing/invalid; refusing to run without the hub service context")
    exe = proc_exe(mainpid)
    if exe != cfg["exe"]:
        raise Fail(12, "MAINPID exe %s does not match expected %s" % (_safe(exe), _safe(cfg["exe"])))
    if env.get(ENV_UNIT) != EXPECTED_UNIT:
        raise Fail(12, "ExecStartPost unit name mismatch")
    if not env.get("INVOCATION_ID"):
        raise Fail(12, "missing systemd invocation identity")
    # Listener binding is asynchronous after Type=simple ExecStart.
    # wait_for_owned_listener() checks ownership before the first HTTP call.


def wait_for_owned_listener(env, cfg, deadline):
    # type: (Dict[str, str], Dict[str, Any], float) -> None
    """Permit only an initially absent listener to appear; reject foreign
    or wrongly owned sockets immediately. Never POST during this wait.
    """
    while True:
        if _now() >= deadline:
            raise Fail(20, "hub did not bind the pinned loopback port before deadline")
        try:
            check_listener_owner_guard(env, cfg)
            return
        except ListenerNotBound:
            if _now() + POLL_INTERVAL_SECONDS >= deadline:
                raise Fail(20, "candidate loopback bind deadline exceeded")
            _sleep(POLL_INTERVAL_SECONDS)


def verify_live_identity(env, cfg):
    # type: (Dict[str, str], Dict[str, Any]) -> None
    """Cheap mid-run re-verification (before POST and before declaring READY)."""
    if cfg["test_mode"]:
        return
    mainpid = env.get("MAINPID", "")
    if not _digits(mainpid):
        raise Fail(12, "MAINPID disappeared mid-run")
    if proc_exe(mainpid) != cfg["exe"]:
        raise Fail(12, "hub identity changed mid-run; refusing")
    # Re-verify the listener owner immediately before POST / accepting READY.
    check_listener_owner_guard(env, cfg)


def check_binary_identity(cfg):
    # type: (Dict[str, Any]) -> None
    # Symlink check: fail closed, no path-juggling
    if os.path.islink(cfg["exe"]) or os.path.islink(os.path.dirname(cfg["exe"]) or "/"):
        raise Fail(15, "hub binary path is a symlink; refusing")
    try:
        st = os.lstat(cfg["exe"])
    except OSError as e:
        raise Fail(15, "hub binary missing: %s" % e.strerror)
    if not stat.S_ISREG(st.st_mode):
        raise Fail(15, "hub binary is not a regular file")
    h = hashlib.sha256()
    with open(cfg["exe"], "rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    if h.hexdigest() != cfg["exe_sha256"]:
        raise Fail(12, "hub binary SHA256 mismatch; wrong target executable")


def check_weights(cfg):
    # type: (Dict[str, Any]) -> None
    if os.path.islink(cfg["weights"]):
        raise Fail(15, "weights path is a symlink; refusing")
    try:
        st = os.lstat(cfg["weights"])
    except OSError as e:
        raise Fail(15, "weights missing: %s" % e.strerror)
    if not stat.S_ISREG(st.st_mode) or st.st_size <= 0:
        raise Fail(15, "weights not a non-empty regular file")
    if disk_free(os.path.dirname(cfg["weights"]) or "/") < cfg["min_disk"]:
        raise Fail(13, "free disk below threshold before instance start")


def check_pressure(cfg):
    # type: (Dict[str, Any]) -> None
    if disk_free(os.path.dirname(cfg["weights"]) or "/") < cfg["min_disk"]:
        raise Fail(13, "free disk below threshold")
    if mem_available() < cfg["min_mem"]:
        raise Fail(13, "MemAvailable below threshold")


def _safe(s):
    # type: (str) -> str
    return s.replace("\\", "?").replace("\n", " ").replace("\r", " ")


# ------------------------------------------------------------------------ http

class Client:
    """Loopback-only client with proxy disabled and bounded body reads."""

    def __init__(self, base):
        # type: (str) -> None
        p = urllib.parse.urlparse(base)
        self.host = p.hostname or "127.0.0.1"
        self.port = p.port or 80
        # no proxies of any kind for localhost
        self.timeout = HTTP_TIMEOUT_SECONDS

    def request(self, method, path, body=None):
        # type: (str, str, Optional[bytes]) -> Union[Dict[str, Any], List[Any]]
        # Only plain ASCII path fragments are ever passed here.
        conn = http.client.HTTPConnection(self.host, self.port, timeout=self.timeout)
        try:
            headers = {"Host": "%s:%d" % (self.host, self.port)}
            if body is not None:
                headers["Content-Type"] = "application/json"
            conn.request(method, path, body=body, headers=headers)
            resp = conn.getresponse()
            if resp.status != 200:
                raise Fail(16, "HTTP %d on %s %s" % (resp.status, method, path))
            cl = resp.headers.get("Content-Length")
            if cl is not None:
                if not _digits(cl) or int(cl) > MAX_JSON_BYTES:
                    raise Fail(16, "oversize or malformed Content-Length on %s" % path)
            data = resp.read(MAX_JSON_BYTES + 1)
            if len(data) > MAX_JSON_BYTES:
                raise Fail(16, "response body oversize on %s" % path)
            try:
                parsed = json.loads(data.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                raise Fail(16, "malformed JSON on %s" % path)
            if not isinstance(parsed, (dict, list)):
                raise Fail(16, "unexpected JSON shape on %s" % path)
            return parsed
        except Fail:
            raise
        except (OSError, http.client.HTTPException, ValueError) as e:
            raise Fail(16, "unreachable endpoint %s%s: %s" % (method, path, _safe(str(e))))
        finally:
            conn.close()


# ------------------------------------------------------------------ orchestrate

def instances_target_and_foreign(instances, cfg):
    # type: (Any, Dict[str, Any]) -> Tuple[Optional[Dict[str, Any]], bool]
    # Exactly one entry may exist and it must be the pinned target with all
    # expected properties; any other entry is a foreign instance (fail closed).
    if not isinstance(instances, list):
        raise Fail(16, "/api/instances not a JSON array")
    if len(instances) > 1:
        raise Fail(17, "foreign instance present: /api/instances len %d" % len(instances))
    if not instances:
        return None, False
    inst = instances[0]
    if not isinstance(inst, dict):
        raise Fail(16, "instance entry not an object")
    checks = [
        ("instanceName", EXPECTED_INSTANCE_NAME),
        ("modelId", EXPECTED_MODEL_ID),
        ("backend", EXPECTED_BACKEND),
        ("weightsPath", cfg["weights"]),
    ]
    for key, want in checks:
        got = inst.get(key)
        if got != want:
            raise Fail(17, "instance %s=%r does not match expected %r" % (key, _safe(str(got)), _safe(str(want))))
    threads = inst.get("threads")
    if threads != EXPECTED_THREADS or not_1to64(threads):
        raise Fail(17, "instance threads=%r mismatch" % (threads,))
    port = inst.get("port")
    if port != EXPECTED_ENGINE_PORT or not_1to64(port):
        raise Fail(17, "instance port=%r mismatch" % (port,))
    return inst, False


def not_1to64(v):
    # type: (Any) -> bool
    # threads/port must be plain decimal ints (JSON numbers or digit strings)
    if isinstance(v, bool) or v is None:
        return True
    if isinstance(v, int):
        return False if 0 < v < 65536 else True
    if isinstance(v, str) and _digits(v):
        return not (0 < int(v) < 65536)
    return True


def verify_models_registry(client, cfg):
    # type: (Client, Dict[str, Any]) -> None
    root = client.request("GET", "/api/models")
    items = None
    if isinstance(root, list):
        items = root
    elif isinstance(root, dict) and isinstance(root.get("models"), list):
        items = root["models"]
    if items is None:
        raise Fail(14, "/api/models unexpected shape")
    for m in items:
        if isinstance(m, dict) and m.get("id") == EXPECTED_MODEL_ID:
            return
    raise Fail(14, "model %s not in registry" % EXPECTED_MODEL_ID)


def verify_v1_aliases(client):
    # type: (Client) -> None
    root = client.request("GET", "/v1/models")
    if not isinstance(root, dict) or not isinstance(root.get("data"), list):
        raise Fail(21, "/v1/models unexpected shape")
    ids = []
    for m in root["data"]:
        if not isinstance(m, dict) or not isinstance(m.get("id"), str):
            raise Fail(21, "/v1/models entry unexpected shape")
        ids.append(m["id"])
    if sorted(ids) != sorted(EXPECTED_V1_ALIASES):
        raise Fail(21, "/v1/models advertises %r, expected exactly %r" % (ids, list(EXPECTED_V1_ALIASES)))


def build_post_payload(cfg):
    # type: (Dict[str, Any]) -> bytes
    # Fixed, pre-serialized payload; "name" is the hub's POST field for the
    # service name (GET /api/instances reports it back as "instanceName").
    payload = {
        "modelId": EXPECTED_MODEL_ID,
        "name": EXPECTED_INSTANCE_NAME,
        "weightsPath": cfg["weights"],
        "backend": EXPECTED_BACKEND,
        "device": GPU_DEVICE,
        "threads": EXPECTED_THREADS,
    }
    return json.dumps(payload, separators=(",", ":")).encode("utf-8")


def run(env=None):
    # type: (Optional[Dict[str, str]]) -> int
    environ = env if env is not None else dict(os.environ)
    try:
        cfg = resolve_config(environ)
    except Fail:
        raise
    client = Client(cfg["hub"])
    deadline = _now() + MAX_TOTAL_SECONDS

    if cfg["test_mode"]:
        if environ.get("INVOCATION_ID"):
            raise Fail(11, "test mode is forbidden in a systemd service invocation")
        log("explicit isolated test context enabled; service identity guard conditional")
    else:
        check_bootstrap_guard(environ, cfg)
    check_binary_identity(cfg)
    check_weights(cfg)
    check_pressure(cfg)
    if not cfg["test_mode"]:
        # ExecStartPost can precede the Go listener bind; wait a bounded time
        # for the exact process-owned socket, not for an arbitrary HTTP server.
        wait_for_owned_listener(environ, cfg, deadline)

    verify_models_registry(client, cfg)

    posted = False
    payload = build_post_payload(cfg)

    while True:
        # Budget is wall clock, inclusive of HTTP call time: each iteration
        # (GET + any re-checks + poll sleep) must finish inside the deadline.
        if _now() > deadline:
            raise Fail(20, "time budget exceeded")
        inst, _ = instances_target_and_foreign(client.request("GET", "/api/instances"), cfg)
        if inst is not None:
            status = inst.get("status")
            if status == "READY":
                check_pressure(cfg)
                verify_live_identity(environ, cfg)
                # Ensure the on-disk weights state still matches what RUNTIME
                # reports, then confirm the alias surface without synthesis.
                verify_v1_aliases(client)
                log("kokoro instance READY and /v1/models advertises exactly %r" % (list(EXPECTED_V1_ALIASES),))
                return 0
            if status == "STARTING":
                check_pressure(cfg)
                if _now() + POLL_INTERVAL_SECONDS > deadline:
                    raise Fail(20, "time budget exceeded while STARTING")
                _sleep(POLL_INTERVAL_SECONDS)
                continue
            raise Fail(19, "instance entered unexpected status: %s" % _safe(str(status)))
        # no target instance
        if posted:
            raise Fail(17, "instance vanished after POST without hub restart; refusing recovery")
        verify_live_identity(environ, cfg)
        check_pressure(cfg)
        check_weights(cfg)
        verify_models_registry(client, cfg)  # cheap re-verify right before POST
        resp = client.request("POST", "/api/instances", body=payload)
        _validate_post_response(resp)
        log("POST /api/instances issued exactly once; polling toward READY")
        posted = True
        if _now() + POLL_INTERVAL_SECONDS > deadline:
            raise Fail(20, "time budget exceeded just after POST")
        _sleep(POLL_INTERVAL_SECONDS)


def _validate_post_response(resp):
    # type: (Any) -> None
    # POST is accepted as long as the body is a JSON object/array per hub
    # conventions; any HTTP non-200 already fails in Client.request with 16.
    if not isinstance(resp, (dict, list)):
        raise Fail(18, "POST /api/instances returned unexpected JSON shape")
    if isinstance(resp, dict) and resp.get("ok") is False:
        # Only the sanitized error message material reaches the log.
        raise Fail(18, "hub rejected instance start: %s" % _safe(str(resp.get("error", ""))))


def main():
    # type: () -> int
    try:
        return run()
    except Fail as e:
        log("FATAL (%d): %s" % (e.code, e))
        return e.code


if __name__ == "__main__":
    sys.exit(main())
