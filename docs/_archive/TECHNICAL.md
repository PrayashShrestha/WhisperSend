# Technical Summary - Speechmatics Extension

## Architecture

### Core Components

**1. transcription-handler.js** (NEW)

- Runs in ChatGPT tab content script
- Handles Speechmatics WebSocket connection
- Captures microphone audio via MediaRecorder
- Processes transcription messages
- Manages recording lifecycle

**2. chatgpt.js** (UPDATED)

- Integrates with ChatGPT DOM
- Finds and manipulates textarea
- Handles text insertion (respects append mode)
- Deletes text on Escape key press
- Shows visual feedback (mic indicator, notifications)

**3. background.js** (UPDATED)

- Service worker for extension
- Added new settings defaults
- Routes messages between content scripts
- Manages settings persistence

**4. popup.html & popup.js** (UPDATED)

- Settings UI with 5 main sections
- API key management with validation
- Mode selection (Timer/Manual)
- Configurable delays and preferences
- Keyboard shortcut info

**5. manifest.json** (UPDATED)

- Added transcription-handler.js to ChatGPT content scripts
- Changed content script run_at to "document_start"
- WebSocket is handled naturally by browser

---

## Key Technical Decisions

### Why WebSocket Instead of REST?

- **Real-time streaming**: WebSocket provides continuous connection
- **Lower latency**: Messages arrive as they're generated
- **Efficient**: No polling required
- **Speechmatics native**: Official API for browser use

### Why MediaRecorder?

- **Built-in**: No external dependencies needed
- **Flexible**: Supports multiple audio formats
- **Event-driven**: ondataavailable fires on intervals
- **Native WebM codec**: Works across modern browsers

### Why chrome.storage.sync?

- **Cross-device sync**: Settings sync across user's Chrome devices
- **Encrypted**: Browser handles encryption automatically
- **Simple API**: No server needed
- **User control**: User can delete data anytime

### Why Spacebar?

- **Hands-free**: Works while typing
- **Intuitive**: Hold = record, release = submit
- **Familiar**: Common pattern in voice applications
- **Easy to prevent**: Can prevent default spacebar behavior in ChatGPT

### Why Escape for Delete?

- **Standard**: Common "undo" or "cancel" key
- **Non-intrusive**: Doesn't interfere with normal typing
- **Discoverable**: Listed in settings
- **Reversible**: Just press spacebar again if needed

---

## Data Flow Diagrams

### Initialization Flow

```
Extension Load
    ↓
manifest.json loads content scripts
    ↓
transcription-handler.js (ChatGPT tab)
    - Loads settings from chrome.storage.sync
    - Sets up keyboard listeners (spacebar, escape)
    - Creates mic indicator
    ↓
chatgpt.js
    - Loads settings
    - Listens for messages from transcription-handler
    - Creates mic status indicator
    - Sets up escape key listener
    ↓
Ready for recording
```

### Recording Session Flow

