// ═══════════════════════════════════════════════════════════
// Haven Desktop — Windows WASAPI Per-Process Audio Capture
//
// Captures audio from a single process using the Windows 10
// 2004+ (build 19041) Process Loopback API.
//
// Flow:
//   1) ActivateAudioInterfaceAsync with process-loopback params
//   2) Initialize IAudioClient in shared mode, 48 kHz float32
//   3) Background thread reads capture buffer, converts to mono
//      float32, and pushes to the JS callback via AudioDataCb
//
// For app enumeration we use IAudioSessionEnumerator to list
// every active audio session and its owning PID.
// ═══════════════════════════════════════════════════════════
#ifdef PLATFORM_WINDOWS

#include "wasapi_capture.h"

// Windows headers — order matters
#include <initguid.h>
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <functiondiscoverykeys_devpkey.h>
#include <Psapi.h>
#include <tlhelp32.h>
#include <combaseapi.h>

// Process Loopback API (Win10 2004+)
#include <audioclientactivationparams.h>

#include <vector>
#include <string>
#include <cstring>
#include <algorithm>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "Avrt.lib")
#pragma comment(lib, "Psapi.lib")

// ── Helper: wide → UTF-8 ──────────────────────────────────
static std::string WideToUtf8(const wchar_t* wide) {
    if (!wide || !*wide) return "";
    int len = WideCharToMultiByte(CP_UTF8, 0, wide, -1, nullptr, 0, nullptr, nullptr);
    std::string s(len - 1, '\0');
    WideCharToMultiByte(CP_UTF8, 0, wide, -1, &s[0], len, nullptr, nullptr);
    return s;
}

// ── Helper: get process name from PID ─────────────────────
static std::string ProcessNameFromPid(DWORD pid) {
    HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, pid);
    if (!h) return "Unknown";
    wchar_t buf[MAX_PATH] = {};
    DWORD sz = MAX_PATH;
    if (QueryFullProcessImageNameW(h, 0, buf, &sz)) {
        CloseHandle(h);
        std::wstring full(buf);
        auto pos = full.find_last_of(L"\\/");
        std::wstring fname = (pos != std::wstring::npos) ? full.substr(pos + 1) : full;
        // Strip .exe
        auto dot = fname.rfind(L".exe");
        if (dot != std::wstring::npos) fname = fname.substr(0, dot);
        return WideToUtf8(fname.c_str());
    }
    CloseHandle(h);
    return "Unknown";
}

// ── Completion handler for ActivateAudioInterfaceAsync ────
class ActivateHandler : public IActivateAudioInterfaceCompletionHandler {
public:
    ActivateHandler() : m_refCount(1), m_hr(E_FAIL), m_client(nullptr) {
        m_event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
    }
    ~ActivateHandler() { CloseHandle(m_event); }

    // IUnknown
    ULONG STDMETHODCALLTYPE AddRef()  override { return InterlockedIncrement(&m_refCount); }
    ULONG STDMETHODCALLTYPE Release() override {
        ULONG c = InterlockedDecrement(&m_refCount);
        if (c == 0) delete this;
        return c;
    }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppv) override {
        if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = nullptr;
        return E_NOINTERFACE;
    }

    // IActivateAudioInterfaceCompletionHandler
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) override {
        HRESULT hrActivate = E_FAIL;
        IUnknown* punk = nullptr;
        HRESULT hr = op->GetActivateResult(&hrActivate, &punk);
        if (SUCCEEDED(hr) && SUCCEEDED(hrActivate) && punk) {
            punk->QueryInterface(__uuidof(IAudioClient), (void**)&m_client);
            punk->Release();
            m_hr = S_OK;
        } else {
            m_hr = FAILED(hr) ? hr : hrActivate;
        }
        SetEvent(m_event);
        return S_OK;
    }

    HRESULT Wait(DWORD ms = 5000) {
        WaitForSingleObject(m_event, ms);
        return m_hr;
    }

    IAudioClient* GetClient() { return m_client; }

private:
    ULONG         m_refCount;
    HRESULT       m_hr;
    IAudioClient* m_client;
    HANDLE        m_event;
};

namespace haven {

// ═══════════════════════════════════════════════════════════
// WasapiCapture
// ═══════════════════════════════════════════════════════════

WasapiCapture::WasapiCapture() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);
}

WasapiCapture::~WasapiCapture() {
    StopCapture();
}

