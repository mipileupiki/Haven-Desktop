// ═══════════════════════════════════════════════════════════
// Haven Desktop — Cross-platform Audio Capture Interface
// ═══════════════════════════════════════════════════════════
#pragma once

#include <string>
#include <vector>
#include <functional>
#include <cstdint>

namespace haven {

// Represents an application currently producing audio
struct AudioApp {
    uint32_t    pid;
    std::string name;
    std::string icon;   // base64 data-URL, or empty
};

// Callback: receives mono float32 PCM samples at 48 kHz
//   data       – pointer to sample buffer
//   frameCount – number of samples
using AudioDataCb = std::function<void(const float* data, size_t frameCount)>;

// Abstract per-platform audio capture
class IAudioCapture {
public:
    virtual ~IAudioCapture() = default;

    virtual bool                  IsSupported()          const = 0;
    virtual std::vector<AudioApp> GetAudioApplications()       = 0;
    virtual bool                  StartCapture(uint32_t pid, AudioDataCb cb) = 0;
    virtual void                  StopCapture()                = 0;
    virtual void                  Cleanup()                    = 0;
};

// Factory — returns the right implementation per OS
IAudioCapture* CreateAudioCapture();

} // namespace haven
