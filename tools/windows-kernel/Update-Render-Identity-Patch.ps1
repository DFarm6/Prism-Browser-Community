[CmdletBinding()]
param(
    [Parameter()]
    [string]$BuildRoot = "C:\prism-chromium"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

. (Join-Path $PSScriptRoot "Kernel-Lock.ps1")
$KernelLock = Get-PrismKernelLock
$ExpectedPlatformCommit = $KernelLock.platforms.'windows-x64'.commit
$ExpectedFingerprintCommit = $KernelLock.fingerprint.commit
$ExpectedPatchHash = (Get-PrismKernelPatch $KernelLock "020-render-identity-v1.patch").sha256
$RepositoryPath = Join-Path $BuildRoot "ungoogled-chromium-windows"
$FingerprintPath = Join-Path $RepositoryPath "ungoogled-chromium"
$SourcePath = Join-Path $RepositoryPath "build\src"
$BuildNinja = Join-Path $SourcePath "out\Default\build.ninja"
$PatchPath = Join-Path $PSScriptRoot "patches\020-render-identity-v1.patch"
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Get-NormalizedSourceText {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path
    )
    return [System.IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
}

function Add-PrismSourceTextAfter {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Marker,
        [Parameter(Mandatory = $true)]
        [string]$Anchor,
        [Parameter(Mandatory = $true)]
        [string]$Text
    )
    $source = Get-NormalizedSourceText $Path
    if ($source.Contains($Marker)) {
        return
    }
    $anchorIndex = $source.IndexOf($Anchor, [StringComparison]::Ordinal)
    if ($anchorIndex -lt 0 -or
        $source.IndexOf($Anchor, $anchorIndex + $Anchor.Length, [StringComparison]::Ordinal) -ge 0) {
        throw "Could not locate one unique render identity anchor in $Path`: $Anchor"
    }
    $updated = $source.Insert($anchorIndex + $Anchor.Length, $Text)
    [System.IO.File]::WriteAllText($Path, $updated, $Utf8NoBom)
}

function Add-PrismSourceTextBefore {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Marker,
        [Parameter(Mandatory = $true)]
        [string]$Anchor,
        [Parameter(Mandatory = $true)]
        [string]$Text
    )
    $source = Get-NormalizedSourceText $Path
    if ($source.Contains($Marker)) {
        return
    }
    $anchorIndex = $source.IndexOf($Anchor, [StringComparison]::Ordinal)
    if ($anchorIndex -lt 0 -or
        $source.IndexOf($Anchor, $anchorIndex + $Anchor.Length, [StringComparison]::Ordinal) -ge 0) {
        throw "Could not locate one unique render identity anchor in $Path`: $Anchor"
    }
    $updated = $source.Insert($anchorIndex, $Text)
    [System.IO.File]::WriteAllText($Path, $updated, $Utf8NoBom)
}

if (-not (Test-Path $PatchPath)) {
    throw "Prism render identity patch is missing: $PatchPath"
}
$patchHash = (Get-FileHash -Algorithm SHA256 -Path $PatchPath).Hash.ToLowerInvariant()
if ($patchHash -ne $ExpectedPatchHash) {
    throw "Unexpected Prism render identity patch hash: $patchHash"
}

if (-not (Test-Path (Join-Path $RepositoryPath ".git")) -or
    -not (Test-Path (Join-Path $FingerprintPath ".git"))) {
    throw "The prepared Chromium repositories were not found under $BuildRoot."
}
$platformCommit = (& git.exe -C $RepositoryPath rev-parse HEAD) -join ""
$fingerprintCommit = (& git.exe -C $FingerprintPath rev-parse HEAD) -join ""
if ($LASTEXITCODE -ne 0 -or
    $platformCommit -ne $ExpectedPlatformCommit -or
    $fingerprintCommit -ne $ExpectedFingerprintCommit) {
    throw "The prepared source does not match the pinned Prism Chromium 144 build."
}

