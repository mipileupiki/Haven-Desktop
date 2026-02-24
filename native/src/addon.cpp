// ═══════════════════════════════════════════════════════════
// Haven Desktop — N-API Addon Entry Point
//
// Exports:
//   isSupported()                → boolean
//   getAudioApplications()      → Array<{pid, name, icon}>
//   startCapture(pid, callback) → undefined
//   stopCapture()               → undefined
//   cleanup()                   → undefined
// ═══════════════════════════════════════════════════════════

#include <napi.h>
#include "audio_capture.h"
#include <memory>

static std::unique_ptr<haven::IAudioCapture> g_capture;

// ── Ensure the platform-specific capture object exists ─────
static haven::IAudioCapture* Cap() {
    if (!g_capture) g_capture.reset(haven::CreateAudioCapture());
    return g_capture.get();
}

// ── isSupported() ──────────────────────────────────────────
static Napi::Value IsSupported(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), Cap()->IsSupported());
}

// ── getAudioApplications() ─────────────────────────────────
static Napi::Value GetAudioApplications(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    auto apps = Cap()->GetAudioApplications();

    Napi::Array arr = Napi::Array::New(env, apps.size());
    for (size_t i = 0; i < apps.size(); i++) {
        Napi::Object obj = Napi::Object::New(env);
        obj.Set("pid",  Napi::Number::New(env, apps[i].pid));
        obj.Set("name", Napi::String::New(env, apps[i].name));
        obj.Set("icon", Napi::String::New(env, apps[i].icon));
        arr[i] = obj;
    }
    return arr;
}

// ── Threadsafe callback wrapper ────────────────────────────
// The native capture thread calls our lambda; we marshal PCM
// data to the JS thread via Napi::ThreadSafeFunction.
static Napi::ThreadSafeFunction g_tsfn;

static Napi::Value StartCapture(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsFunction()) {
        Napi::TypeError::New(env, "startCapture(pid: number, callback: function)")
            .ThrowAsJavaScriptException();
        return env.Undefined();
    }

    uint32_t pid = info[0].As<Napi::Number>().Uint32Value();
    Napi::Function jsCb = info[1].As<Napi::Function>();

    // Create a thread-safe function so the capture thread can post data
    g_tsfn = Napi::ThreadSafeFunction::New(
        env,
        jsCb,
        "HavenAudioCapture",
        0,    // unlimited queue
        1     // one thread
    );

    // Capture callback → runs on native thread
    haven::AudioDataCb nativeCb = [](const float* data, size_t count) {
        // Copy the PCM data so it survives across threads
        float* copy = new float[count];
        std::memcpy(copy, data, count * sizeof(float));

        g_tsfn.NonBlockingCall(copy, [count](Napi::Env env, Napi::Function fn, float* buf) {
            // Create a Float32Array and call the JS callback
            Napi::ArrayBuffer ab = Napi::ArrayBuffer::New(env, buf, count * sizeof(float),
                [](Napi::Env, void* ptr) { delete[] static_cast<float*>(ptr); });
            Napi::Float32Array f32 = Napi::Float32Array::New(env, count, ab, 0);
            fn.Call({ f32 });
        });
    };

    bool ok = Cap()->StartCapture(pid, nativeCb);
    if (!ok) {
        g_tsfn.Release();
        Napi::Error::New(env, "Failed to start capture for PID " + std::to_string(pid))
            .ThrowAsJavaScriptException();
    }

    return env.Undefined();
}

// ── stopCapture() ──────────────────────────────────────────
static Napi::Value StopCapture(const Napi::CallbackInfo& info) {
    Cap()->StopCapture();
    if (g_tsfn) { g_tsfn.Release(); g_tsfn = {}; }
    return info.Env().Undefined();
}

// ── cleanup() ──────────────────────────────────────────────
static Napi::Value Cleanup(const Napi::CallbackInfo& info) {
    if (g_tsfn) { g_tsfn.Release(); g_tsfn = {}; }
    Cap()->Cleanup();
    return info.Env().Undefined();
}

// ── Module init ────────────────────────────────────────────
static Napi::Object Init(Napi::Env env, Napi::Object exports) {
    exports.Set("isSupported",           Napi::Function::New(env, IsSupported));
    exports.Set("getAudioApplications",  Napi::Function::New(env, GetAudioApplications));
    exports.Set("startCapture",          Napi::Function::New(env, StartCapture));
    exports.Set("stopCapture",           Napi::Function::New(env, StopCapture));
    exports.Set("cleanup",              Napi::Function::New(env, Cleanup));
    return exports;
}

NODE_API_MODULE(haven_audio, Init)
