# Speechmatics Extension - Code Quality & Modularity Refactoring Guide

## Overview

This document provides a comprehensive guide to the refactoring improvements made to enhance code quality, modularity, and maintainability of the Speechmatics Chrome extension.

## 📚 Table of Contents

1. [New Utility Modules](#new-utility-modules)
2. [Code Organization Principles](#code-organization-principles)
3. [Refactoring Checklist](#refactoring-checklist)
4. [Best Practices](#best-practices)
5. [Common Patterns](#common-patterns)
6. [Debugging Guide](#debugging-guide)
7. [Migration Guide](#migration-guide)

---

## New Utility Modules

### 1. **Notification System** (`notification-system.js`)

**Purpose:** Centralized toast and notification management

**Key Features:**

- Toast notifications (success, error, info)
- Status indicators
- Auto-removal with animations
- Non-blocking notification stacking
- Customizable duration and styles

**Usage Examples:**

```javascript
// Show notifications
NotificationSystem.showSuccess("Text transcribed successfully!");
NotificationSystem.showError("Connection failed");
NotificationSystem.showInfo("Recording started");

// Show status indicators (appears in top-right)
NotificationSystem.showStatus("connecting"); // Connecting...
NotificationSystem.showStatus("connected"); // Ready to record
NotificationSystem.showStatus("disconnected"); // Disconnected
NotificationSystem.showStatus("error"); // Connection error

// Clear all
NotificationSystem.clearAll();
```

**Benefits:**

- Consistent UI/UX across the extension
- No duplicate notifications
- Proper animation and styling
- Easy to customize colors and messages

---

### 2. **Event Emitter** (`event-emitter.js`)

**Purpose:** Decoupled pub/sub communication between components

**Key Features:**

- Event registration and emission
- One-time listeners (`.once()`)
- Error handling in listeners
- Memory leak detection
- Chainable API

**Usage Examples:**

```javascript
// Create an emitter
const emitter = new EventEmitter('transcriptionManager');

// Subscribe to events
emitter.on('transcriptionStart', (data) => {
    console.log('Started:', data);
});

// One-time subscription
emitter.once('transcriptionComplete', (result) => {
    console.log('Done:', result);
});

// Emit events
emitter.emit('transcriptionStart', { audioData: [...] });

// Get listener info
const count = emitter.listenerCount('transcriptionStart');
const allEvents = emitter.eventNames();

// Unsubscribe
emitter.off('transcriptionStart', callback);
emitter.removeAllListeners('transcriptionStart');

// Debug
console.log(emitter.debug());
```

**Benefits:**

- Loose coupling between components
- Easy to add/remove listeners
- Built-in error handling
- Memory leak warnings

---

### 3. **API Client** (`api-client.js`)

**Purpose:** Centralized HTTP and WebSocket communication

**Key Features:**

- Automatic retry with exponential backoff
- Request timeout handling
- Proper error classification
- WebSocket with auto-reconnection
- Request/response logging
- Content-type aware parsing

**Usage Examples:**

```javascript
// Configure
APIClient.configure({
  timeout: 20000,
  maxRetries: 3,
  logging: true,
});

// Simple requests
const response = await APIClient.get("/api/data");
const result = await APIClient.post("/api/transcribe", { audio: data });
await APIClient.put("/api/user", { name: "John" });
await APIClient.delete("/api/session");

// With options
const response = await APIClient.post("/api/transcribe", data, {
  timeout: 5000,
  headers: { Authorization: "Bearer token" },
});

// WebSocket
const ws = APIClient.openWebSocket("wss://api.example.com", {
  maxReconnectAttempts: 5,
  reconnectDelay: 1000,
  onOpen: () => console.log("Connected"),
  onMessage: (data) => console.log("Got:", data),
  onError: (error) => console.error("Error:", error),
  onClose: () => console.log("Closed"),
});

ws.send({ command: "transcribe" });
const connected = ws.isConnected();
ws.close();
```

**Benefits:**

- Automatic retry logic for failed requests
- Consistent error handling
- Proper timeout management
- WebSocket reconnection
- Comprehensive logging

---

### 4. **State Manager** (`state-manager.js`)

**Purpose:** Reactive state management with persistence

**Key Features:**

- Observable state changes
- History tracking
- localStorage persistence
- State validation
- Change subscriptions
- Chainable API

**Usage Examples:**

```javascript
// Create state manager
const appState = new StateManager(
  "app",
  {
    recording: false,
    transcript: "",
    isConnected: false,
    error: null,
  },
  {
    persist: true, // Save to localStorage
    maxHistorySize: 50,
  },
);

// Read state
const all = appState.get();
const recording = appState.get("recording");

// Set state
appState.set("recording", true);
appState.set({
  recording: true,
  transcript: "hello",
});

// Update state (read current, apply function)
appState.update("transcript", (text) => text + " world");
appState.update("count", (count) => count + 1);

// Subscribe to changes
const unsubscribe = appState.subscribe("recording", (newVal, oldVal) => {
  console.log(`Recording: ${oldVal} -> ${newVal}`);
});

// Later
unsubscribe();

// Reset to initial values
appState.reset();
appState.reset("transcript");
appState.reset(["recording", "transcript"]);

// History
const history = appState.getHistory(5); // Last 5 changes
appState.clearHistory();

// Persistence
appState.save(); // Manually save
appState.restore(); // Manually restore
appState.clearPersisted();

// Debug
console.log(appState.debug());
```

**Benefits:**

- Reactive updates (subscribers notified automatically)
- Single source of truth for app state
- Automatic persistence
- Change history for debugging
- Type-safe with validation

---

## Code Organization Principles

### 1. **Single Responsibility Principle (SRP)**

Each module should have one reason to change:

```javascript
// ❌ Bad: Mixing concerns
function transcribeAndSaveAndNotify(audio) {
  const result = transcribe(audio);
  save(result);
  showNotification(result.message);
}

// ✅ Good: Separate concerns
function transcribe(audio) {
  /* ... */
}
function saveTranscription(text) {
  /* ... */
}
function handleTranscriptionComplete(result) {
  NotificationSystem.showSuccess(result.message);
}
```

### 2. **Dependency Injection**

Pass dependencies instead of creating them:

```javascript
// ❌ Bad: Hard dependency
function TranscriptionHandler() {
  this.api = new APIClient(); // Tightly coupled
}

// ✅ Good: Injected dependency
function TranscriptionHandler(api) {
  this.api = api;
}
```

### 3. **Composition Over Inheritance**

Use composition for flexibility:

```javascript
// ❌ Bad: Inheritance
class SmartTranscriber extends Transcriber {
  // Deep inheritance chain
}

// ✅ Good: Composition
const transcriber = {
  transcribe: transcribeAudio,
  validate: validateAudio,
  format: formatResult,
  notify: NotificationSystem.showSuccess,
};
```

### 4. **Modularity**

Break large files into focused modules:

```
src/content/
├── api-client.js              # HTTP/WebSocket
├── event-emitter.js           # Pub/sub
├── notification-system.js     # Toasts
├── state-manager.js           # State
├── speechmatics.js            # Main handler (refactored)
├── chatgpt.js                 # ChatGPT integration
└── inject-ui.js               # UI injection
```

---

## Refactoring Checklist

### Immediate Priorities

- [ ] **Create `handlers/` directory** for specialized handlers
  - `transcriptionHandler.js` - Transcription logic
  - `connectionHandler.js` - Connection management
  - `storageHandler.js` - Data persistence

- [ ] **Create `utils/` directory** for utility functions
  - `audioUtils.js` - Audio processing helpers
  - `domUtils.js` - DOM manipulation helpers
  - `validationUtils.js` - Input validation
  - `formatUtils.js` - Text formatting

- [ ] **Create `config/` directory** for constants
  - `constants.js` - Magic strings and numbers
  - `defaults.js` - Default configuration
  - `endpoints.js` - API endpoints

- [ ] **Refactor main handler files**
  - [ ] `speechmatics.js` - Main extension handler
  - [ ] `chatgpt.js` - ChatGPT integration
  - [ ] `inject-ui.js` - UI injection

### Documentation

- [ ] Add JSDoc comments to all functions
- [ ] Create README for each module
- [ ] Document all public APIs
- [ ] Add usage examples

### Testing & Validation

- [ ] Test notification system in content scripts
- [ ] Test event emitter with multiple listeners
- [ ] Test API client retry logic
- [ ] Test state manager persistence

---

## Best Practices

### 1. **Error Handling**

```javascript
// ✅ Good: Proper error handling
async function handleTranscription(audio) {
  try {
    NotificationSystem.showStatus("connecting");

    const response = await APIClient.post("/api/transcribe", { audio });

    if (!response.ok) {
      throw new Error(`Server error: ${response.status}`);
    }

    appState.set("transcript", response.data.text);
    NotificationSystem.showSuccess("Transcription complete");
  } catch (error) {
    console.error("[Transcription]", error);
    NotificationSystem.showError("Transcription failed: " + error.message);
    appState.set("error", error.message);
  }
}
```

### 2. **Logging**

```javascript
// ✅ Good: Structured logging with context
console.log("[TranscriptionHandler] Starting transcription");
console.log("[TranscriptionHandler] Audio size:", audioData.length);
console.error("[TranscriptionHandler] Error:", error.message);

// ✅ Better: Use namespaced logger
const logger = {
  log: (msg) => console.log(`[Speechmatics] ${msg}`),
  error: (msg) => console.error(`[Speechmatics] ❌ ${msg}`),
  warn: (msg) => console.warn(`[Speechmatics] ⚠ ${msg}`),
  success: (msg) => console.log(`[Speechmatics] ✓ ${msg}`),
};
```

### 3. **Memory Management**

```javascript
// ✅ Good: Cleanup listeners
function initializeComponent() {
  const handleChange = (value) => {
    /* ... */
  };
  const unsubscribe = appState.subscribe("recording", handleChange);

  return {
    destroy() {
      unsubscribe();
    },
  };
}

// Usage
const component = initializeComponent();
// Later
component.destroy();
```

### 4. **Configuration**

```javascript
// ✅ Good: Centralized config
const CONFIG = {
  API_TIMEOUT: 30000,
  MAX_RETRIES: 3,
  MAX_AUDIO_SIZE: 10 * 1024 * 1024, // 10MB
  SAMPLE_RATE: 16000,
  FEATURES: {
    AUTO_SAVE: true,
    ANALYTICS: false,
    DEBUG_MODE: false,
  },
};

// Usage
const timeout = CONFIG.API_TIMEOUT;
```

---

## Common Patterns

### Pattern 1: Request with Error Handling

```javascript
async function transcribeAudio(audioData) {
  try {
    NotificationSystem.showStatus("connecting");

    const response = await APIClient.post(
      "/api/transcribe",
      {
        audio: audioData,
        language: appState.get("language"),
      },
      {
        timeout: 30000,
      },
    );

    const transcript = response.data.text;
    appState.set("transcript", transcript);

    NotificationSystem.showSuccess("Transcription complete!");
    emitter.emit("transcriptionComplete", { text: transcript });
  } catch (error) {
    console.error("Transcription failed:", error);
    NotificationSystem.showError(error.message);
    appState.set("error", error.message);
  }
}
```

### Pattern 2: State-Driven UI Updates

```javascript
function setupUIUpdates() {
  // Update UI when state changes
  appState.subscribe("recording", (isRecording) => {
    const btn = document.querySelector(".record-btn");
    btn.classList.toggle("active", isRecording);
    btn.textContent = isRecording ? "Stop" : "Start";
  });

  appState.subscribe("transcript", (text) => {
    const output = document.querySelector(".transcript");
    output.textContent = text || "(No text)";
  });

  appState.subscribe("error", (error) => {
    const errorEl = document.querySelector(".error-message");
    errorEl.style.display = error ? "block" : "none";
    errorEl.textContent = error || "";
  });
}
```

### Pattern 3: Connection Management

```javascript
function setupConnection() {
  const ws = APIClient.openWebSocket("wss://api.example.com", {
    onOpen: () => {
      appState.set("isConnected", true);
      NotificationSystem.showStatus("connected");
      emitter.emit("connectionOpen");
    },
    onMessage: (data) => {
      emitter.emit("message", data);
    },
    onError: (error) => {
      appState.set("error", error.message);
      NotificationSystem.showError("Connection error");
      emitter.emit("connectionError", error);
    },
    onClose: () => {
      appState.set("isConnected", false);
      NotificationSystem.showStatus("disconnected");
      emitter.emit("connectionClose");
    },
  });

  return ws;
}
```

---

## Debugging Guide

### 1. **Inspect State**

```javascript
// In DevTools console
StateManager.debug();
StateManager.getHistory(10);
```

### 2. **Monitor Events**

```javascript
// In DevTools console
EventEmitter.debug();
EventEmitter.on("*", (event, data) => {
  console.log(`Event: ${event}`, data);
});
```

### 3. **API Logging**

```javascript
// Enable all API logging
APIClient.configure({ logging: true });

// Check request history
APIClient.getHistory(5);
```

### 4. **Notification Testing**

```javascript
// Test all notification types
NotificationSystem.showSuccess("Success!");
NotificationSystem.showError("Error!");
NotificationSystem.showInfo("Info!");

// Test status indicators
["connecting", "connected", "disconnected", "error"].forEach((status) => {
  setTimeout(() => NotificationSystem.showStatus(status), 500);
});
```

---

## Migration Guide

### Step 1: Update manifest.json

```json
{
  "content_scripts": [
    {
      "matches": ["*://*.chatgpt.com/*"],
      "js": [
        "src/content/event-emitter.js",
        "src/content/notification-system.js",
        "src/content/api-client.js",
        "src/content/state-manager.js",
        "src/content/speechmatics.js",
        "src/content/chatgpt.js",
        "src/content/inject-ui.js"
      ]
    }
  ]
}
```

### Step 2: Update speechmatics.js

```javascript
// Initialize utilities
const emitter = new EventEmitter("speechmatics");
const appState = new StateManager(
  "speech",
  {
    isRecording: false,
    transcript: "",
    isConnected: false,
    error: null,
  },
  { persist: true },
);

// Use in handlers
async function handleRecord() {
  try {
    appState.set("isRecording", true);
    NotificationSystem.showStatus("connecting");
    // ... transcription logic
  } catch (error) {
    NotificationSystem.showError(error.message);
  }
}
```

### Step 3: Remove Duplicated Code

- Remove inline notification code
- Remove inline state management
- Remove inline API handling
- Use new modules instead

---

## Performance Optimization Tips

1. **Lazy load utilities**: Only load when needed
2. **Debounce state changes**: Group multiple updates
3. **Cleanup listeners**: Always unsubscribe when done
4. **Limit history size**: Prevent memory buildup

---

## Next Steps

1. ✅ Create utility modules (done)
2. ⏳ Refactor main handler files
3. ⏳ Add comprehensive tests
4. ⏳ Update documentation
5. ⏳ Deploy with improvements

---

## Resources

- [MDN: Design Patterns](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide/Details_of_the_Object_Model)
- [Clean Code Principles](https://www.oreilly.com/library/view/clean-code-a/9780136083238/)
- [Chrome Extension Documentation](https://developer.chrome.com/docs/extensions/)