// ── IsSupported ────────────────────────────────────────────
// Process loopback requires Windows 10 build 19041+
bool WasapiCapture::IsSupported() const {
    OSVERSIONINFOEXW ovi = {};
    ovi.dwOSVersionInfoSize = sizeof(ovi);
    // Use RtlGetVersion (not deprecated like GetVersionEx)
    using RtlGetVersionFn = LONG(WINAPI*)(PRTL_OSVERSIONINFOW);
    auto RtlGetVersion = (RtlGetVersionFn)GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "RtlGetVersion");
    if (RtlGetVersion) {
        RtlGetVersion((PRTL_OSVERSIONINFOW)&ovi);
        // Win10 20H1 = build 19041
        return (ovi.dwMajorVersion > 10) ||
               (ovi.dwMajorVersion == 10 && ovi.dwBuildNumber >= 19041);
    }
    return false;
}

// ── GetAudioApplications ───────────────────────────────────
// Enumerates active audio sessions via WASAPI session manager.
std::vector<AudioApp> WasapiCapture::GetAudioApplications() {
    std::vector<AudioApp> result;

    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr,
        CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&enumerator);
    if (FAILED(hr)) return result;

    IMMDevice* device = nullptr;
    hr = enumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
    if (FAILED(hr)) { enumerator->Release(); return result; }

    IAudioSessionManager2* mgr = nullptr;
    hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr, (void**)&mgr);
    if (FAILED(hr)) { device->Release(); enumerator->Release(); return result; }

    IAudioSessionEnumerator* sessions = nullptr;
    hr = mgr->GetSessionEnumerator(&sessions);
    if (FAILED(hr)) { mgr->Release(); device->Release(); enumerator->Release(); return result; }

    int count = 0;
    sessions->GetCount(&count);

    // Track PIDs we've already seen (avoid duplicates)
    std::vector<DWORD> seen;

    for (int i = 0; i < count; i++) {
        IAudioSessionControl* ctrl = nullptr;
        if (FAILED(sessions->GetSession(i, &ctrl))) continue;

        IAudioSessionControl2* ctrl2 = nullptr;
        if (FAILED(ctrl->QueryInterface(__uuidof(IAudioSessionControl2), (void**)&ctrl2))) {
            ctrl->Release(); continue;
        }

        // Skip system sounds
        if (ctrl2->IsSystemSoundsSession() == S_OK) {
            ctrl2->Release(); ctrl->Release(); continue;
        }

        DWORD pid = 0;
        ctrl2->GetProcessId(&pid);
        if (pid == 0 || std::find(seen.begin(), seen.end(), pid) != seen.end()) {
            ctrl2->Release(); ctrl->Release(); continue;
        }
        seen.push_back(pid);

        // Session state — only include active sessions
        AudioSessionState state;
        if (SUCCEEDED(ctrl->GetState(&state)) && state == AudioSessionStateActive) {
            AudioApp app;
            app.pid  = pid;
            app.name = ProcessNameFromPid(pid);
            result.push_back(app);
        }

        ctrl2->Release();
        ctrl->Release();
    }

    sessions->Release();
    mgr->Release();
    device->Release();
    enumerator->Release();

    return result;
}

// ── StartCapture ───────────────────────────────────────────
bool WasapiCapture::StartCapture(uint32_t pid, AudioDataCb cb) {
    StopCapture();

    std::lock_guard<std::mutex> lock(m_mutex);
    m_targetPid = pid;
    m_callback  = cb;
    m_running   = true;

    m_thread = std::thread([this]() { captureLoop(); });
    return true;
}

// ── StopCapture ────────────────────────────────────────────
void WasapiCapture::StopCapture() {
    m_running = false;
    if (m_thread.joinable()) m_thread.join();
    std::lock_guard<std::mutex> lock(m_mutex);
    m_callback = nullptr;
}

void WasapiCapture::Cleanup() { StopCapture(); }

