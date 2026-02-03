# 🛠️ Developer Quick Reference - New Utility Modules

## 📦 Available Utilities

You now have 4 powerful utility modules to use:

```javascript
1. NotificationSystem  - Show toast messages & status indicators
2. EventEmitter       - Inter-component event communication
3. APIClient          - HTTP requests & WebSocket connections
4. StateManager       - Application state management
```

---

## 🚀 Most Common Tasks

### Show a Success Message

```javascript
NotificationSystem.showSuccess("Text copied!");
```

### Show an Error

```javascript
NotificationSystem.showError("Network error: " + error.message);
```

### Show Status (top-right corner)

```javascript
NotificationSystem.showStatus("connecting"); // Shows: 🔄 Connecting...
NotificationSystem.showStatus("connected"); // Shows: ✓ Ready to record
NotificationSystem.showStatus("disconnected"); // Shows: ✗ Disconnected
NotificationSystem.showStatus("error"); // Shows: ⚠️ Connection error
```

### Make an API Request

```javascript
try {
  const response = await APIClient.post("/api/transcribe", {
    audio: audioData,
    language: "en",
  });
  console.log("Result:", response.data);
} catch (error) {
  console.error("Failed:", error.message);
}
```

### Manage App State

```javascript
// Create a state manager
const appState = new StateManager("myApp", {
  isRecording: false,
  transcript: "",
  error: null,
});

// Set value
appState.set("isRecording", true);

// Get value
const recording = appState.get("isRecording");

// Listen for changes
appState.subscribe("transcript", (newText, oldText) => {
  console.log(`Transcript changed: "${oldText}" → "${newText}"`);
});

// Update (read → apply function → write)
appState.update("transcript", (text) => text + " more text");
```

### Communicate Between Components

```javascript
const emitter = new EventEmitter("myApp");

// Emit event
emitter.emit("recordingStarted", { duration: 5000 });

// Listen to event
emitter.on("recordingStarted", (data) => {
  console.log("Recording duration:", data.duration);
});

// Listen once, then auto-remove
emitter.once("recordingComplete", (result) => {
  console.log("Done! Result:", result);
});

// Stop listening
emitter.off("recordingStarted", callback);
```

---

## 📊 Which Module to Use?

| Need                     | Module                 | Code                              |
| ------------------------ | ---------------------- | --------------------------------- |
| Show popup message       | **NotificationSystem** | `.showSuccess()` / `.showError()` |
| Show status indicator    | **NotificationSystem** | `.showStatus()`                   |
| HTTP GET/POST/etc        | **APIClient**          | `.get()` / `.post()` / etc        |
| WebSocket connection     | **APIClient**          | `.openWebSocket()`                |
| Send event to other code | **EventEmitter**       | `.emit()`                         |
| Listen to events         | **EventEmitter**       | `.on()`                           |
| Store app state          | **StateManager**       | `.set()` / `.get()`               |
| React to state changes   | **StateManager**       | `.subscribe()`                    |

---

## 💡 Real-World Example

```javascript
// 1. Create state to track recording
const recordingState = new StateManager("recording", {
  isActive: false,
  transcript: "",
  error: null,
});

// 2. Create event emitter for cross-component talks
const events = new EventEmitter("recording");

// 3. When user clicks record button
async function startRecording() {
  recordingState.set("isActive", true);
  NotificationSystem.showStatus("connecting");

  try {
    // 4. Make API call to transcribe
    const response = await APIClient.post("/api/transcribe", {
      audio: recordedAudio,
    });

    // 5. Update state with result
    recordingState.set("transcript", response.data.text);
    recordingState.set("isActive", false);

    // 6. Show success message
    NotificationSystem.showSuccess("Transcription complete!");

    // 7. Tell other components about it
    events.emit("transcriptionComplete", {
      text: response.data.text,
      duration: Date.now() - startTime,
    });
  } catch (error) {
    // Handle errors
    NotificationSystem.showError(error.message);
    recordingState.set("error", error.message);
    recordingState.set("isActive", false);

    events.emit("transcriptionFailed", error);
  }
}

// 8. Another component listens for the event
events.on("transcriptionComplete", (data) => {
  console.log("Someone completed transcription:", data);
});

// 9. UI automatically updates when state changes
recordingState.subscribe("isActive", (isActive) => {
  document.querySelector(".record-btn").style.color = isActive
    ? "red"
    : "black";
});

recordingState.subscribe("transcript", (text) => {
  document.querySelector(".output").textContent = text;
});
```

