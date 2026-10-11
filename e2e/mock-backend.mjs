/* e2e 后端 mock：用 page.route 拦截 /api/* 与 /v1/*，返回确定性的内存状态。
   目标是让前端在无 Go 二进制、无 GPU、无模型的情况下也能跑通主链路。
   状态全部内存持有，每个测试用新的 MockBackend 实例，互不干扰。 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");

export function loadModels() {
  return JSON.parse(fs.readFileSync(path.join(repoRoot, "models.json"), "utf8"));
}

/** 一个最小合法 WAV（44 字节头 + 16 采样点静音），供 <audio> 与下载链接使用。 */
export function makeWavBytes(sampleRate = 16000, samples = 16) {
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

export class MockBackend {
  constructor(opts = {}) {
    this.models = opts.models || loadModels();
    this.executables = [...(opts.executables || [])];
    this.instances = [...(opts.instances || [])];
    this.downloads = [...(opts.downloads || [])];
    this.voices = [...(opts.voices || [])];
    this.history = structuredClone(opts.history || {});
    this.groups = structuredClone(opts.groups || {});
    this.events = opts.events || [];
    this.tasks = [];
    this.seq = 1;
    this.requests = [];
    /* 农场摘要。默认「不可用」，让 chip 退回本机实例计数；Now/Queue 状态条的
       并发上限也就走 DEFAULT_CAP。用例可以给 inFlightCap 覆盖。 */
    this.farm = opts.farm || { available: false };
  }

  nextId() {
    return String(this.seq++).padStart(4, "0");
  }

  model(id) {
    return this.models.find((m) => m.id === id) || null;
  }

  /** 拦截浏览器内所有 /api/* 与 /v1/* 请求。 */
  install(page) {
    page.route(
      (url) => url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/"),
      (route) => this.handle(route)
    );
  }

  json(route, data, status = 200) {
    return route.fulfill({
      status,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify(data)
    });
  }

  err(route, code, message) {
    return this.json(route, { ok: false, code, error: message || code }, 400);
  }

  async handle(route) {
    const req = route.request();
    const method = req.method();
    const url = new URL(req.url());
    const p = url.pathname;
    this.requests.push({ method, path: p });

    let body = {};
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      try {
        body = req.postDataJSON() || {};
      } catch {
        body = {};
      }
    }

    // ---------- 模型 / 包 ----------
    if (method === "GET" && p === "/api/models") return this.json(route, this.models);
    let m = p.match(/^\/api\/models\/([^/]+)\/packages$/);
    if (method === "GET" && m) return this.json(route, { packages: [] });

    // ---------- 农场摘要（同源，页头 chip 与 Now/Queue 状态条共用） ----------
    if (method === "GET" && p === "/api/farm/health") return this.json(route, this.farm);

    // ---------- 可执行文件 ----------
    if (p === "/api/executables") {
      if (method === "GET") return this.json(route, this.executables);
      if (method === "POST") {
        const ex = {
          id: "ex" + this.nextId(),
          name: body.name || "exec",
          path: body.path || "",
          note: body.note || "",
          env: body.env || {},
          exists: true
        };
        this.executables.push(ex);
        return this.json(route, ex);
      }
    }
    m = p.match(/^\/api\/executables\/([^/]+)\/devices$/);
    if (method === "GET" && m) {
      return this.json(route, {
        devices: [{ backend: "cpu", index: 0, name: "Mock CPU 0", type: "cpu" }],
        raw: ""
      });
    }
    m = p.match(/^\/api\/executables\/([^/]+)$/);
    if (m) {
      if (method === "PUT") {
        const ex = this.executables.find((x) => x.id === m[1]);
        if (ex) Object.assign(ex, body);
        return this.json(route, ex || {});
      }
      if (method === "DELETE") {
        this.executables = this.executables.filter((x) => x.id !== m[1]);
        return this.json(route, { ok: true });
      }
    }

    // ---------- 启动配置 ----------
    if (p === "/api/profiles") {
      if (method === "GET") return this.json(route, []);
      if (method === "POST") return this.json(route, { id: "p" + this.nextId(), ...body });
    }
    m = p.match(/^\/api\/profiles\/([^/]+)$/);
    if (m && method === "PUT") return this.json(route, { id: m[1], ...body });
    if (m && method === "DELETE") return this.json(route, { ok: true });

    // ---------- 实例 ----------
    if (p === "/api/instances") {
      if (method === "GET") return this.json(route, this.instances);
      if (method === "POST") {
        const modelId = body.modelId || (this.models[0] && this.models[0].id);
        const inst = {
          id: this.nextId(),
          modelId,
          instanceName: body.name || modelId,
          status: "READY",
          backend: body.backend || "cpu",
          device: body.device != null ? body.device : 0,
          port: body.port || 19000,
          threads: body.threads || null,
          weightsPath: body.weightsPath || "",
          executableName: "mock",
          taskCount: 0,
          createdAt: Date.now()
        };
        this.instances.push(inst);
        return this.json(route, inst);
      }
    }
    m = p.match(/^\/api\/instances\/([^/]+)$/);
    if (m && method === "DELETE") {
      this.instances = this.instances.filter((x) => x.id !== m[1]);
      return this.json(route, { ok: true });
    }

    // ---------- 下载 ----------
    if (p === "/api/downloads") {
      if (method === "GET") return this.json(route, this.downloads);
      if (method === "POST") {
        const d = {
          id: "d" + this.nextId(),
          modelId: body.modelId || null,
          targetDir: body.targetDir || "mock",
          status: "RUNNING",
          percent: 0,
          downloadedBytes: 0,
          totalBytes: 1000,
          speedBps: 0,
          completedFiles: 0,
          fileCount: 1
        };
        this.downloads.push(d);
        return this.json(route, d);
      }
    }
    m = p.match(/^\/api\/downloads\/([^/]+)\/(pause|resume)$/);
    if (m && method === "POST") {
      const d = this.downloads.find((x) => x.id === m[1]);
      if (!d) return this.json(route, { ok: false, error: "not found" }, 404);
      d.status = m[2] === "pause" ? "PAUSED" : "RUNNING";
      return this.json(route, d);
    }
    m = p.match(/^\/api\/downloads\/([^/]+)$/);
    if (m && method === "DELETE") {
      this.downloads = this.downloads.filter((x) => x.id !== m[1]);
      return this.json(route, { ok: true });
    }

    // ---------- 事件 / 证书 ----------
    if (method === "GET" && p === "/api/events") return this.json(route, this.events);
    // 用量与性能看板（#74 起懒加载，这里提供两个模型的样本以覆盖多卡片渲染）
    if (method === "GET" && p === "/api/stats") {
      return this.json(route, {
        generatedAt: 1756400000000,
        totals: {
          models: 2,
          total: 12,
          ok: 11,
          failed: 1,
          successRate: 0.917,
          audioSeconds: 48.6,
          outputBytes: 778240
        },
        models: [
          {
            modelId: "breeze-tts",
            instanceName: "breeze2tts",
            category: "tts",
            total: 10,
            ok: 10,
            failed: 0,
            successRate: 1,
            audioSeconds: 40.2,
            outputBytes: 643200,
            lastAt: 1756399000000,
            queueMsP50: 120,
            runMsP50: 2100,
            runMsP95: 3400,
            rtfP50: 0.42,
            samplesForPerf: 10
          },
          {
            modelId: "index-tts2",
            instanceName: "index2",
            category: "tts",
            total: 2,
            ok: 1,
            failed: 1,
            successRate: 0.5,
            audioSeconds: 8.4,
            outputBytes: 135040,
            lastAt: 1756300000000,
            // samplesForPerf = 0 → 看板不应展示性能行
            queueMsP50: 0,
            runMsP50: 0,
            runMsP95: 0,
            rtfP50: 0,
            samplesForPerf: 0
          },
          {
            modelId: "nonexistent_model",
            total: 0,
            ok: 0,
            failed: 0,
            successRate: 0,
            audioSeconds: 0,
            outputBytes: 0,
            lastAt: 0,
            queueMsP50: 0,
            runMsP50: 0,
            runMsP95: 0,
            rtfP50: 0,
            samplesForPerf: 3
          }
        ]
      });
    }
    if (method === "GET" && p === "/api/cert/status") {
      return this.json(route, { ok: true, data: { enabled: false, exists: false } });
    }
    if (method === "GET" && p === "/api/https/config") {
      return this.json(route, { ok: true, enabled: false });
    }
    if (method === "POST" && p === "/api/cert/generate") return this.json(route, { ok: true });

    // ---------- 音频 ----------
    if (method === "POST" && p === "/api/audio/info") {
      const file = body.path || "mock.wav";
      return this.json(route, {
        ok: true,
        path: file,
        durationSec: 1.5,
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        sizeBytes: 48044
      });
    }
    if (method === "POST" && p === "/api/audio/upload") {
      return this.json(route, {
        ok: true,
        id: "u" + this.nextId(),
        path: "data/uploads/mock.wav",
        durationSec: 1.5,
        sampleRate: 16000,
        channels: 1,
        bitsPerSample: 16,
        sizeBytes: 48044
      });
    }

    // ---------- 音色库 ----------
    if (p === "/api/voices") {
      if (method === "GET") return this.json(route, this.voices);
      if (method === "POST") {
        const name = (body.name || "").trim();
        if (this.voices.some((v) => v.name === name)) {
          return this.err(route, "VOICE_NAME_EXISTS", "音色名称已存在");
        }
        const v = { vid: "v" + this.nextId(), name, text: body.text || "", durationSec: 1.5 };
        this.voices.push(v);
        return this.json(route, v);
      }
    }
    m = p.match(/^\/api\/voices\/([^/]+)\/audio$/);
    if (method === "GET" && m) {
      return route.fulfill({ status: 200, contentType: "audio/wav", body: makeWavBytes() });
    }
    m = p.match(/^\/api\/voices\/([^/]+)$/);
    if (m) {
      if (method === "PUT") {
        const v = this.voices.find((x) => x.vid === m[1]);
        if (!v) return this.json(route, { ok: false, error: "not found" }, 404);
        if (body.name && this.voices.some((x) => x.vid !== m[1] && x.name === body.name)) {
          return this.err(route, "VOICE_NAME_EXISTS", "音色名称已存在");
        }
        Object.assign(v, { name: body.name ?? v.name, text: body.text ?? v.text });
        return this.json(route, v);
      }
      if (method === "DELETE") {
        this.voices = this.voices.filter((x) => x.vid !== m[1]);
        return this.json(route, { ok: true });
      }
    }

    // ---------- 任务队列 ----------
    if (method === "GET" && p === "/api/tasks") {
      const modelId = url.searchParams.get("modelId");
      const list = modelId ? this.tasks.filter((t) => t.modelId === modelId) : this.tasks;
      return this.json(route, list);
    }
    if (method === "POST" && p === "/api/tasks") {
      const inst = this.instances.find((i) => i.id === body.instanceId);
      const modelId = inst ? inst.modelId : null;
      const model = this.model(modelId);
      const category = model ? model.category : "other";
      const req = body.request || {};
      const now = Date.now();
      const task = {
        id: "t" + this.nextId(),
        modelId,
        category,
        status: "RUNNING",
        createdAt: now,
        startedAt: now,
        finishedAt: null,
        text: req.text || "",
        instanceId: body.instanceId,
        instanceName: inst ? inst.instanceName || inst.modelId : null,
        result: this.defaultResult(category, req)
      };
      this.tasks.push(task);
      return this.json(route, task);
    }
    m = p.match(/^\/api\/tasks\/([^/]+)\/result$/);
    if (method === "GET" && m) {
      const task = this.tasks.find((t) => t.id === m[1]);
      if (!task) return this.json(route, { ok: false, error: "task not found" }, 404);
      return this.json(route, task.result || {});
    }
    m = p.match(/^\/api\/tasks\/([^/]+)$/);
    if (m) {
      const task = this.tasks.find((t) => t.id === m[1]);
      if (method === "GET") {
        if (!task) return this.json(route, { ok: false, code: "TASK_NOT_FOUND" }, 404);
        // 首次查询即进入终态，让前端 2s 轮询快速收尾（确定性）
        if (task.status === "RUNNING" || task.status === "QUEUED") {
          task.status = "DONE";
          task.finishedAt = Date.now();
        }
        return this.json(route, task);
      }
      if (method === "DELETE") {
        if (!task) return this.json(route, { ok: false, code: "TASK_NOT_FOUND" }, 404);
        task.status = "CANCELLED";
        task.finishedAt = Date.now();
        return this.json(route, { ok: true });
      }
    }

    // ---------- 历史 ----------
    m = p.match(/^\/api\/history\/([^/]+)\/groups$/);
    if (m) {
      const modelId = m[1];
      const list = this.groups[modelId] || (this.groups[modelId] = []);
      if (method === "GET") return this.json(route, list);
      if (method === "POST") {
        if (list.some((g) => g.name === body.name)) {
          return this.err(route, "GROUP_EXISTS", "分组已存在");
        }
        const g = { id: "g" + this.nextId(), name: body.name };
        list.push(g);
        return this.json(route, g);
      }
    }
    m = p.match(/^\/api\/history\/([^/]+)\/groups\/([^/]+)$/);
    if (m) {
      const list = this.groups[m[1]] || [];
      if (method === "PUT") {
        const g = list.find((x) => x.id === m[2]);
        if (g) g.name = body.name;
        return this.json(route, g || {});
      }
      if (method === "DELETE") {
        this.groups[m[1]] = list.filter((x) => x.id !== m[2]);
        for (const item of this.history[m[1]] || []) if (item.groupId === m[2]) item.groupId = null;
        return this.json(route, { ok: true });
      }
    }
    m = p.match(/^\/api\/history\/([^/]+)\/([^/]+)\/group$/);
    if (m && method === "PUT") {
      const item = (this.history[m[1]] || []).find((x) => x.taskId === m[2]);
      if (item) item.groupId = body.groupId || null;
      return this.json(route, { ok: true });
    }
    m = p.match(/^\/api\/history\/([^/]+)\/([^/]+)\/audio\/([^/]+)$/);
    if (method === "GET" && m) {
      return route.fulfill({ status: 200, contentType: "audio/wav", body: makeWavBytes() });
    }
    m = p.match(/^\/api\/history\/([^/]+)\/([^/]+)\/audio$/);
    if (method === "GET" && m) {
      return route.fulfill({ status: 200, contentType: "audio/wav", body: makeWavBytes() });
    }
    m = p.match(/^\/api\/history\/([^/]+)\/([^/]+)$/);
    if (m) {
      const list = this.history[m[1]] || (this.history[m[1]] = []);
      if (method === "GET") {
        const item = list.find((x) => x.taskId === m[2]);
        if (!item) return this.json(route, { ok: false, code: "HISTORY_NOT_FOUND" }, 404);
        return this.json(route, item.full || item);
      }
      if (method === "DELETE") {
        this.history[m[1]] = list.filter((x) => x.taskId !== m[2]);
        return this.json(route, { ok: true });
      }
    }
    m = p.match(/^\/api\/history\/([^/]+)$/);
    if (m) {
      if (method === "GET") return this.json(route, this.history[m[1]] || []);
      if (method === "DELETE") {
        this.history[m[1]] = [];
        return this.json(route, { ok: true });
      }
    }

    // ---------- 文件浏览 ----------
    if (method === "GET" && p === "/api/fs/roots") {
      return this.json(route, { roots: [{ name: "/", path: "/" }] });
    }
    if (method === "GET" && p === "/api/fs/list") {
      return this.json(route, { path: url.searchParams.get("path") || "/", entries: [] });
    }

    // ---------- OpenAI 代理（前端未用，占位） ----------
    if (p.startsWith("/v1/")) return this.json(route, { data: [] });

    return this.json(
      route,
      { ok: false, code: "MOCK_UNHANDLED", error: `no mock for ${method} ${p}` },
      404
    );
  }

  defaultResult(category, req) {
    if (category === "asr") {
      return { text: "mock transcript: hello from audio.cpp-hub", language: "en" };
    }
    return { text: req.text || "mock result" };
  }
}
