# Phase 2: Handler Refactoring - Integration Guide

## Overview

This guide explains how to migrate from the original handlers to the refactored versions that use the new modular utility framework.

## Key Improvements in Refactored Code

### 1. **Better Code Organization**

- **Before:** Mixed concerns (DOM, state, networking, UI updates) in single files
- **After:** Clear separation via utility modules

### 2. **Reusable Components**

- **Before:** Custom implementations repeated across files
- **After:** Shared utilities (NotificationSystem, StateManager, APIClient)

### 3. **Consistent Error Handling**

- **Before:** Each handler had different error patterns
- **After:** Centralized via NotificationSystem and consistent event handling

### 4. **Testability**

- **Before:** Tight coupling made unit testing difficult
- **After:** Modular architecture enables isolated testing

### 5. **Maintainability**

- **Before:** Hard to understand data flow
- **After:** Clear event-driven communication patterns

## File Comparison

### ChatGPT Handler (`chatgpt.js`)

#### Before (Original)

```javascript
// Mixed concerns
function showNotification(message) {
  // Custom DOM manipulation
}

function insertText(text) {
  // Direct DOM access
  // Direct state management
  // Inline notification calls
}

// Event handling scattered
chrome.runtime.onMessage.addListener((msg) => {
  // Multiple types handled inline
});
```

#### After (Refactored)

```javascript
// Clear separation of concerns
const appState = new StateManager("chatgpt", {...});
const settingsManager = new SettingsManager(DEFAULTS);
const eventEmitter = new EventEmitter("chatgpt-handler");

function handleInsertTranscription(text) {
  // Use utilities
  const promptEl = getPromptElement();
  setPromptText(promptEl, text);
  appState.set("lastTranscribedText", text);
  NotificationSystem.showSuccess(text);
  eventEmitter.emit("transcription-inserted", {text});
}
```

### Transcription Handler (`transcription-handler.js`)

#### Before (Original)

```javascript
// Manual WebSocket management
let ws = null;
ws.addEventListener("open", function () {
  // Handle manually
});

// Error handling scattered
if (error) {
  // Various error patterns
}

// Direct DOM updates
// Direct messaging to tabs
```

#### After (Refactored)

```javascript
// Structured state management
const connectionState = new StateManager("transcription", {...});
const audioState = new StateManager("audio", {...});

// Organized error handling
function handleError(message, errorType) {
  NotificationSystem.showError(message);
  eventEmitter.emit("error", {message, type: errorType});
  // Centralized UI updates via notifyUI()
}

// WebSocket lifecycle clearly defined
async function connectWebSocket() { ... }
async function closeWebSocket() { ... }
```

## Migration Steps

### Step 1: Update manifest.json

Ensure utility modules load before handlers:

```json
{
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": [
        "src/content/event-emitter.js",
        "src/content/notification-system.js",
        "src/content/api-client.js",
        "src/content/state-manager.js",
        "src/content/dom-utils.js",
        "src/content/settings-manager.js",
        "src/content/transcription-handler-refactored.js",
        "src/content/chatgpt-refactored.js",
        "src/content/inject-ui.js"
      ]
    }
  ]
}
```

### Step 2: Replace Original Files

Option A: Rename originals

```bash
mv src/content/chatgpt.js src/content/chatgpt.backup.js
mv src/content/transcription-handler.js src/content/transcription-handler.backup.js
cp src/content/chatgpt-refactored.js src/content/chatgpt.js
cp src/content/transcription-handler-refactored.js src/content/transcription-handler.js
```

Option B: Keep alongside (for comparison)

- Leave refactored versions as-is
- Gradually switch by updating manifest

### Step 3: Verify Integration

Test each component:

```javascript
// In console on content script
// Test state management
appState.set("test", "value");
appState.get("test"); // Returns "value"

// Test event emission
eventEmitter.emit("test", { data: "value" });
eventEmitter.on("test", (data) => console.log(data));

// Test notifications
NotificationSystem.showSuccess("Test message");

// Test settings
settingsManager.get("language"); // Returns configured language
```

## Architecture Changes

### State Management

**Original Approach:**

```javascript
let isRecording = false;
let lastText = "";
let connectionStatus = "disconnected";
// ... scattered state variables
```

**Refactored Approach:**

```javascript
const appState = new StateManager("chatgpt", {
  isRecording: false,
  lastText: "",
  // All related state grouped
});

// With subscriptions
appState.subscribe("isRecording", (value) => {
  // React to changes
});
```

**Benefits:**

- ✅ Single source of truth
- ✅ Subscription system for reactive updates
- ✅ History tracking and persistence
- ✅ Validation and type safety

### Event Communication

**Original Approach:**