```
User holds SPACEBAR
    ↓
keydown event (Space code)
    ↓
transcription-handler.js:startRecording()
    ↓
1. Load settings
2. Request microphone access (getUserMedia)
3. Create AudioContext (16kHz)
4. Connect to Speechmatics WebSocket:
   - URL: wss://eu.rt.speechmatics.com/v2?auth_token={apiKey}
   - Send StartRecognition message with language/config
5. Create MediaRecorder for audio capture
6. Start recording
7. Notify chatgpt.js: micStatus(true)
    ↓
chatgpt.js:updateMicStatus(true)
    ↓
Mic indicator turns RED 🔴

---

User speaks into microphone
    ↓
MediaRecorder:ondataavailable
    ↓
Convert audio blob to ArrayBuffer
    ↓
Send binary audio to WebSocket (100ms chunks)
    ↓
Speechmatics processes audio
    ↓
Sends back AddPartialTranscript (real-time text)
    ↓
transcription-handler.js:handlePartialTranscript()
    ↓
Notify chatgpt.js: updateTranscription(text, isPartial=true)
    ↓
chatgpt.js:handlePartialTranscription()
    ↓
(Optional: Show live preview)

---

User stops speaking for 500ms
    ↓
Speechmatics sends EndOfUtterance message
    ↓
transcription-handler.js:handleEndOfUtterance()
    ↓
If Timer Mode:
    - Start silenceTimeout (default 2 seconds)
    - After 2 seconds → stopRecording()
    ↓
If Manual Mode:
    - Wait for user to release spacebar

---

User releases SPACEBAR (or timer expires)
    ↓
keyup event (Space code) OR silenceTimeout
    ↓
transcription-handler.js:stopRecording()
    ↓
1. Stop MediaRecorder
2. Clear any pending timeouts
3. Send EndOfStream message to WebSocket
4. Wait for WebSocket to close
5. currentTranscript = accumulated final text
6. Notify chatgpt.js: micStatus(false)
7. Call submitTranscription(text)
    ↓
chatgpt.js:updateMicStatus(false)
    ↓
Mic indicator turns GRAY 🎤

---

transcription-handler.js:submitTranscription(text)
    ↓
Send message to ChatGPT tab:
{
    type: "insertTranscription",
    text: text,
    autoEnter: settings.autoEnterAfterSubmit
}
    ↓
chatgpt.js:handleInsertTranscription(text, autoEnter)
    ↓
1. Find prompt textarea
2. Get current text
3. Append or replace based on appendMode
4. Trigger "input" event for React
5. Store lastTranscribedText for deletion
6. If autoEnter:
    - Find submit button: button[data-testid="send-button"]
    - Click it
    - Message sent automatically
    ↓
Text appears in ChatGPT + optionally sent
```

### Deletion Flow

```
User presses ESCAPE
    ↓
keydown event (Escape code)
    ↓
chatgpt.js:handleDeleteTranscribedText()
    ↓
1. Check if lastTranscribedText is stored
2. Get current textarea text
3. Find and remove lastTranscribedText from end
4. Remove trailing separator (newline)
5. Update textarea
6. Clear lastTranscribedText
7. Show notification: "Transcribed text deleted"
    ↓
Text removed from ChatGPT
```

---

## Settings Persistence

### Storage Keys

```javascript
// API & Auth
chrome.storage.sync.apiKey = "string | null";

// Transcription behavior
chrome.storage.sync.transcriptionMode = "timer" | "manual";
chrome.storage.sync.autoSubmitDelayMs = 2000; // milliseconds

// Text handling
chrome.storage.sync.appendMode = true;
chrome.storage.sync.appendSeparator = "\n";
chrome.storage.sync.autoEnterAfterSubmit = true;

// Developer
chrome.storage.sync.debug = false;

// Legacy (kept for compatibility)
chrome.storage.sync.transcriptionIntervalMs = 1000;
chrome.storage.sync.targetChatGptTabId = null;
```

### Storage Flow

```
User changes setting in popup
    ↓
chrome.storage.sync.set({ key: value })
    ↓
Browser encrypts and syncs (if user signed in)
    ↓
All listening tabs get storage.onChanged event
    ↓
settings object updated in all content scripts
    ↓
Next recording uses new setting
```

---

## WebSocket Message Reference

### Client → Server

**StartRecognition**

```json
{
  "message": "StartRecognition",
  "audio_format": {
    "encoding": "pcm_s16le",
    "sample_rate": 16000
  },
  "transcription_config": {
    "language": "en",
    "operating_point": "default",
    "enable_partials": true
  }
}
```

**AddAudio** (binary)

- Sent as raw binary, not JSON
- PCM 16-bit audio data
- Sample rate: 16000 Hz
- Mono channel

**EndOfStream**

```json
{
  "message": "EndOfStream",
  "last_seq_no": 0
}
```

### Server → Client

**RecognitionStarted**

- Confirms session started

**AddPartialTranscript**

- Contains `results[]` with `type: "word"`
- Updates as user speaks
- May change as context grows

**AddTranscript**

- Final transcript
- Contains `results[]` with type and alternatives
- Won't change again

**EndOfUtterance**

- Triggered by silence
- Signals pause in speech

**Error**

- Contains error type and reason
- Closes connection after

---

## Error Handling Strategy

### User-Facing Errors

```
API Key Issues:
├─ Not configured → "API key not configured"
├─ Invalid → "Invalid API Key" (from Speechmatics)
└─ Expired → "Authorization failed"

Network Issues:
├─ No internet → WebSocket connection fails
├─ Timeout → "Failed to connect"
└─ Server error → "Transcription service error"

Permission Issues:
├─ Mic denied → "Microphone access denied"
├─ Tab not focused → Silent fail (auto-retry)
└─ ChatGPT not loaded → Silent fail

Text Issues:
└─ Delete failed → "Could not delete - text not found"
```

