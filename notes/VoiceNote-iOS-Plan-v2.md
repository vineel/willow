# VoiceNote iOS App — Implementation Plan v2

## Purpose

A personal iPhone app that records voice instructions for the Willow personal agent system,
transcribes them on-device via WhisperKit, posts the transcript to a Slack channel where
Willow's Claude Code agent picks them up and executes them. Recordings are stored locally
as a personal log with playback.

**Target device:** iPhone 15 Pro (Action Button required for button trigger)
**iOS minimum:** iOS 16.0
**Language:** Swift
**UI framework:** SwiftUI
**Architecture:** Single-target, no backend, no Dropbox

---

## User Flow

```
[List Screen]
  → FAB tap OR Action Button press
    → [Recording Screen]
        → scrolling waveform + duration + red indicator
        → Action Button press OR tap stop button
          → [Transcription Screen]
              → WhisperKit streams transcript text
              → Slack spinner
              → auto-navigate back to [List Screen]
                  → new row appears at top
```

---

## Screen 1: List Screen

**Layout:**
```
┌─────────────────────────────┐
│  VoiceNote              ⚙️  │  ← nav bar, gear → Settings sheet
├─────────────────────────────┤
│ ┌─────────────────────────┐ │
│ │ ▶  Today 2:32pm     ✓  │ │  ← sent checkmark
│ │ "Add a todo to follow   │ │
│ │  up with Brad about..." │ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ ▶  Today 11:14am    ✓  │ │
│ │ "Remember: the Accord..│ │
│ └─────────────────────────┘ │
│ ┌─────────────────────────┐ │
│ │ ▶  Yesterday 4:05pm ⟳  │ │  ← retry spinner (failed send)
│ │ "Schedule a call with..│ │
│ └─────────────────────────┘ │
│                             │
│              ●              │  ← FAB (red circle, bottom center)
└─────────────────────────────┘
```

**Row anatomy:**
- Play button (▶) — tapping starts inline playback via `AVAudioPlayer`; tapping again pauses
- Timestamp — relative ("Today 2:32pm", "Yesterday", date for older)
- Transcript — 2-line truncated, full text accessible by tapping row
- Status icon — ✓ sent, ⟳ retry pending, ✗ failed (tap to retry)

**Interactions:**
- Tap row → expand to show full transcript (no separate detail screen needed)
- Swipe left → Delete — removes SwiftData record and deletes m4a from disk
- Tap FAB → navigate to Recording screen
- Action Button → navigate to Recording screen (same as FAB)
- Tap ⚙️ → Settings sheet

**Empty state:**
Simple centered message: "No recordings yet. Press the button or use the Action Button to start."

---

## Screen 2: Recording Screen

**Layout:**
```
┌─────────────────────────────┐
│          ← Back             │  ← back button (cancels recording)
│                             │
│                             │
│  ████████████████████████   │
│  ▁▂▄▆█▇▅▃▂▁▂▄▇█▆▄▂▁▂▄▆█   │  ← scrolling waveform
│  ████████████████████████   │
│                             │
│         ● REC  00:42        │  ← pulsing red dot + duration
│                             │
│          [  ■  ]            │  ← stop button (tap to stop)
│                             │
└─────────────────────────────┘
```

**Waveform:**
- Draws left-to-right like Apple Voice Memos — new amplitude bars are appended at the right edge, older bars scroll left
- Bars sampled from `AVAudioEngine` input node tap — compute RMS amplitude per buffer (~10 samples/sec)
- Implement as a custom SwiftUI `Canvas` view, storing a rolling array of amplitude floats (keep last ~200 values)
- Color: white bars on dark background (or system accent)
- Height: proportional to amplitude, with a minimum height so silence isn't invisible

**Duration counter:**
- Format: `MM:SS` — updates every second via a `Timer`

**Red REC indicator:**
- Pulsing opacity animation (1.0 → 0.3 → 1.0, 1.5s loop) via `withAnimation(.easeInOut(duration: 0.75).repeatForever())`

**Stop trigger:**
- Tap stop button in UI, OR
- Action Button press (via `voicenote://toggle` URL scheme — same handler as start)

**Back / Cancel:**
- Tapping back while recording → confirm dialog ("Discard this recording?") → if confirmed, stop engine, delete temp file, pop to list

**Auto-start:**
Recording begins immediately when this screen appears (`.onAppear`). No tap-to-start on this screen.

---

## Screen 3: Transcription + Send Screen

**Layout:**
```
┌─────────────────────────────┐
│         Transcribing...     │  ← or "Sending..." or "Done"
│                             │
│  ┌───────────────────────┐  │
│  │ "Add a todo to follow │  │
│  │ up with Brad about    │  │
│  │ the term sheet..."    │  │  ← transcript streams in here
│  │ ▌                     │  │  ← blinking cursor while streaming
│  └───────────────────────┘  │
│                             │
│    [════════════   ]  42%   │  ← WhisperKit progress (if available)
│                             │
│         ⟳  Sending...      │  ← replaces progress bar after transcription
│                             │
└─────────────────────────────┘
```