```javascript
// Direct function calls
transcriptionHandler.insertText(text);

// Message passing scattered
chrome.runtime.sendMessage({ type: "insert", text: text });
```

**Refactored Approach:**

```javascript
// Event-driven
eventEmitter.emit("transcription-inserted", { text: text });

// Structured messaging
eventEmitter.on("transcription-inserted", (data) => {
  handleInsertTranscription(data.text);
});
```

**Benefits:**

- ✅ Loose coupling
- ✅ Easy to add/remove listeners
- ✅ Clear event contracts
- ✅ One-time listeners with `.once()`

### Error Handling

**Original Approach:**

```javascript
try {
  // do something
} catch (e) {
  console.error(e);
  // Notify user manually
  showAlert("Error: " + e.message);
}

// Different patterns in different files
```

**Refactored Approach:**

```javascript
function handleError(message, errorType = "unknown") {
  NotificationSystem.showError(message);
  eventEmitter.emit("error", { message, type: errorType });
  updateButtonState("error");
  connectionState.set("lastError", message);
}

// Consistent across all files
// Subscribers can listen for errors
eventEmitter.on("error", (error) => {
  log("Error occurred:", error);
});
```

**Benefits:**

- ✅ Consistent error handling
- ✅ User always notified
- ✅ Error logging centralized
- ✅ Easy debugging with error history

## Detailed Module Usage

### NotificationSystem

**Before:**

```javascript
function showNotification(msg, type) {
  let div = document.createElement("div");
  div.className = "notification " + type;
  div.innerText = msg;
  document.body.appendChild(div);
  setTimeout(() => div.remove(), 3000);
}
```

**After:**

```javascript
// Success
NotificationSystem.showSuccess("Message inserted");

// Error
NotificationSystem.showError("Failed to connect");

// Info
NotificationSystem.showInfo("Initializing...");

// Status (no auto-close)
NotificationSystem.showStatus("Recording...");
```

### StateManager

**Before:**

```javascript
let recordingState = {
  isRecording: false,
  transcript: "",
  settings: {...}
};
// Manual updates
recordingState.isRecording = true;
// No persistence
```

**After:**

```javascript
const state = new StateManager("recording", {
  isRecording: false,
  transcript: "",
  settings: {...}
});

// Observable updates
state.set("isRecording", true);
state.subscribe("isRecording", (value) => {
  console.log("Recording:", value);
});

// Auto-persistence to localStorage
state.persist(); // Automatic with StateManager
```

### APIClient

**Before:**

```javascript
const ws = new WebSocket(url);
ws.onerror = (e) => console.error(e);
ws.onmessage = (e) => processMessage(e.data);
// Manual reconnection
```

**After:**

```javascript
// Uses built-in retry with exponential backoff
const result = await APIClient.post("/endpoint", data);

// WebSocket with auto-reconnection
await APIClient.openWebSocket(url, {
  onMessage: (data) => handleMessage(data),
  onClose: () => handleClose(),
});
```

### SettingsManager

**Before:**

```javascript
chrome.storage.sync.get(["token"], (items) => {
  token = items.token;
});
chrome.storage.sync.set({ token: newToken });
```

**After:**

```javascript
const settings = new SettingsManager(DEFAULTS);

// Load all settings
await settings.load();

// Get with defaults
const token = settings.get("token"); // Returns default if not set

// Set and persist
settings.set("token", newToken);

// Get all
const all = settings.getAll();
```

### EventEmitter

**Before:**

```javascript
// No built-in event system
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "event1") handleEvent1();
  if (msg.type === "event2") handleEvent2();
});
```

**After:**

```javascript
const emitter = new EventEmitter("my-handler");

// Listen
emitter.on("transcription-received", (data) => {
  console.log(data.text);
});

// One-time listener
emitter.once("connected", () => {
  console.log("Connected!");
});

// Emit
emitter.emit("transcription-received", { text: "hello" });

// Cleanup
emitter.off("transcription-received", handler);
```

## Testing the Refactored Code

### Test 1: Basic State Management

```javascript
// In chrome devtools console
const test = new StateManager("test", { value: 0 });
test.set("value", 5);
console.assert(test.get("value") === 5, "State set failed");
test.subscribe("value", (v) => console.log("Value changed:", v));
test.set("value", 10); // Logs: "Value changed: 10"
```

### Test 2: Event Emission

```javascript
const emitter = new EventEmitter("test");
let received = false;
emitter.on("test-event", () => {
  received = true;
});
emitter.emit("test-event");
console.assert(received === true, "Event not received");
```

### Test 3: Notifications

```javascript
NotificationSystem.showSuccess("Test success");
NotificationSystem.showError("Test error");
NotificationSystem.showInfo("Test info");
NotificationSystem.showStatus("Test status");
// Should see 4 toast notifications on the page
```