---

## 🔧 Configuration

### API Client

```javascript
// Configure timeouts and retries
APIClient.configure({
  timeout: 30000, // 30 seconds
  maxRetries: 3, // Try 3 times
  logging: true, // See requests in console
});
```

### State Manager

```javascript
const state = new StateManager("myApp", initialValues, {
  persist: true, // Save to localStorage
  maxHistorySize: 50, // Keep last 50 changes
});
```

### Event Emitter

```javascript
const emitter = new EventEmitter("myApp");
emitter.setMaxListeners(20); // Warn if 20+ listeners on one event
```

---

## 🐛 Debugging

### See current state

```javascript
console.log(appState.get()); // All state
console.log(appState.get("recording")); // One value
console.log(appState.debug()); // Detailed info
```

### See state changes history

```javascript
console.log(appState.getHistory(10)); // Last 10 changes
```

### Check what events exist

```javascript
console.log(emitter.eventNames()); // All events
console.log(emitter.listenerCount("myEvent")); // Listeners count
console.log(emitter.debug()); // Detailed info
```

### Check listeners for an event

```javascript
console.log(emitter.listeners("myEvent")); // All listeners
```

### Enable API logging

```javascript
APIClient.configure({ logging: true });
// Now you'll see all requests in console
```

---

## ✅ Integration Checklist

- [ ] Import all 4 modules in manifest.json (in correct order)
- [ ] Initialize StateManager for app state
- [ ] Initialize EventEmitter for events
- [ ] Replace old notification code with NotificationSystem
- [ ] Replace old API code with APIClient
- [ ] Test all 4 modules work together

---

## 📂 File Locations

```
src/content/
├── api-client.js              ✅ NEW
├── event-emitter.js           ✅ NEW
├── notification-system.js     ✅ NEW
├── state-manager.js           ✅ NEW
├── chatgpt.js                 (ready to use new modules)
├── speechmatics.js            (ready to use new modules)
└── inject-ui.js               (ready to use new modules)
```

---

## 🚨 Common Mistakes

### ❌ Don't do this:

```javascript
// ❌ Wrong - direct state mutation
appState.state.recording = true;

// ❌ Wrong - never returns
emitter.on("event", () => {
  console.log("This listener never unsubscribes!");
});

// ❌ Wrong - forget to handle error
const data = await APIClient.post(url, body); // What if it fails?

// ❌ Wrong - not removing listeners
document.addEventListener("click", handler); // Memory leak!
```

### ✅ Do this instead:

```javascript
// ✅ Correct - use .set()
appState.set("recording", true);

// ✅ Correct - save unsubscribe function
const stop = emitter.on("event", () => console.log("Event!"));
// Later
stop(); // Remove listener

// ✅ Correct - handle errors
try {
  const data = await APIClient.post(url, body);
} catch (error) {
  console.error("Failed:", error);
}

// ✅ Correct - clean up
const unsub = appState.subscribe("key", handler);
// Later
unsub(); // Remove listener
```

---

## 📞 Need More Help?

- **Detailed guide**: See `REFACTORING_GUIDE.md`
- **Progress status**: See `PROGRESS.md`
- **Examples**: Check the refactoring guide for 10+ real examples
- **API docs**: Check JSDoc comments in each module

---

## 🎯 Next Steps

1. ✅ Utilities created (done)
2. ⏳ Update your code to use them
3. ⏳ Test everything works
4. ⏳ Remove old duplicate code

Start with the "Most Common Tasks" section above!
