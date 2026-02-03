# Speechmatics Real-time Transcription Extension - Implementation Guide

## ✅ COMPLETED IMPLEMENTATION

This extension integrates Speechmatics real-time WebSocket API for live speech-to-text transcription directly into ChatGPT's text area.

---

## 📋 ARCHITECTURE OVERVIEW

### File Structure

```
src/
├── background.js (updated with new settings)
├── content/
│   ├── transcription-handler.js (NEW - WebSocket & audio)
│   └── chatgpt.js (updated with insertion/deletion)
└── popup/
    ├── popup.html (updated settings UI)
    └── popup.js (updated settings logic)
manifest.json (updated permissions)
```

---

## 🎯 CORE FEATURES IMPLEMENTED

### 1. API Key Management ✓

- **Location**: Extension settings popup
- **Storage**: Chrome Storage Sync (encrypted)
- **Features**:
  - Enter API key with visibility toggle
  - Save/Update key
  - Delete key
  - Status indicator (configured/not configured)
- **How it works**: Key is stored in `chrome.storage.sync.apiKey`

### 2. Real-time Transcription ✓

- **WebSocket Connection**:
  - URL: `wss://eu.rt.speechmatics.com/v2`
  - Authentication: API key via query parameter
  - Protocol: Speechmatics JSON messages

- **Audio Capture**:
  - MediaRecorder captures microphone audio
  - Sample rate: 16kHz (PCM 16-bit)
  - Sent in 100ms chunks

- **Transcription Flow**:
  - Partial transcripts (real-time) via `AddPartialTranscript`
  - Final transcripts via `AddTranscript`
  - End of utterance detection via `EndOfUtterance`

### 3. Spacebar-Based Control ✓

- **Hold Spacebar**: Start recording
- **Release Spacebar**: Stop recording & auto-submit
- **Keyboard Listener**: In transcription-handler.js
- **Event Handling**: Prevents spacebar default behavior in ChatGPT

### 4. Auto-Submit Modes ✓

#### Timer Mode (Default)

- **Behavior**: Auto-submit X seconds after last detected speech
- **Configuration**: User-configurable (0.5 - 10 seconds, default 2s)
- **Implementation**: `silenceTimeout` in transcription-handler.js
- **Trigger**: `EndOfUtterance` message from Speechmatics

#### Manual Mode

- **Behavior**: User manually triggers submission
- **Implementation**: User releases spacebar to manually submit
- **Setting**: Toggle in popup

### 5. Text Management ✓

#### Insertion