// ── Capture Loop ───────────────────────────────────────────
// Runs on a dedicated thread. Activates per-process loopback
// and reads PCM until m_running becomes false.
void WasapiCapture::captureLoop() {
    CoInitializeEx(nullptr, COINIT_MULTITHREADED);

    // ── Set up process-loopback activation params ──────────
    AUDIOCLIENT_ACTIVATION_PARAMS acParams = {};
    acParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    acParams.ProcessLoopbackParams.ProcessLoopbackMode =
        PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    acParams.ProcessLoopbackParams.TargetProcessId = m_targetPid;

    PROPVARIANT pv = {};
    pv.vt = VT_BLOB;
    pv.blob.cbSize    = sizeof(acParams);
    pv.blob.pBlobData = reinterpret_cast<BYTE*>(&acParams);

    // ── Activate the audio interface ───────────────────────
    auto handler = new ActivateHandler();
    IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;

    HRESULT hr = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        __uuidof(IAudioClient),
        &pv,
        handler,
        &asyncOp
    );

    if (FAILED(hr)) {
        handler->Release();
        CoUninitialize();
        m_running = false;
        return;
    }

    hr = handler->Wait(10000);
    IAudioClient* client = handler->GetClient();
    if (asyncOp) asyncOp->Release();
    handler->Release();

    if (FAILED(hr) || !client) {
        CoUninitialize();
        m_running = false;
        return;
    }

    // ── Configure format: 48 kHz, float32, stereo ─────────
    WAVEFORMATEX fmt = {};
    fmt.wFormatTag      = WAVE_FORMAT_IEEE_FLOAT;
    fmt.nChannels       = 2;
    fmt.nSamplesPerSec  = 48000;
    fmt.wBitsPerSample  = 32;
    fmt.nBlockAlign     = fmt.nChannels * (fmt.wBitsPerSample / 8);
    fmt.nAvgBytesPerSec = fmt.nSamplesPerSec * fmt.nBlockAlign;

    // Try shared-mode with our preferred format
    hr = client->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
            AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
        0, 0, &fmt, nullptr
    );

    if (FAILED(hr)) {
        // Fallback: use the mix format
        WAVEFORMATEX* mixFmt = nullptr;
        client->GetMixFormat(&mixFmt);
        if (mixFmt) {
            hr = client->Initialize(
                AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM |
                    AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY,
                0, 0, mixFmt, nullptr
            );
            CoTaskMemFree(mixFmt);
        }
        if (FAILED(hr)) {
            client->Release();
            CoUninitialize();
            m_running = false;
            return;
        }
    }

    // ── Get capture client and start ──────────────────────
    IAudioCaptureClient* capture = nullptr;
    hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&capture);
    if (FAILED(hr)) {
        client->Release();
        CoUninitialize();
        m_running = false;
        return;
    }

    hr = client->Start();
    if (FAILED(hr)) {
        capture->Release();
        client->Release();
        CoUninitialize();
        m_running = false;
        return;
    }

    // ── Read loop ─────────────────────────────────────────
    // We read at ~10 ms intervals. Each packet is converted
    // from stereo float32 → mono float32, then sent to JS.
    std::vector<float> monoBuffer;
    monoBuffer.reserve(4800); // 100 ms at 48 kHz

    while (m_running) {
        Sleep(10);

        UINT32 packetLen = 0;
        while (m_running) {
            hr = capture->GetNextPacketSize(&packetLen);
            if (FAILED(hr) || packetLen == 0) break;

            BYTE*  data   = nullptr;
            UINT32 frames = 0;
            DWORD  flags  = 0;

            hr = capture->GetBuffer(&data, &frames, &flags, nullptr, nullptr);
            if (FAILED(hr)) break;

            if (!(flags & AUDCLNT_BUFFERFLAGS_SILENT) && data && frames > 0) {
                const float* fdata = reinterpret_cast<const float*>(data);
                monoBuffer.clear();

                // Mix stereo → mono
                for (UINT32 f = 0; f < frames; f++) {
                    float left  = fdata[f * 2];
                    float right = fdata[f * 2 + 1];
                    monoBuffer.push_back((left + right) * 0.5f);
                }

                // Deliver to JS
                std::lock_guard<std::mutex> lock(m_mutex);
                if (m_callback) {
                    m_callback(monoBuffer.data(), monoBuffer.size());
                }
            }

            capture->ReleaseBuffer(frames);
        }
    }

    // ── Teardown ──────────────────────────────────────────
    client->Stop();
    capture->Release();
    client->Release();
    CoUninitialize();
}

// ── Factory ───────────────────────────────────────────────
IAudioCapture* CreateAudioCapture() {
    return new WasapiCapture();
}

} // namespace haven

#endif // PLATFORM_WINDOWS