**States in order:**
1. **Transcribing** — WhisperKit runs, text streams into the text area word by word. Progress bar if WhisperKit exposes completion percentage; otherwise indeterminate spinner.
2. **Sending** — transcription complete, progress bar replaced by Slack spinner ("Sending to Willow...")
3. **Sent** — brief "✓ Sent" confirmation (0.75s), then auto-navigate to List screen

**No user interaction on this screen** — it is purely status display. No cancel, no edit (v1). The back gesture is disabled while this screen is active.

**On failure:**
- Transcription failure → alert with "Retry" and "Discard" options
- Slack POST failure → navigate to List, row appears with ✗ status and retry affordance

**WhisperKit streaming:**
WhisperKit's `transcribe(audioPath:)` with a result callback provides progressive segments. Append each segment to a `@Published var transcript: String` on the view model, which the text view observes. This gives the streaming-text effect without extra complexity.

---

## Data Model (SwiftData)

**File:** `Recording.swift`

```swift
@Model
class Recording {
    var id: UUID
    var createdAt: Date
    var duration: TimeInterval
    var transcript: String
    var audioFilename: String          // filename only, not full path
    var status: RecordingStatus
    var slackTimestamp: String?        // ts field from Slack API response

    enum RecordingStatus: String, Codable {
        case recording
        case transcribing
        case sending
        case sent
        case failed
    }

    // Computed
    var audioFileURL: URL {
        // Documents/recordings/<audioFilename>
    }
}
```

List query: `@Query(sort: \Recording.createdAt, order: .reverse) var recordings: [Recording]`

Swipe-to-delete: `modelContext.delete(recording)` + `FileManager.default.removeItem(at: recording.audioFileURL)`

---

## Module Breakdown

### Module 1: URL Scheme + Navigation

**File:** `VoiceNoteApp.swift`

- Register `voicenote://` URL scheme in Info.plist
- `.onOpenURL` handler calls `NavigationRouter.shared.triggerRecord()`
- `NavigationRouter` is an `ObservableObject` with `@Published var shouldRecord = false`
- Root `ContentView` observes this and pushes `RecordingView` onto the navigation stack when true
- Also handles cold launch: check `launchOptions` for URL, set `shouldRecord = true` before first render

### Module 2: Audio Recording

**File:** `RecordingManager.swift` (ObservableObject, singleton)

- `AVAudioEngine` + input node tap
- Output: m4a file in `Documents/recordings/` with AAC codec, 44.1kHz, mono
- Publishes `@Published var amplitudeSamples: [Float]` — rolling array for waveform
- Publishes `@Published var duration: TimeInterval` — updated by 1s Timer
- `func startRecording() -> Recording` — creates SwiftData record, starts engine
- `func stopRecording() -> URL` — stops engine, returns file URL

**AVAudioFile settings:**
```swift
[
    AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
    AVSampleRateKey: 44100.0,
    AVNumberOfChannelsKey: 1,
    AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
]
```

**Amplitude sampling:**
In the input node tap closure, compute RMS of each buffer:
```swift
let rms = sqrt(buffer.floatChannelData![0][0..<frameCount]
    .map { $0 * $0 }.reduce(0, +) / Float(frameCount))
amplitudeSamples.append(rms)
if amplitudeSamples.count > 300 { amplitudeSamples.removeFirst() }
```

### Module 3: Waveform View

**File:** `WaveformView.swift`

Custom SwiftUI `Canvas`-based view.

```swift
struct WaveformView: View {
    let samples: [Float]        // from RecordingManager
    let barWidth: CGFloat = 3
    let barSpacing: CGFloat = 2

    var body: some View {
        Canvas { context, size in
            // draw bars right-to-left from samples array
            // newest sample at rightmost position
            // bar height proportional to amplitude, min 4pt
        }
    }
}
```

### Module 4: WhisperKit Transcription

**File:** `Transcriber.swift`

Add WhisperKit via Swift Package Manager:
`https://github.com/argmaxinc/whisperkit` — select `WhisperKit` product only.

```swift
import WhisperKit

class Transcriber: ObservableObject {
    @Published var transcript: String = ""
    @Published var progress: Float = 0

    private var whisperKit: WhisperKit?

    func prepare() async throws {
        // Called once at app launch — loads model into memory
        whisperKit = try await WhisperKit()  // downloads model on first run
    }

    func transcribe(fileURL: URL) async throws {
        guard let whisperKit else { return }
        let results = try await whisperKit.transcribe(
            audioPath: fileURL.path,
            progressCallback: { progress in
                Task { @MainActor in self.progress = progress }
            }
        )
        // Results arrive as segments — append to transcript progressively
        for segment in results {
            await MainActor.run {
                transcript += segment.text
            }
        }
    }
}
```

**Model download:** Happens once, on first `WhisperKit()` init. Show a one-time "Downloading transcription model..." screen on first launch. Model is cached in app's Application Support directory.

**First launch flow (one-time only):**
```
App opens → detect no model cached → show download progress screen
  → model downloads (~few hundred MB depending on variant selected)
  → proceed to List screen
```

### Module 5: Slack Integration

**File:** `SlackPoster.swift`