- **Location**: [src/content/chatgpt.js](src/content/chatgpt.js#L79)
- **Logic**:
  - Finds ChatGPT's textarea/contenteditable
  - Appends transcribed text (respects appendMode setting)
  - Triggers "input" event for React state update

#### Deletion (Escape Key)

- **Location**: [src/content/chatgpt.js](src/content/chatgpt.js#L123)
- **Logic**:
  - Escape key triggers deletion
  - Removes last transcribed text from textarea
  - Handles separator cleanup
  - Shows confirmation notification

#### Auto-Enter

- **Location**: [src/content/chatgpt.js](src/content/chatgpt.js#L100)
- **Logic**:
  - After text insertion, optionally press Enter
  - Finds submit button: `button[data-testid="send-button"]`
  - Configurable in settings

### 6. Visual Feedback ✓

#### Mic Status Indicator

- **Location**: Bottom-right corner of ChatGPT
- **States**:
  - Recording: Red circle (🔴) with glow
  - Idle: Gray circle (🎤)
- **Z-index**: 10000 (above ChatGPT)

#### Notifications

- **Success**: Green background (top-right)
- **Error**: Red background (top-right)
- **Auto-dismiss**: After 3 seconds
- **Triggered**: API errors, deletion, connectivity issues

---

## 🔧 DETAILED COMPONENT DESCRIPTIONS

### [transcription-handler.js](src/content/transcription-handler.js)

**Purpose**: Core transcription engine

**Key Functions**:

- `startRecording()`: Initialize audio & WebSocket
- `stopRecording()`: Stop audio capture, send EndOfStream
- `connectWebSocket()`: Establish Speechmatics connection
- `handleMessage()`: Process WebSocket messages
- `sendAudio()`: Stream audio chunks to server
- `submitTranscription()`: Insert text into ChatGPT

**Key State**:

- `isRecording`: Recording flag
- `currentTranscript`: Accumulated text
- `lastSpeechTime`: Timestamp for silence detection
- `silenceTimeout`: Timer for auto-submit

**Message Handling**:

- `RecognitionStarted`: Connection confirmed
- `AddPartialTranscript`: Real-time text updates
- `AddTranscript`: Final text
- `EndOfUtterance`: Silence detected
- `Error`: Server errors

### [chatgpt.js](src/content/chatgpt.js)

**Purpose**: ChatGPT integration & UI interactions

**Key Functions**:

- `getPromptElement()`: Find textarea
- `getPromptText()`: Read current text
- `setPromptText()`: Write to textarea
- `handleInsertTranscription()`: Insert transcribed text
- `handleDeleteTranscribedText()`: Remove last transcription
- `updateMicStatus()`: Update indicator appearance
- `showNotification()`: Display toast messages

**Message Listeners**:

- `insertTranscription`: Insert text + auto-enter
- `updateTranscription`: Show partial updates
- `micStatus`: Update recording indicator
- `showError`: Display error notifications

**Escape Key Handler**:

- Intercepts Escape key
- Calls `handleDeleteTranscribedText()`
- Shows success/error notification

### [popup.html](src/popup/popup.html) & [popup.js](src/popup/popup.js)

**Purpose**: Settings UI and configuration management

**Sections**:

1. **API Key Management**
   - Password input with visibility toggle
   - Save/Delete buttons
   - Status indicator
   - Link to Speechmatics Console

2. **Transcription Mode**
   - Radio buttons: Timer vs Manual
   - Dynamic settings visibility

3. **Timer Configuration**
   - Delay input (0.5-10 seconds)
   - Only shows in Timer mode

4. **Text Settings**
   - Append mode toggle
   - Auto-Enter toggle
   - Debug logging toggle

5. **Keyboard Shortcuts**
   - Spacebar: Record
   - Escape: Delete

**Key Functions**:

- `loadSettings()`: Load from storage
- `showApiStatus()`: Update API key status
- Event listeners for all inputs
- Auto-persist changes to chrome.storage.sync

---

## 📡 MESSAGE FLOW DIAGRAM

```
User Presses Spacebar (ChatGPT Tab)
    ↓
transcription-handler.js: startRecording()
    ↓
Initialize Audio (getUserMedia)
    ↓
Connect WebSocket → Speechmatics
    ↓
StartRecognition message
    ↓
Capture audio chunks → Send to WebSocket
    ↓
Speechmatics: AddPartialTranscript
    ↓
chatgpt.js: updateTranscription (show live text)
    ↓
Speechmatics: EndOfUtterance
    ↓
Timer starts (if timer mode)
    ↓
User Releases Spacebar / Timer expires
    ↓
stopRecording()
    ↓
Send EndOfStream
    ↓
WebSocket closes
    ↓
submitTranscription() → chatgpt.js: insertTranscription
    ↓
Text inserted into ChatGPT textarea
    ↓
Optional: Auto-press Enter
    ↓
User can press Escape to delete → handleDeleteTranscribedText()
```

---

## 🚀 USAGE GUIDE

### First Time Setup

1. **Get API Key**:
   - Go to https://portal.speechmatics.com/settings/api-keys
   - Create or copy existing API key

2. **Save to Extension**:
   - Click extension icon (top-right)
   - Paste API key in "API Key" field
   - Click "Save Key"
   - Should show "API key configured ✓"

3. **Open ChatGPT**:
   - Navigate to chatgpt.com
   - Mic indicator appears (bottom-right)

### Recording

1. **Click in ChatGPT text area**
2. **Hold Spacebar** → Mic turns red (🔴)
3. **Speak clearly**
4. **Release Spacebar** → Text appears in textarea
5. **Optional**:
   - Press Escape to delete transcribed text
   - Press Enter to send, or continue editing

### Configuration

- **Change mode**: Timer ↔ Manual in popup
- **Change delay**: Adjust "Auto-Submit Delay" (if Timer mode)
- **Auto-Enter**: Toggle "Auto-press Enter" to send automatically
- **Append mode**: Toggle "Append to prompt" to replace vs append

---

## ⚙️ SETTINGS SCHEMA

```javascript
{
  // API Configuration
  apiKey: "string | null",

  // Transcription Settings
  transcriptionMode: "timer" | "manual",
  autoSubmitDelayMs: 2000,  // milliseconds

  // Text Handling
  appendMode: true,
  appendSeparator: "\n",
  autoEnterAfterSubmit: true,

  // Developer
  debug: false
}
```

---

## 🔐 SECURITY NOTES

1. **API Key Storage**:
   - Stored in `chrome.storage.sync` (encrypted by browser)
   - User controls when to save/delete
   - Never logged to console (unless debug mode)

2. **WebSocket Connection**:
   - Uses WSS (encrypted)
   - Key passed via URL parameter (Speechmatics design for browser)
   - Connection closed immediately after transcription

3. **Audio Data**:
   - Only sent to Speechmatics servers
   - Not stored locally (except in MediaRecorder buffer)
   - Cleared after submission

---

## 🐛 ERROR HANDLING

| Error             | Cause              | User Experience                         |
| ----------------- | ------------------ | --------------------------------------- |
| API key invalid   | Wrong/expired key  | "API key not configured" notification   |
| Mic denied        | Permission denied  | "Microphone access denied" notification |
| WebSocket timeout | Network issue      | "Failed to connect to Speechmatics"     |
| Server error      | Speechmatics issue | Error message with reason               |
| Session error     | API quota exceeded | "Transcription service error"           |

---

## 🧪 TESTING CHECKLIST

- [ ] Install extension in Chrome
- [ ] Set API key in popup
- [ ] Open ChatGPT in new tab
- [ ] Hold spacebar → Red mic indicator
- [ ] Speak → See real-time text (partial)
- [ ] Release spacebar → Text inserted
- [ ] Press Escape → Text deleted
- [ ] Set Timer mode → Auto-submit works
- [ ] Set Manual mode → Manual submission works
- [ ] Toggle Auto-Enter → Enter pressed/not pressed
- [ ] Try with multiple tabs
- [ ] Test with invalid API key → Error shown
- [ ] Test without microphone permission → Error shown

---

## 📝 KEY IMPLEMENTATION DETAILS

### Spacebar Prevention

In [transcription-handler.js](src/content/transcription-handler.js#L276):

```javascript
document.addEventListener("keydown", (event) => {
  if (event.code === "Space" && !event.repeat && !isRecording) {
    event.preventDefault(); // Prevent ChatGPT from typing space
    startRecording();
  }
});
```

### Textarea Detection

In [chatgpt.js](src/content/chatgpt.js#L39):

```javascript
function getPromptElement() {
  const container = document.querySelector("#prompt-textarea");
  return (
    container?.querySelector("textarea") ||
    container?.querySelector("div[contenteditable='true']") ||
    container
  );
}
```

### WebSocket Audio Streaming

In [transcription-handler.js](src/content/transcription-handler.js#L147):

```javascript
mediaRecorder.ondataavailable = (event) => {
  const reader = new FileReader();
  reader.onload = (e) => {
    sendAudio(e.target.result); // Send binary data
  };
  reader.readAsArrayBuffer(event.data);
};
```

---

## 📚 REFERENCES

- **Speechmatics API**: https://docs.speechmatics.com/api-ref/realtime-transcription-websocket
- **Quickstart Guide**: https://docs.speechmatics.com/speech-to-text/realtime/quickstart
- **Chrome Storage API**: https://developer.chrome.com/docs/extensions/reference/storage/
- **WebSocket API**: https://developer.mozilla.org/en-US/docs/Web/API/WebSocket
- **MediaRecorder API**: https://developer.mozilla.org/en-US/docs/Web/API/MediaRecorder

---

## 🎓 NOTES FOR FUTURE ENHANCEMENTS

1. **JWT Generation**: Currently using API key directly (OK for short sessions)
   - For production: Generate JWT from backend to avoid exposing long-lived keys

2. **Language Support**: Currently hardcoded to English ("en")
   - Can add language selector in settings

3. **Multi-language Translation**: Speechmatics supports translation
   - Add translation target languages in settings

4. **Speaker Identification**: Can add speaker diarization
   - Set `transcription_config.diarization_config` in StartRecognition

5. **Punctuation**: Currently no automatic punctuation
   - Can enable with transcription_config settings

6. **Multiple Recording Sessions**: Currently handles one at a time
   - Can queue multiple recordings

7. **Audio Formats**: Currently WebM → PCM conversion
   - Can optimize with native format handling

8. **Performance**: Monitor WebSocket bufferedAmount
   - Prevent TCP buffer overflow in high-bandwidth scenarios

---

**Implementation completed**: February 1, 2026
**Status**: Ready for testing and deployment