### Recovery Mechanisms

1. **Timeout handling**: WebSocket has 10s timeout
2. **Fallback options**: User can manually delete text
3. **Retry capability**: User can hold spacebar again
4. **Grace degradation**: Extension still works without all features
5. **Error logging**: Debug mode captures details

---

## Performance Considerations

### Audio Quality

- **Sample Rate**: 16kHz (Speechmatics requirement)
- **Encoding**: PCM 16-bit (lossless)
- **Bandwidth**: ~32 KB/sec (low bandwidth)

### Network Optimization

- **Chunk Size**: 100ms audio chunks (balanced latency)
- **WebSocket Compression**: Browser handles automatically
- **Idle Timeout**: 1 hour (per Speechmatics limits)

### Browser Resources

- **Memory**: ~10-20 MB (audio buffer + DOM elements)
- **CPU**: Minimal (browser handles WebSocket)
- **Threads**: Single thread (async handling)
- **Storage**: ~1 KB (settings)

### Scalability

- **Concurrent Sessions**: 1 per extension (current design)
- **Rate Limiting**: Per Speechmatics API (user's plan)
- **Cache**: None (real-time only)

---

## Browser Compatibility

### Required APIs

- ✅ WebSocket
- ✅ MediaRecorder
- ✅ getUserMedia (permissions)
- ✅ FileReader (async)
- ✅ Web Audio API
- ✅ chrome.storage.sync
- ✅ chrome.runtime.sendMessage

### Tested Browsers

- ✅ Chrome 90+
- ✅ Edge 90+
- ⚠️ Firefox (may need adjustments)
- ❌ Safari (WebSocket limitations)

### Graceful Degradation

- No WebSocket → Show error
- No MediaRecorder → Show error
- No Microphone → Show error
- No storage.sync → Use memory (lost on reload)

---

## Security Model

### API Key Security

1. **Storage**: Encrypted by Chrome's storage system
2. **Transmission**: Only over WSS (encrypted WebSocket)
3. **Scope**: Limited to Speechmatics domain
4. **User Control**: User can delete anytime

### Audio Security

1. **In Transit**: Encrypted by WebSocket
2. **At Rest**: Not stored locally
3. **Server**: Speechmatics's responsibility
4. **Deletion**: Automatic after processing

### Permission Model

1. **Storage**: User must grant explicitly
2. **Microphone**: Browser requests permission
3. **Tabs**: Extension can read only ChatGPT tab
4. **Network**: WebSocket requires WSS

---

## Debugging Tips

### Enable Debug Logging

1. Popup settings → Check "Debug logging"
2. Open Browser DevTools: F12
3. Go to Console tab
4. Record something → See detailed logs

### Common Issues

```
"API key not configured"
→ Check popup, verify API key saved

"Microphone access denied"
→ Check Chrome settings: Settings → Privacy → Microphone

"WebSocket connection timeout"
→ Check internet, verify API key valid

"Text not inserted"
→ Check ChatGPT textarea focused, reload tab

"Mic indicator missing"
→ Reload ChatGPT tab, check extension enabled
```

### Console Commands

```javascript
// Check settings
chrome.storage.sync.get(null, (items) => console.log(items));

// Check DOM elements
document.querySelector("#prompt-textarea");
document.querySelector("#speechmatics-mic-status");

// Check WebSocket (while recording)
// (Messages logged when debug=true)
```

---

## Future Enhancement Roadmap

### v1.1 (Planned)

- [ ] Language selection in popup
- [ ] Punctuation support
- [ ] Multiple transcription languages
- [ ] Session history/logs

### v2.0 (Future)

- [ ] Speaker identification
- [ ] Translation support
- [ ] Custom vocabulary
- [ ] Cloud backup of sessions
- [ ] Team sharing
- [ ] Analytics dashboard

### v3.0 (Vision)

- [ ] AI-powered corrections
- [ ] Custom model training
- [ ] Integration with other chat apps
- [ ] Mobile app companion

---

**Last Updated**: February 1, 2026
**Status**: Production Ready v1.0
