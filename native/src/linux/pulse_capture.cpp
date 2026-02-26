// ═══════════════════════════════════════════════════════════
// Haven Desktop — Linux PulseAudio Per-App Audio Capture
//
// Strategy:
//   1. Enumerate sink inputs → each has a PID + app name
//   2. Load module-null-sink (virtual sink "HavenCapture")
//   3. Move the target app's sink input to the null sink
//   4. Load module-loopback from null sink → default output
//      (so the user still hears the app)
//   5. Record from the null sink's monitor source at 48 kHz
//   6. On stop, unload modules and restore the app's original sink
//
// Requires: libpulse-dev  (or pipewire-pulse on modern distros)
// ═══════════════════════════════════════════════════════════
#ifdef PLATFORM_LINUX

#include "pulse_capture.h"

#include <pulse/pulseaudio.h>
#include <pulse/simple.h>
#include <pulse/error.h>

#include <cstring>
#include <cstdlib>
#include <vector>
#include <string>
#include <unistd.h>
#include <dirent.h>
#include <fstream>
#include <sstream>
#include <algorithm>

namespace haven {

// ── Helpers ───────────────────────────────────────────────

// Get process name from /proc/<pid>/comm
static std::string procName(uint32_t pid) {
    std::string path = "/proc/" + std::to_string(pid) + "/comm";
    std::ifstream f(path);
    std::string name;
    if (f.is_open() && std::getline(f, name)) {
        // Strip trailing newline
        while (!name.empty() && (name.back() == '\n' || name.back() == '\r'))
            name.pop_back();
        return name;
    }
    return "Unknown";
}

// Synchronous PulseAudio helper — runs main loop until callback signals done
struct PaSync {
    pa_mainloop*     ml  = nullptr;
    pa_mainloop_api* api = nullptr;
    pa_context*      ctx = nullptr;
    bool             ready = false;
    bool             done  = false;

    PaSync() {
        ml  = pa_mainloop_new();
        api = pa_mainloop_get_api(ml);
        ctx = pa_context_new(api, "HavenDesktop");
    }

    bool connect() {
        if (pa_context_connect(ctx, nullptr, PA_CONTEXT_NOFLAGS, nullptr) < 0)
            return false;

        // Wait for context to be ready
        for (;;) {
            pa_mainloop_iterate(ml, 1, nullptr);
            auto state = pa_context_get_state(ctx);
            if (state == PA_CONTEXT_READY) return true;
            if (!PA_CONTEXT_IS_GOOD(state)) return false;
        }
    }

    void iterate() { pa_mainloop_iterate(ml, 0, nullptr); }
    void iterateBlock() { pa_mainloop_iterate(ml, 1, nullptr); }