### Test 4: Settings Persistence

```javascript
const settings = new SettingsManager({ lang: "en" });
await settings.load();
settings.set("lang", "es");
const value = settings.get("lang");
console.assert(value === "es", "Settings not persisted");
```

## Debugging Tips

### Enable Debug Mode

```javascript
// In chatgpt handler
const settings = settingsManager.getAll();
settings.debug = true;
settingsManager.set("debug", true);
// Now all log() calls will output

// Or directly
const originalLog = console.log;
console.log = function (...args) {
  originalLog("[ChatGPT]", ...args);
};
```

### Monitor State Changes

```javascript
// Watch specific state
appState.subscribe("isRecording", (value) => {
  console.log("Recording changed:", value);
});

// Watch all state
appState.subscribe("*", (key, value) => {
  console.log(`State changed: ${key} = ${value}`);
});
```

### Monitor Events

```javascript
// Listen to all events
eventEmitter.on("*", (eventName, data) => {
  console.log(`Event: ${eventName}`, data);
});
```

### Check Connection Status

```javascript
// Get current status
console.log("Connected:", connectionState.get("connected"));
console.log("Recording:", connectionState.get("recording"));
console.log("Last error:", connectionState.get("lastError"));

// Get history
console.log("Error count:", connectionState.get("errorCount"));
```

## Common Migration Patterns

### Pattern 1: Replacing Direct DOM Updates

**Before:**

```javascript
document.querySelector("#button").style.color = "red";
document.querySelector("#status").innerText = "Connected";
```

**After:**

```javascript
const btn = DOMUtils.querySelector("#button");
DOMUtils.applyStyles(btn, { color: "red" });

const status = DOMUtils.querySelector("#status");
DOMUtils.updateElement(status, { text: "Connected" });
```

### Pattern 2: Replacing Manual State Management

**Before:**

```javascript
let connectionStatus = "idle";
function setConnectionStatus(status) {
  connectionStatus = status;
  // Manually update UI
  updateButtonUI(status);
}
```

**After:**

```javascript
const state = new StateManager("connection", { status: "idle" });
state.subscribe("status", (status) => {
  // Automatically update UI
  updateButtonUI(status);
});

// Use state.set() to update
state.set("status", "connected");
```

### Pattern 3: Replacing Manual Error Handling

**Before:**

```javascript
try {
  await connect();
} catch (e) {
  console.error(e);
  showNotificationToUser("Error: " + e.message);
}
```

**After:**

```javascript
try {
  await connect();
} catch (e) {
  handleError(e.message, "connection");
  // handleError does the notification and logging
}
```

## Verification Checklist

- [ ] manifest.json updated with correct script order
- [ ] All utility modules loaded before handlers
- [ ] chatgpt-refactored.js uses NotificationSystem
- [ ] chatgpt-refactored.js uses StateManager for state
- [ ] transcription-handler-refactored.js uses APIClient for WebSocket
- [ ] transcription-handler-refactored.js uses StateManager
- [ ] Event listeners properly connected
- [ ] Settings loading works correctly
- [ ] UI updates work in refactored version
- [ ] Error handling consistent
- [ ] No console errors on extension load
- [ ] Notifications display correctly
- [ ] State persists across page reloads
- [ ] Events fire and are received
- [ ] Recording starts/stops correctly
- [ ] Text insertion works correctly

## Next Steps

1. **Replace original files** with refactored versions
2. **Test in browser** - open ChatGPT and verify all functionality
3. **Monitor console** for errors
4. **Check storage** - verify state and settings persist
5. **Create handlers directory** - organize specialized logic
6. **Create utils directory** - add helper functions
7. **Add JSDoc comments** - document all functions
8. **Create module READMEs** - guide for other developers

## Support & Troubleshooting

### Issue: "ReferenceError: NotificationSystem is not defined"

**Solution:** Ensure notification-system.js is loaded before handlers in manifest.json

### Issue: "State not persisting"

**Solution:** Call `state.persist()` or use StateManager with a valid key name

### Issue: "Events not being received"

**Solution:** Ensure eventEmitter is created before listeners are added; check event names match

### Issue: "Settings not loading"

**Solution:** Call `await settingsManager.load()` in initialization; use getAll() to debug

## Summary

The refactored code provides:

- ✅ **Better Organization** - Clear separation of concerns
- ✅ **Reusability** - Shared utilities across handlers
- ✅ **Maintainability** - Easier to understand and modify
- ✅ **Testability** - Modular components easy to test
- ✅ **Consistency** - Standard patterns throughout
- ✅ **Extensibility** - Easy to add new features

With these improvements, your codebase becomes more professional, maintainable, and scalable.