$activeNinja = @(Get-CimInstance Win32_Process -Filter "Name = 'ninja.exe'" | Where-Object {
    $_.CommandLine -and $_.CommandLine.IndexOf($BuildRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
})
if ($activeNinja.Count -gt 0) {
    throw "The Chromium build is still running. Wait for it to finish before applying the render identity patch."
}

$fingerprintPatchDirectory = Join-Path $FingerprintPath "patches\extra\fingerprint"
if (-not (Test-Path $fingerprintPatchDirectory)) {
    throw "The fingerprint patch directory is missing. Run Prepare-Source.ps1 from the latest build kit."
}
$fingerprintPatchDestination = Join-Path $fingerprintPatchDirectory "020-render-identity-v1.patch"
Copy-Item -Path $PatchPath -Destination $fingerprintPatchDestination -Force

$seriesPath = Join-Path $FingerprintPath "patches\series"
$geolocationSeriesEntry = "extra/fingerprint/019-proxy-geolocation.patch"
if ((Get-Content $seriesPath) -notcontains $geolocationSeriesEntry) {
    throw "The existing source does not include the Prism network patch. Run Update-Network-Patch.ps1 first."
}
Set-PrismKernelPatchSeries $KernelLock $seriesPath

$renderIdentitySource = Join-Path $SourcePath "components\ungoogled\ungoogled_switches.cc"
if (-not (Test-Path $renderIdentitySource)) {
    throw "The Chromium source tree is incomplete: $renderIdentitySource"
}
$speechSource = Join-Path $SourcePath "third_party\blink\renderer\modules\speech\speech_synthesis.cc"
$fontSource = Join-Path $SourcePath "third_party\blink\renderer\platform\fonts\font_cache.cc"
$audioSource = Join-Path $SourcePath "third_party\blink\renderer\modules\webaudio\offline_audio_context.cc"
$webglSource = Join-Path $SourcePath "third_party\blink\renderer\modules\webgl\webgl_rendering_context_base.cc"
$commonMarkers = @(
    @($renderIdentitySource, "fingerprint-render-identity"),
    @($renderIdentitySource, "fingerprint-language"),
    @($speechSource, "ShouldExposeVoiceForRenderIdentity")
)
$commonMarkerCount = @($commonMarkers | Where-Object {
    (Test-Path $_[0]) -and (Select-String -Path $_[0] -Pattern $_[1] -SimpleMatch -Quiet)
}).Count
if ($commonMarkerCount -ne 0 -and $commonMarkerCount -ne $commonMarkers.Count) {
    throw "The common render identity patch is only partially applied. Restore the affected source files before retrying."
}
if ($commonMarkerCount -eq 0) {
    $platformSpecificFiles = @(
        "third_party/blink/renderer/platform/fonts/font_cache.cc",
        "third_party/blink/renderer/modules/webaudio/offline_audio_context.cc",
        "third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc"
    )
    $excludeArguments = @($platformSpecificFiles | ForEach-Object { "--exclude=$_" })
    Push-Location $SourcePath
    try {
        & git.exe apply --check --whitespace=nowarn @excludeArguments $PatchPath
        if ($LASTEXITCODE -ne 0) {
            throw "The common render identity patch does not apply cleanly to the current Chromium source."
        }
        & git.exe apply --whitespace=nowarn @excludeArguments $PatchPath
        if ($LASTEXITCODE -ne 0) {
            throw "Could not apply the common render identity patch."
        }
    } finally {
        Pop-Location
    }
}

Add-PrismSourceTextAfter $fontSource "#include <initializer_list>" `
    '#include "third_party/blink/renderer/platform/fonts/font_cache.h"' `
    "`n`n#include <initializer_list>"
Add-PrismSourceTextAfter $fontSource 'base/strings/string_util.h' `
    '#include "base/strings/string_number_conversions.h"' `
    "`n#include `"base/strings/string_util.h`""
$fontHelper = @'
static bool IsLocaleSpecificFontHidden(
    const base::CommandLine& command_line,
    const std::string& requested_family) {
  if (command_line.GetSwitchValueASCII(
          switches::kFingerprintRenderIdentity) != "v1") {
    return false;
  }

  std::string language =
      base::ToLowerASCII(command_line.GetSwitchValueASCII(
          switches::kFingerprintLanguage));
  const size_t separator = language.find_first_of("-_");
  if (separator != std::string::npos) {
    language.resize(separator);
  }
  const std::string family = base::ToLowerASCII(requested_family);
  const auto contains_any = [&family](
                                std::initializer_list<const char*> values) {
    for (const char* value : values) {
      if (family.find(value) != std::string::npos) {
        return true;
      }
    }
    return false;
  };

  const bool chinese = contains_any({
      "microsoft yahei", "microsoft jhenghei", "simsun", "mingliu",
      "pingfang", "heiti", "kaiti", "songti"});
  const bool japanese = contains_any({
      "yu gothic", "yugothic", "yu mincho", "yumincho", "ms gothic",
      "meiryo", "hiragino", "osaka"});
  const bool korean = contains_any({
      "malgun gothic", "apple sd gothic neo", "nanum"});

  if (language == "zh") {
    return japanese || korean;
  }
  if (language == "ja") {
    return chinese || korean;
  }
  if (language == "ko") {
    return chinese || japanese;
  }
  return chinese || japanese || korean;
}


'@
Add-PrismSourceTextBefore $fontSource "IsLocaleSpecificFontHidden(" `
    "const FontPlatformData* FontCache::GetFontPlatformData(" $fontHelper
$fontCall = @'

  if (creation_params.CreationType() == kCreateFontByFamily &&
      alternate_font_name != AlternateFontName::kLastResort &&
      IsLocaleSpecificFontHidden(
          *command_line, creation_params.Family().Utf8())) {
    return nullptr;
  }
'@
Add-PrismSourceTextAfter $fontSource "IsLocaleSpecificFontHidden(`n          *command_line" `
    "  const base::CommandLine* command_line = base::CommandLine::ForCurrentProcess();" $fontCall

Add-PrismSourceTextAfter $audioSource "#include <algorithm>" `
    '#include "third_party/blink/renderer/modules/webaudio/offline_audio_context.h"' `
    "`n`n#include <algorithm>"
Add-PrismSourceTextAfter $audioSource "#include <cmath>" `
    "#include <algorithm>" "`n#include <cmath>"
Add-PrismSourceTextAfter $audioSource 'base/command_line.h' `
    "#include <cmath>" "`n`n#include `"base/command_line.h`""
Add-PrismSourceTextAfter $audioSource 'base/strings/string_number_conversions.h' `
    '#include "base/command_line.h"' `
    "`n#include `"base/strings/string_number_conversions.h`""
Add-PrismSourceTextAfter $audioSource 'components/ungoogled/ungoogled_switches.h' `
    '#include "base/strings/string_number_conversions.h"' `
    "`n#include `"components/ungoogled/ungoogled_switches.h`""
$audioHelper = @'
namespace {

uint32_t NextRenderIdentityState(uint32_t state) {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state;
}

void ApplyRenderIdentityToAudioBuffer(AudioBuffer* buffer) {
  const base::CommandLine* command_line =
      base::CommandLine::ForCurrentProcess();
  if (command_line->GetSwitchValueASCII(
          switches::kFingerprintRenderIdentity) != "v1") {
    return;
  }
  uint32_t fingerprint = 0;
  if (!base::StringToUint(
          command_line->GetSwitchValueASCII(switches::kFingerprint),
          &fingerprint)) {
    return;
  }

  for (unsigned channel = 0; channel < buffer->numberOfChannels(); ++channel) {
    NotShared<DOMFloat32Array> channel_data = buffer->getChannelData(channel);
    if (!channel_data || channel_data->length() == 0) {
      continue;
    }
    uint32_t state = fingerprint ^ (0x9e3779b9u * (channel + 1)) ^
                     channel_data->length();
    const uint32_t stride = 89u + (state % 29u);
    for (uint32_t index = 23u + (state % 53u);
         index < channel_data->length(); index += stride) {
      state = NextRenderIdentityState(state);
      float& sample = channel_data->Data()[index];
      if (!std::isfinite(sample) || std::abs(sample) < 1.0e-8f) {
        continue;
      }
      const float magnitude =
          static_cast<float>(1u + ((state >> 1) % 3u)) * 1.0e-7f;
      const float delta = (state & 1u) ? magnitude : -magnitude;
      sample = std::clamp(sample + delta, -1.0f, 1.0f);
    }
  }
}

}  // namespace

'@
Add-PrismSourceTextAfter $audioSource "ApplyRenderIdentityToAudioBuffer(" `
    "namespace blink {`n" "`n$audioHelper"
Add-PrismSourceTextBefore $audioSource "    ApplyRenderIdentityToAudioBuffer(rendered_buffer);" `
    "    // Call the offline rendering completion event listener and resolve the`n" `
    "    ApplyRenderIdentityToAudioBuffer(rendered_buffer);`n`n"

Add-PrismSourceTextAfter $webglSource 'base/command_line.h' `
    '#include "base/bit_cast.h"' "`n#include `"base/command_line.h`""
Add-PrismSourceTextAfter $webglSource 'base/strings/string_number_conversions.h' `
    '#include "base/task/single_thread_task_runner.h"' `
    "`n#include `"base/strings/string_number_conversions.h`""
Add-PrismSourceTextAfter $webglSource 'components/ungoogled/ungoogled_switches.h' `
    '#include "build/build_config.h"' `
    "`n#include `"components/ungoogled/ungoogled_switches.h`""
$webglHelper = @'
namespace {

uint32_t NextWebGLRenderIdentityState(uint32_t state) {
  state ^= state << 13;
  state ^= state >> 17;
  state ^= state << 5;
  return state;
}

void ApplyRenderIdentityToWebGLPixels(void* data,
                                      GLsizei width,
                                      GLsizei height,
                                      GLenum format,
                                      GLenum type) {
  if (!data || width <= 0 || height <= 0 || type != GL_UNSIGNED_BYTE ||
      (format != GL_RGB && format != GL_RGBA)) {
    return;
  }
  const base::CommandLine* command_line =
      base::CommandLine::ForCurrentProcess();
  if (command_line->GetSwitchValueASCII(
          switches::kFingerprintRenderIdentity) != "v1") {
    return;
  }
  uint32_t fingerprint = 0;
  if (!base::StringToUint(
          command_line->GetSwitchValueASCII(switches::kFingerprint),
          &fingerprint)) {
    return;
  }

  const uint32_t gpu_count =
      command_line->GetSwitchValueASCII(switches::kFingerprintPlatform) ==
              "macos"
          ? 11u
          : 57u;
  uint32_t state = (fingerprint % gpu_count) ^ 0x85ebca6bu ^
                   static_cast<uint32_t>(width) ^
                   (static_cast<uint32_t>(height) << 16);
  const size_t channels = format == GL_RGBA ? 4u : 3u;
  const size_t byte_count =
      static_cast<size_t>(width) * static_cast<size_t>(height) * channels;
  uint8_t* bytes = static_cast<uint8_t*>(data);
  const size_t stride = 193u + (state % 67u);
  for (size_t index = state % stride; index < byte_count; index += stride) {
    state = NextWebGLRenderIdentityState(state);
    const size_t channel = index % channels;
    if (channel == 3u) {
      continue;
    }
    bytes[index] = static_cast<uint8_t>(
        (bytes[index] & 0xfeu) | ((state >> channel) & 1u));
  }
}

}  // namespace

'@
Add-PrismSourceTextAfter $webglSource "ApplyRenderIdentityToWebGLPixels(" `
    "namespace blink {`n" "`n$webglHelper"
Add-PrismSourceTextAfter $webglSource "    ApplyRenderIdentityToWebGLPixels(data, width, height, format, type);" `
    "    ContextGL()->ReadPixels(x, y, width, height, format, type, data);" `
    "`n    ApplyRenderIdentityToWebGLPixels(data, width, height, format, type);"

$markers = @(
    @($renderIdentitySource, "fingerprint-render-identity"),
    @($renderIdentitySource, "fingerprint-language"),
    @($speechSource, "ShouldExposeVoiceForRenderIdentity"),
    @($fontSource, "IsLocaleSpecificFontHidden"),
    @($audioSource, "ApplyRenderIdentityToAudioBuffer"),
    @($webglSource, "ApplyRenderIdentityToWebGLPixels")
)
foreach ($marker in $markers) {
    if (-not (Test-Path $marker[0]) -or
        -not (Select-String -Path $marker[0] -Pattern $marker[1] -SimpleMatch -Quiet)) {
        throw "The render identity patch verification failed at $($marker[0])."
    }
}

$lockPath = Join-Path $RepositoryPath "prism-build-lock.json"
if (-not (Test-Path $lockPath)) {
    throw "The Prism build lock is missing. Do not rebuild until the prepared source has been inspected."
}
$lock = Get-Content $lockPath -Raw | ConvertFrom-Json
$lock | Add-Member -NotePropertyName schemaVersion -NotePropertyValue 5 -Force
$lock | Add-Member -NotePropertyName contractSha256 -NotePropertyValue ((Get-FileHash -Algorithm SHA256 -Path $script:PrismKernelLockPath).Hash.ToLowerInvariant()) -Force
$lock | Add-Member -NotePropertyName prismRenderIdentityPatchSha256 -NotePropertyValue $patchHash -Force
$lock | Add-Member -NotePropertyName renderIdentityPatchUpdatedAtUtc -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
$lock | ConvertTo-Json -Depth 6 | Set-Content -Path $lockPath -Encoding utf8

Write-Host "Prism render identity v1 patch is ready." -ForegroundColor Green
if (Test-Path $BuildNinja) {
    Write-Host "Run Build-Kernel.ps1 again; Ninja will perform an incremental rebuild."
} else {
    Write-Host "Run Build-Kernel.ps1; the patch will be included in the first full build."
}