    ~PaSync() {
        if (ctx) { pa_context_disconnect(ctx); pa_context_unref(ctx); }
        if (ml)  pa_mainloop_free(ml);
    }
};

// ── Sink input enumeration callback data ──────────────────
struct SinkInputInfo {
    uint32_t    index;
    uint32_t    pid;
    uint32_t    sinkIndex;
    std::string name;
};

// File-scope struct used by the sink-input enumeration callback.
// Replaces an old trick of manual pointer arithmetic to reach the
// "done" flag — that relied on the compiler placing no padding after
// the vector, which is UB-adjacent and crashed on some PipeWire hosts.
struct SinkInputEnumData {
    std::vector<SinkInputInfo> inputs;
    bool done = false;
};

static void sinkInputCb(pa_context*, const pa_sink_input_info* info, int eol, void* ud) {
    auto* data = static_cast<SinkInputEnumData*>(ud);
    if (eol > 0 || !info) { data->done = true; return; }

    SinkInputInfo si;
    si.index     = info->index;
    si.sinkIndex = info->sink;
    si.name      = info->name ? info->name : "Unknown";

    const char* pidStr = pa_proplist_gets(info->proplist, PA_PROP_APPLICATION_PROCESS_ID);
    si.pid = pidStr ? (uint32_t)atoi(pidStr) : 0;

    const char* appName = pa_proplist_gets(info->proplist, PA_PROP_APPLICATION_NAME);
    if (appName && strlen(appName) > 0) si.name = appName;

    data->inputs.push_back(si);
}

// Module load callback
struct ModuleLoadResult {
    uint32_t index = PA_INVALID_INDEX;
    bool     done  = false;
};

static void moduleLoadCb(pa_context*, uint32_t idx, void* ud) {
    auto* r = (ModuleLoadResult*)ud;
    r->index = idx;
    r->done  = true;
}

// Success callback
struct OpDone { bool done = false; };
static void successCb(pa_context*, int, void* ud) {
    ((OpDone*)ud)->done = true;
}

// ═══════════════════════════════════════════════════════════
// PulseCapture
// ═══════════════════════════════════════════════════════════

PulseCapture::PulseCapture() {}
PulseCapture::~PulseCapture() { StopCapture(); }

bool PulseCapture::IsSupported() const {
    // Check if PulseAudio is available
    pa_simple* s = nullptr;
    pa_sample_spec ss = { PA_SAMPLE_FLOAT32LE, 48000, 1 };
    s = pa_simple_new(nullptr, "HavenProbe", PA_STREAM_RECORD, nullptr, "probe", &ss, nullptr, nullptr, nullptr);
    if (s) { pa_simple_free(s); return true; }
    return false;
}

std::vector<AudioApp> PulseCapture::GetAudioApplications() {
    std::vector<AudioApp> result;

    PaSync pa;
    if (!pa.connect()) return result;

    // Enumerate sink inputs
    SinkInputEnumData ed;

    pa_operation* op = pa_context_get_sink_input_info_list(pa.ctx, sinkInputCb, &ed);
    if (!op) return result;

    while (!ed.done) pa.iterateBlock();
    pa_operation_unref(op);

    // Deduplicate by PID
    std::vector<uint32_t> seen;
    for (auto& si : ed.inputs) {
        if (si.pid == 0) continue;
        if (std::find(seen.begin(), seen.end(), si.pid) != seen.end()) continue;
        seen.push_back(si.pid);

        AudioApp app;
        app.pid  = si.pid;
        app.name = si.name.empty() ? procName(si.pid) : si.name;
        result.push_back(app);
    }

    return result;
}

bool PulseCapture::StartCapture(uint32_t pid, AudioDataCb cb) {
    StopCapture();

    std::lock_guard<std::mutex> lock(m_mutex);
    m_targetPid = pid;
    m_callback  = cb;
    m_running   = true;

    m_thread = std::thread([this]() { captureLoop(); });
    return true;
}

void PulseCapture::StopCapture() {
    m_running = false;
    if (m_thread.joinable()) m_thread.join();
    std::lock_guard<std::mutex> lock(m_mutex);
    m_callback = nullptr;

    // Clean up PulseAudio modules
    if (m_nullSinkModule != 0 || m_loopbackModule != 0) {
        PaSync pa;
        if (pa.connect()) {
            if (m_loopbackModule != 0) {
                OpDone od;
                auto* op = pa_context_unload_module(pa.ctx, m_loopbackModule, successCb, &od);
                if (op) { while (!od.done) pa.iterateBlock(); pa_operation_unref(op); }
            }
            if (m_nullSinkModule != 0) {
                OpDone od;
                auto* op = pa_context_unload_module(pa.ctx, m_nullSinkModule, successCb, &od);
                if (op) { while (!od.done) pa.iterateBlock(); pa_operation_unref(op); }
            }
        }
        m_nullSinkModule = 0;
        m_loopbackModule = 0;
    }
}

void PulseCapture::Cleanup() { StopCapture(); }

void PulseCapture::captureLoop() {
    PaSync pa;
    if (!pa.connect()) { m_running = false; return; }

    // ── Step 1: Find the target process's sink input ──────
    SinkInputEnumData ed;

    pa_operation* op = pa_context_get_sink_input_info_list(pa.ctx, sinkInputCb, &ed);
    if (!op) { m_running = false; return; }
    while (!ed.done) pa.iterateBlock();
    pa_operation_unref(op);

    uint32_t targetSinkInput = PA_INVALID_INDEX;
    uint32_t originalSink    = PA_INVALID_INDEX;

    for (auto& si : ed.inputs) {
        if (si.pid == m_targetPid) {
            targetSinkInput = si.index;
            originalSink    = si.sinkIndex;
            break;
        }
    }

    if (targetSinkInput == PA_INVALID_INDEX) {
        // No sink input found for this PID
        m_running = false;
        return;
    }

    // ── Detect PipeWire ───────────────────────────────────
    // PipeWire's pipewire-pulse adds "pipewire" to server info.
    // On PipeWire, moving a sink input can crash Chromium-based
    // apps, so we use module-combine-sink instead (keeps the
    // original output alive while teeing audio to our capture).
    struct ServerInfo { std::string name; bool done = false; };
    ServerInfo si;
    auto serverInfoCb = [](pa_context*, const pa_server_info* info, void* ud) {
        auto* s = (ServerInfo*)ud;
        if (info && info->server_name) s->name = info->server_name;
        s->done = true;
    };
    op = pa_context_get_server_info(pa.ctx, serverInfoCb, &si);
    if (op) { while (!si.done) pa.iterateBlock(); pa_operation_unref(op); }

    bool isPipeWire = (si.name.find("PipeWire") != std::string::npos) ||
                      (si.name.find("pipewire") != std::string::npos);

    // ── Step 2: Create a null sink for recording ──────────
    ModuleLoadResult nullRes;
    op = pa_context_load_module(pa.ctx, "module-null-sink",
        "sink_name=HavenCapture "
        "sink_properties=device.description=\"Haven\\ Per-App\\ Capture\" "
        "rate=48000 channels=1 format=float32le",
        moduleLoadCb, &nullRes);
    if (!op) { m_running = false; return; }
    while (!nullRes.done) pa.iterateBlock();
    pa_operation_unref(op);

    if (nullRes.index == PA_INVALID_INDEX) { m_running = false; return; }
    m_nullSinkModule = nullRes.index;

    // ── Look up the null sink index ───────────────────────
    struct SinkLookup { uint32_t idx = PA_INVALID_INDEX; bool done = false; };
    SinkLookup sl;

    auto sinkInfoCb = [](pa_context*, const pa_sink_info* info, int eol, void* ud) {
        auto* s = (SinkLookup*)ud;
        if (eol > 0 || !info) { s->done = true; return; }
        if (info->name && std::string(info->name) == "HavenCapture") {
            s->idx = info->index;
        }
    };

    op = pa_context_get_sink_info_by_name(pa.ctx, "HavenCapture", sinkInfoCb, &sl);
    if (op) { while (!sl.done) pa.iterateBlock(); pa_operation_unref(op); }

    if (sl.idx == PA_INVALID_INDEX) {
        // Cleanup and bail
        OpDone od;
        op = pa_context_unload_module(pa.ctx, m_nullSinkModule, successCb, &od);
        if (op) { while (!od.done) pa.iterateBlock(); pa_operation_unref(op); }
        m_nullSinkModule = 0;
        m_running = false;
        return;
    }

    // ── Look up the original sink name (needed for combine-sink) ──
    struct SinkNameLookup { std::string name; bool done = false; };
    SinkNameLookup origSinkLookup;
    auto sinkNameCb = [](pa_context*, const pa_sink_info* info, int eol, void* ud) {
        auto* s = (SinkNameLookup*)ud;
        if (eol > 0 || !info) { s->done = true; return; }
        if (info->name) s->name = info->name;
    };

    op = pa_context_get_sink_info_by_index(pa.ctx, originalSink, sinkNameCb, &origSinkLookup);
    if (op) { while (!origSinkLookup.done) pa.iterateBlock(); pa_operation_unref(op); }

    // ── Step 3: Route audio ───────────────────────────────
    //
    // PipeWire path: create a combine-sink that sends audio to
    // both the original output AND our null sink. Then gently
    // move the app to the combined sink. The app never loses
    // its audio output so Chromium/etc. stay stable.
    //
    // PulseAudio path: move the app to the null sink directly
    // (the old approach) and use a loopback for monitoring.
    //
    if (isPipeWire && !origSinkLookup.name.empty()) {
        // Create a combine-sink: original output + HavenCapture
        std::string combineArgs = "sink_name=HavenCombined "
            "sink_properties=device.description=\"Haven\\ Combined\\ Capture\" "
            "slaves=" + origSinkLookup.name + ",HavenCapture";

        ModuleLoadResult combRes;
        op = pa_context_load_module(pa.ctx, "module-combine-sink",
            combineArgs.c_str(), moduleLoadCb, &combRes);
        if (op) { while (!combRes.done) pa.iterateBlock(); pa_operation_unref(op); }

        // m_loopbackModule repurposed to store the combine-sink module ID
        m_loopbackModule = combRes.index;

        // Look up HavenCombined sink index
        SinkLookup csl;
        auto combineSinkCb = [](pa_context*, const pa_sink_info* info, int eol, void* ud) {
            auto* s = (SinkLookup*)ud;
            if (eol > 0 || !info) { s->done = true; return; }
            if (info->name && std::string(info->name) == "HavenCombined") {
                s->idx = info->index;
            }
        };
        op = pa_context_get_sink_info_by_name(pa.ctx, "HavenCombined", combineSinkCb, &csl);
        if (op) { while (!csl.done) pa.iterateBlock(); pa_operation_unref(op); }

        if (csl.idx != PA_INVALID_INDEX) {
            // Small delay to let PipeWire finish setting up the combined sink
            usleep(150000);
            OpDone od;
            op = pa_context_move_sink_input_by_index(pa.ctx, targetSinkInput, csl.idx, successCb, &od);
            if (op) { while (!od.done) pa.iterateBlock(); pa_operation_unref(op); }
        }
    } else {
        // Classic PulseAudio: move sink input to null sink directly
        {
            OpDone od;
            op = pa_context_move_sink_input_by_index(pa.ctx, targetSinkInput, sl.idx, successCb, &od);
            if (op) { while (!od.done) pa.iterateBlock(); pa_operation_unref(op); }
        }

        // Loopback null sink → default output so user still hears the app
        {
            ModuleLoadResult lbRes;
            std::string args = "source=HavenCapture.monitor sink_dont_move=true";
            op = pa_context_load_module(pa.ctx, "module-loopback", args.c_str(), moduleLoadCb, &lbRes);
            if (op) { while (!lbRes.done) pa.iterateBlock(); pa_operation_unref(op); }
            m_loopbackModule = lbRes.index;
        }
    }

    // ── Step 5: Record from the null sink's monitor ───────
    // Small delay lets PipeWire (pipewire-pulse) finish creating the
    // monitor source after module-null-sink was loaded.
    usleep(100000); // 100 ms

    pa_sample_spec ss;
    ss.format   = PA_SAMPLE_FLOAT32LE;
    ss.rate     = 48000;
    ss.channels = 1;

    int err = 0;
    pa_simple* rec = pa_simple_new(
        nullptr, "HavenDesktop", PA_STREAM_RECORD,
        "HavenCapture.monitor", "Per-App Capture",
        &ss, nullptr, nullptr, &err
    );

    if (!rec) {
        fprintf(stderr, "[Haven AudioCapture] pa_simple_new failed: %s\n", pa_strerror(err));
        // Clean up modules before returning
        if (m_loopbackModule != 0) {
            OpDone od;
            auto* unOp = pa_context_unload_module(pa.ctx, m_loopbackModule, successCb, &od);
            if (unOp) { while (!od.done) pa.iterateBlock(); pa_operation_unref(unOp); }
            m_loopbackModule = 0;
        }
        if (m_nullSinkModule != 0) {
            OpDone od;
            auto* unOp = pa_context_unload_module(pa.ctx, m_nullSinkModule, successCb, &od);
            if (unOp) { while (!od.done) pa.iterateBlock(); pa_operation_unref(unOp); }
            m_nullSinkModule = 0;
        }
        // Restore original sink
        if (originalSink != PA_INVALID_INDEX) {
            OpDone od;
            auto* mvOp = pa_context_move_sink_input_by_index(pa.ctx, targetSinkInput, originalSink, successCb, &od);
            if (mvOp) { while (!od.done) pa.iterateBlock(); pa_operation_unref(mvOp); }
        }
        m_running = false;
        return;
    }

    // Read PCM data in ~10 ms chunks
    const size_t chunkFrames = 480; // 10 ms at 48 kHz
    std::vector<float> buf(chunkFrames);

    while (m_running) {
        if (pa_simple_read(rec, buf.data(), chunkFrames * sizeof(float), &err) < 0) {
            break;
        }

        std::lock_guard<std::mutex> lock(m_mutex);
        if (m_callback) {
            m_callback(buf.data(), chunkFrames);
        }
    }

    pa_simple_free(rec);

    // ── Step 6: Restore original sink ─────────────────────
    {
        PaSync pa2;
        if (pa2.connect()) {
            if (originalSink != PA_INVALID_INDEX) {
                OpDone od;
                op = pa_context_move_sink_input_by_index(pa2.ctx, targetSinkInput, originalSink, successCb, &od);
                if (op) { while (!od.done) pa2.iterateBlock(); pa_operation_unref(op); }
            }
        }
    }
    // Module cleanup happens in StopCapture()
}

// ── Factory ───────────────────────────────────────────────
IAudioCapture* CreateAudioCapture() {
    return new PulseCapture();
}

} // namespace haven

#endif // PLATFORM_LINUX
