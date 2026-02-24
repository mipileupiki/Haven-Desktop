// ═══════════════════════════════════════════════════════════
// Haven Desktop — Linux PulseAudio Per-App Audio Capture
//
// Isolates audio from a single application by:
//   1) Creating a virtual null sink
//   2) Moving the target app's playback stream to it
//   3) Recording from the null sink's monitor source
//   4) Also connecting the null sink back to the real output
//      so the user still hears the application
//
// Works on PulseAudio and PipeWire (via pipewire-pulse compat)
// ═══════════════════════════════════════════════════════════
#pragma once
#ifdef PLATFORM_LINUX

#include "../audio_capture.h"
#include <thread>
#include <atomic>
#include <mutex>

namespace haven {

class PulseCapture : public IAudioCapture {
public:
    PulseCapture();
    ~PulseCapture() override;

    bool                  IsSupported()          const override;
    std::vector<AudioApp> GetAudioApplications()       override;
    bool                  StartCapture(uint32_t pid, AudioDataCb cb) override;
    void                  StopCapture()                override;
    void                  Cleanup()                    override;

private:
    void captureLoop();

    std::atomic<bool> m_running{false};
    std::thread       m_thread;
    AudioDataCb       m_callback;
    uint32_t          m_targetPid = 0;
    std::mutex        m_mutex;
    uint32_t          m_nullSinkModule = 0;  // PulseAudio module index
    uint32_t          m_loopbackModule = 0;  // loopback module index
};

} // namespace haven

#endif // PLATFORM_LINUX