```swift
class SlackPoster {
    private let token: String       // from Keychain
    private let channelId: String   // from Keychain

    func post(transcript: String, recordingId: UUID) async throws -> String {
        var request = URLRequest(url: URL(string: "https://slack.com/api/chat.postMessage")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "channel": channelId,
            "text": "🎙️ \(transcript)",
            "username": "VoiceNote"
        ]
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        // parse response, extract ts (Slack message timestamp)
        // return ts for storage in Recording.slackTimestamp
    }
}
```

Token and channel ID both stored in Keychain, entered once via Settings sheet.

**No background URLSession needed** — the Transcription screen is active and foregrounded during the entire send operation. A regular `URLSession.shared` is sufficient.

### Module 6: Keychain Helper

**File:** `KeychainHelper.swift`

Simple wrapper (same as v1 plan):
- `save(key:value:)`
- `read(key:) -> String?`
- `delete(key:)`

Keys:
- `"slack_bot_token"`
- `"slack_channel_id"`

### Module 7: Settings Sheet

**File:** `SettingsView.swift`

Presented as `.sheet` from the ⚙️ button.

Fields:
- Slack Bot Token (secure field)
- Slack Channel ID
- Save button → writes both to Keychain
- Status: "Configured ✓" or "Not configured" per field
- Section: "Model" — shows which WhisperKit model is loaded, "Re-download" button

### Module 8: Playback

**File:** Inline in list row view, or `PlaybackManager.swift` if shared state is needed.

- `AVAudioPlayer` initialized with the recording's file URL
- Only one recording plays at a time — stopping the previous when a new one starts
- Play/pause toggle on the ▶ button in each row

### Module 9: AppIntent (Action Button)

**File:** `VoiceNoteShortcuts.swift`

```swift
import AppIntents

struct ToggleRecordingIntent: AppIntent {
    static var title: LocalizedStringResource = "Record Voice Note"
    static var openAppWhenRun: Bool = true

    func perform() async throws -> some IntentResult {
        return .result()
    }
}
```

The intent opens the app; `NavigationRouter` handles pushing the Recording screen.

---

## File Structure

```
VoiceNote/
├── VoiceNoteApp.swift              # @main, URL scheme, onOpenURL
├── NavigationRouter.swift          # ObservableObject, triggerRecord()
├── ContentView.swift               # Root: NavigationStack + List screen
│
├── Screens/
│   ├── ListScreen.swift            # Recording list, FAB, swipe-to-delete
│   ├── RecordingScreen.swift       # Waveform, duration, stop button
│   ├── TranscriptionScreen.swift   # Streaming text, progress, send spinner
│   └── SettingsView.swift          # Token/channel config, model status
│
├── Components/
│   └── WaveformView.swift          # Canvas-based scrolling waveform
│
├── Services/
│   ├── RecordingManager.swift      # AVAudioEngine, amplitude sampling
│   ├── Transcriber.swift           # WhisperKit wrapper
│   ├── SlackPoster.swift           # chat.postMessage
│   ├── PlaybackManager.swift       # AVAudioPlayer, one-at-a-time
│   └── KeychainHelper.swift        # Keychain read/write
│
├── Model/
│   └── Recording.swift             # SwiftData model + RecordingStatus enum
│
└── VoiceNoteShortcuts.swift        # AppIntent for Action Button
```

---

## Info.plist Entries

```xml
<key>NSMicrophoneUsageDescription</key>
<string>VoiceNote records your voice to send instructions to Willow.</string>

<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLSchemes</key>
    <array><string>voicenote</string></array>
  </dict>
</array>

<key>UIBackgroundModes</key>
<array>
  <string>audio</string>
</array>
```

---

## Suggested Build Order

1. **SwiftData model + List screen** — static mock data, swipe-to-delete wired up
2. **Recording screen** — `AVAudioEngine` → m4a file, duration counter, no waveform yet
3. **Waveform view** — plug amplitude samples from step 2 into the Canvas view
4. **URL scheme + NavigationRouter** — Action Button and FAB both push Recording screen
5. **WhisperKit integration** — model download on first launch, transcription screen with streaming text
6. **Keychain + Settings sheet** — token and channel ID entry
7. **Slack POST** — wire up `SlackPoster`, test with a real channel
8. **Playback** — `AVAudioPlayer` on list rows
9. **AppIntent** — Action Button assignment in Settings
10. **Polish** — empty state, failure states, retry on failed rows

---

## Willow Side

**No new Willow infrastructure needed.** The transcript arrives in the Slack channel exactly like any other user message. The Claude Code agent in the `willow-agent` tmux session sees it and executes it using its existing MCP tools (`willow-todo`, `willow-calendar`, `willow-memory`, etc.).

The only Willow-side consideration: the message will arrive prefixed with 🎙️ to distinguish it from typed messages. If you want the agent to handle voice messages differently (e.g., always acknowledge with a Slack reply), that's a CLAUDE.md instruction, not a code change.

---

## Out of Scope (v1)

- Edit transcript before sending
- Multiple Slack channels / routing by content
- iCloud backup of recordings
- Willow-initiated push notifications back to phone
- Widget or lock screen shortcut
- iPad support
