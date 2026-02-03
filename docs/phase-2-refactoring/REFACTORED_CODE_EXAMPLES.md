# Refactored Code Usage Examples

This document provides practical examples of how to use the refactored handlers with the new modular utilities.

## Table of Contents

1. [State Management](#state-management)
2. [Event Communication](#event-communication)
3. [Notifications](#notifications)
4. [Settings Management](#settings-management)
5. [DOM Manipulation](#dom-manipulation)
6. [Error Handling](#error-handling)
7. [Real-World Scenarios](#real-world-scenarios)

---

## State Management

### Using StateManager in ChatGPT Handler

#### Example 1: Initialize and Use State

```javascript
// Create state store
const appState = new StateManager("chatgpt", {
  isRecording: false,
  lastTranscribedText: "",
  buttonState: "idle",
  previewText: "",
});

// Set values
appState.set("isRecording", true);
appState.set("lastTranscribedText", "Hello world");

// Get values
const isRecording = appState.get("isRecording");
console.log(isRecording); // true

// Get all values
const allState = appState.getAll();
console.log(allState);
// {
//   isRecording: true,
//   lastTranscribedText: "Hello world",
//   buttonState: "idle",
//   previewText: ""
// }
```

#### Example 2: Subscribe to State Changes

```javascript
// Listen to specific state changes
appState.subscribe("isRecording", (newValue) => {
  console.log("Recording changed to:", newValue);

  if (newValue) {
    updateMicToggleButton("recording");
    NotificationSystem.showStatus("Recording...");
  } else {
    updateMicToggleButton("idle");
    NotificationSystem.showStatus("Stopped");
  }
});

// Now when state changes, callback fires
appState.set("isRecording", true);
// Logs: "Recording changed to: true"
// Updates button and shows notification automatically
```

#### Example 3: Listen to All State Changes

```javascript
// Listen to any state change
appState.subscribe("*", (key, value) => {
  console.log(`State changed: ${key} = ${value}`);
});

appState.set("isRecording", true); // Logs: State changed: isRecording = true
appState.set("lastTranscribedText", "hi"); // Logs: State changed: lastTranscribedText = hi
appState.set("buttonState", "error"); // Logs: State changed: buttonState = error
```

#### Example 4: State with Default Values and History

```javascript
// State persists to localStorage automatically
const state = new StateManager("settings", {
  language: "en",
  autoSubmit: false,
  theme: "light",
});

// Can check if value was set before
const language = state.get("language"); // "en" (default)

// Can get value history
const history = state.getHistory("language");
console.log(history); // ["en", "es", "en", "fr", "en"]

// Reset to initial values
state.reset();
```

---

## Event Communication

### Using EventEmitter for Loose Coupling

#### Example 1: Basic Event Emission and Listening

```javascript
// Create emitter
const eventEmitter = new EventEmitter("chatgpt-handler");

// Listen for events
eventEmitter.on("transcription-inserted", (data) => {
  console.log("Text inserted:", data.text);
  updateUIAfterInsertion(data.text);
});

// Emit event when something happens
function handleInsertTranscription(text) {
  // ... insert logic ...
  eventEmitter.emit("transcription-inserted", {
    text: text,
    timestamp: new Date(),
  });
}

// When transcription is inserted:
// Logs: "Text inserted: Hello world"
// Calls updateUIAfterInsertion("Hello world")
```

#### Example 2: One-Time Listeners

```javascript
// Listen only once
eventEmitter.once("connected", (data) => {
  console.log("Connected for first time");
  // This only fires once, then listener is removed
});

eventEmitter.emit("connected", {});
eventEmitter.emit("connected", {}); // Doesn't trigger callback
```

#### Example 3: Multiple Handlers for Same Event

```javascript
// Multiple listeners for same event all receive it
eventEmitter.on("transcription-inserted", (data) => {
  saveToHistory(data.text);
});

eventEmitter.on("transcription-inserted", (data) => {
  updateWordCount(data.text);
});

eventEmitter.on("transcription-inserted", (data) => {
  NotificationSystem.showSuccess("Added: " + data.text);
});

// When event fires, all three handlers execute
eventEmitter.emit("transcription-inserted", { text: "hello" });
// Saves to history AND updates word count AND shows notification
```

#### Example 4: Remove Listeners

```javascript
const handler = (data) => {
  console.log("Received:", data);
};

// Add listener
eventEmitter.on("test-event", handler);

// Emit - triggers
eventEmitter.emit("test-event", { data: 123 });
// Logs: "Received: {data: 123}"

// Remove listener
eventEmitter.off("test-event", handler);

// Emit - doesn't trigger anymore
eventEmitter.emit("test-event", { data: 456 });
// No output
```

#### Example 5: Error Handling via Events

```javascript
// Listen for all errors
eventEmitter.on("error", (errorData) => {
  console.error("Error occurred:", errorData.message);
  console.log("Error type:", errorData.type);
  console.log("Timestamp:", errorData.timestamp);

  // Handle based on type
  switch (errorData.type) {
    case "permission":
      showPermissionDialog();
      break;
    case "connection":
      attemptReconnection();
      break;
    case "audio":
      suggestAudioFix();
      break;
  }
});

// When error happens
eventEmitter.emit("error", {
  message: "Microphone access denied",
  type: "permission",
  timestamp: new Date().toISOString(),
});
```

---

## Notifications

### Using NotificationSystem for User Feedback

#### Example 1: Show Different Notification Types

```javascript
// Success notification (auto-closes in 3s)
NotificationSystem.showSuccess("Text added to ChatGPT");

// Error notification (auto-closes in 5s)
NotificationSystem.showError("Failed to connect to microphone");

// Info notification (auto-closes in 4s)
NotificationSystem.showInfo("Recording started");

// Status notification (stays until cleared)
NotificationSystem.showStatus("Connecting...");
```

#### Example 2: Chain Notifications

```javascript
// Show series of notifications
NotificationSystem.showStatus("Connecting to Speechmatics...");

setTimeout(() => {
  NotificationSystem.showStatus("Authenticating...");
}, 1000);

setTimeout(() => {
  NotificationSystem.showSuccess("Connected!");
}, 2000);

// Or with async/await
async function connect() {
  NotificationSystem.showStatus("Connecting...");
  await connectWebSocket();
  NotificationSystem.showSuccess("Connected!");
}
```

#### Example 3: Notification with Dynamic Content

```javascript
// Show meaningful error messages
try {
  await startRecording();
} catch (error) {
  if (error.message.includes("permission")) {
    NotificationSystem.showError(
      "Microphone permission denied. Check browser settings.",
    );
  } else if (error.message.includes("timeout")) {
    NotificationSystem.showError("Connection timeout. Check your internet.");
  } else {
    NotificationSystem.showError("Recording error: " + error.message);
  }
}
```

#### Example 4: Notification Progress Flow

```javascript
// Simulate a multi-step process with notifications
async function insertAndSendText() {
  NotificationSystem.showStatus("Preparing message...");

  const promptEl = getPromptElement();
  const currentText = getPromptText(promptEl);

  setTimeout(() => {
    NotificationSystem.showStatus("Inserting text...");
    setPromptText(promptEl, currentText + "hello");
  }, 500);

  setTimeout(() => {
    NotificationSystem.showStatus("Sending...");
    const button = DOMUtils.querySelector('button[data-testid="send-button"]');
    button.click();
  }, 1000);

  setTimeout(() => {
    NotificationSystem.showSuccess("Message sent!");
  }, 1500);
}
```

---

## Settings Management

### Using SettingsManager for Persistent Configuration

#### Example 1: Load and Use Settings

```javascript
// Create settings manager with defaults
const settingsManager = new SettingsManager({
  language: "en",
  appendMode: true,
  autoSubmit: false,
  debug: false,
  apiToken: "",
});

// Load from Chrome storage
await settingsManager.load();

// Get individual setting (with default if not set)
const language = settingsManager.get("language"); // "en"
const token = settingsManager.get("apiToken"); // "" (if not set)

// Get all settings
const allSettings = settingsManager.getAll();
console.log(allSettings);
// {
//   language: "en",
//   appendMode: true,
//   autoSubmit: false,
//   debug: false,
//   apiToken: ""
// }
```

#### Example 2: Update Settings

```javascript
// Change a setting (auto-saves to Chrome storage)
settingsManager.set("language", "es");
settingsManager.set("autoSubmit", true);

// Verify changes
console.log(settingsManager.get("language")); // "es"
console.log(settingsManager.get("autoSubmit")); // true
```

#### Example 3: Settings with Validation

```javascript
// When loading, use defaults for missing values
const token = settingsManager.get("apiToken");
if (!token) {
  NotificationSystem.showError("API token not configured");
  return;
}

// Check boolean settings
if (settingsManager.get("debug")) {
  console.log("Debug mode enabled");
}

// Use settings to control behavior
function insertText(text) {
  const settings = settingsManager.getAll();

  const promptEl = getPromptElement();
  const currentText = getPromptText(promptEl);

  if (settings.appendMode) {
    // Append with separator
    const separator = settings.appendSeparator || "\n";
    setPromptText(promptEl, currentText + separator + text);
  } else {
    // Replace text
    setPromptText(promptEl, text);
  }

  if (settings.autoSubmit) {
    // Auto-send message
    const button = DOMUtils.querySelector('button[data-testid="send-button"]');
    button.click();
  }
}
```

#### Example 4: Reset to Defaults

```javascript
// Reset all settings to defaults
settingsManager.reset();

// Now all values are back to defaults
console.log(settingsManager.get("language")); // "en"
console.log(settingsManager.get("autoSubmit")); // false
```

---

## DOM Manipulation

### Using DOMUtils for Safe DOM Operations

#### Example 1: Query and Update Elements

```javascript
// Find element safely
const button = DOMUtils.querySelector("#chatgpt-button");
if (!button) {
  console.log("Button not found");
  return;
}

// Update element safely
DOMUtils.updateElement(button, {
  text: "Start Recording",
  class: "recording",
  attributes: { title: "Click to stop" },
});

// Apply styles
DOMUtils.applyStyles(button, {
  background: "#ff4444",
  color: "white",
  padding: "10px",
  borderRadius: "50%",
});
```

#### Example 2: Create and Insert Elements

```javascript
// Create element
const notification = DOMUtils.createElement("div", {
  id: "notification",
  class: "notification success",
  innerHTML: "Message inserted!",
});

// Apply styles
DOMUtils.applyStyles(notification, {
  position: "fixed",
  top: "10px",
  right: "10px",
  padding: "15px",
  background: "green",
  color: "white",
  borderRadius: "5px",
  zIndex: "9999",
});

// Add to page
document.body.appendChild(notification);

// Auto-remove after 3 seconds
setTimeout(() => {
  notification.remove();
}, 3000);
```

#### Example 3: Event Binding

```javascript
// Bind event safely
const button = DOMUtils.querySelector("#button");
DOMUtils.bindEvent(button, "click", () => {
  console.log("Button clicked");
  toggleRecording();
});

// Multiple events
const input = DOMUtils.querySelector("#input");
DOMUtils.bindEvent(input, "input", (e) => {
  appState.set("currentText", e.target.value);
});

DOMUtils.bindEvent(input, "keydown", (e) => {
  if (e.key === "Enter") {
    submitText();
  }
});
```

#### Example 4: Class Management

```javascript
const button = DOMUtils.querySelector("#mic-button");

// Add class
DOMUtils.addClass(button, "recording");

// Check if has class
if (DOMUtils.hasClass(button, "recording")) {
  console.log("Recording");
}

// Remove class
DOMUtils.removeClass(button, "recording");

// Toggle class
DOMUtils.toggleClass(button, "active");
```

---

## Error Handling

### Consistent Error Handling Patterns

#### Example 1: Centralized Error Handler

```javascript
// In transcription handler
function handleError(message, errorType = "unknown") {
  // Notify user
  NotificationSystem.showError(message);

  // Log for debugging
  log("Error:", message, "Type:", errorType);

  // Update state
  connectionState.set("lastError", message);
  const count = connectionState.get("errorCount");
  connectionState.set("errorCount", count + 1);

  // Emit event for listeners
  eventEmitter.emit("error", {
    message,
    type: errorType,
    timestamp: new Date().toISOString(),
  });

  // Update UI
  notifyUI("updateButtonState", { state: "error" });
}

// Use everywhere
try {
  await connectWebSocket();
} catch (error) {
  handleError(error.message, "connection");
}

try {
  await initializeAudioStream();
} catch (error) {
  handleError("Microphone access denied", "permission");
}
```

#### Example 2: Error Recovery

```javascript
// Listen for errors and attempt recovery
eventEmitter.on("error", (errorData) => {
  const maxAttempts = 3;
  let attempts = 0;

  const retry = async () => {
    attempts++;

    if (attempts > maxAttempts) {
      NotificationSystem.showError("Max retry attempts reached");
      return;
    }

    try {
      NotificationSystem.showStatus(`Retrying (${attempts}/${maxAttempts})...`);
      await connectWebSocket();
      NotificationSystem.showSuccess("Reconnected!");
    } catch (error) {
      setTimeout(retry, 2000); // Retry after 2 seconds
    }
  };

  // Start retry process
  setTimeout(retry, 1000);
});
```

---

## Real-World Scenarios

### Scenario 1: User Starts Recording

```javascript
// User clicks mic button
async function handleMicButtonClick() {
  try {
    // Update state
    appState.set("buttonState", "connecting");
    updateMicToggleButton("connecting");
    NotificationSystem.showStatus("Connecting...");

    // Connect if not already connected
    if (!connectionState.get("connected")) {
      await connectWebSocket();
    }

    // Start recording
    await startRecording();

    // Update UI and state
    appState.set("isRecording", true);
    appState.set("buttonState", "recording");
    updateMicToggleButton("recording");
    NotificationSystem.showSuccess("Recording...");
  } catch (error) {
    // Handle error
    const errorType = error.message.includes("permission")
      ? "permission"
      : "connection";
    handleError(error.message, errorType);
    appState.set("buttonState", "error");
    updateMicToggleButton("error");
  }
}
```

### Scenario 2: Transcription Received

```javascript
// When transcription arrives
function handleRecognitionMessage(message) {
  const { results } = message;

  if (!results || results.length === 0) return;

  results.forEach((result) => {
    const transcript = result.transcript || "";
    const isFinal = result.is_final === true;

    if (!transcript) return;

    if (isFinal) {
      // Final result
      console.log("Final:", transcript);

      // Update state
      appState.set("lastTranscribedText", transcript);

      // Emit event
      eventEmitter.emit("transcription-final", {
        text: transcript,
        confidence: result.confidence,
      });

      // Insert into ChatGPT
      handleInsertTranscription(transcript);

      // Emit event
      eventEmitter.emit("transcription-inserted", { text: transcript });
    } else {
      // Partial result - live preview
      const lastText = appState.get("lastTranscribedText");
      const preview = lastText + " " + transcript;

      appState.set("previewText", transcript);

      const promptEl = getPromptElement();
      setPromptText(promptEl, preview);

      eventEmitter.emit("transcription-partial", {
        text: transcript,
        isPartial: true,
      });
    }
  });
}
```

### Scenario 3: Settings Changed Remotely

```javascript
// Listen for storage changes (from settings page)
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "sync") return;

  // Update settings manager
  Object.keys(changes).forEach((key) => {
    const newValue = changes[key].newValue;
    settingsManager.set(key, newValue);

    // React to specific changes
    if (key === "debug") {
      if (newValue) {
        console.log("Debug mode enabled");
      }
    }

    if (key === "language") {
      NotificationSystem.showInfo(`Language changed to ${newValue}`);
      // Might need to reconnect WebSocket with new language
    }

    if (key === "apiToken") {
      if (!newValue) {
        NotificationSystem.showError("API token removed");
        closeWebSocket();
      } else {
        NotificationSystem.showInfo("API token updated");
        connectWebSocket();
      }
    }
  });

  // Emit event for listeners
  eventEmitter.emit("settings-changed", { changes });
});
```

### Scenario 4: Connection Lost and Recovery

```javascript
// In transcription handler
function handleWebSocketClose() {
  console.log("WebSocket closed");

  // Update state
  connectionState.set("connected", false);
  connectionState.set("recording", false);

  // Stop audio
  stopAudioStream();
  stopKeepAlive();

  // Notify UI
  NotificationSystem.showStatus("Disconnected");
  notifyUI("connectionStatus", { status: "disconnected" });

  // Emit event
  eventEmitter.emit("connection-closed");

  // Attempt reconnection
  if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
    reconnectAttempts++;
    NotificationSystem.showStatus(
      `Reconnecting (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`,
    );

    setTimeout(() => {
      connectWebSocket().catch((error) => {
        handleError("Reconnection failed: " + error.message, "connection");
      });
    }, RECONNECT_DELAY);
  } else {
    handleError("Max reconnection attempts reached", "connection");
    connectionState.set("lastError", "Connection lost");
  }
}
```

### Scenario 5: User Deletes Last Transcription

```javascript
// User presses Escape key
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();

    // Get last transcribed text
    const lastText = appState.get("lastTranscribedText");

    if (!lastText || !lastText.trim()) {
      NotificationSystem.showInfo("No text to delete");
      return;
    }

    // Get prompt element
    const promptEl = getPromptElement();
    if (!promptEl) {
      NotificationSystem.showError("Cannot find text area");
      return;
    }

    // Remove last text
    let currentText = getPromptText(promptEl);

    if (currentText.trim().endsWith(lastText.trim())) {
      const idx = currentText.lastIndexOf(lastText);
      currentText = currentText.substring(0, idx);

      // Remove trailing separator
      const settings = settingsManager.getAll();
      if (currentText.endsWith(settings.appendSeparator)) {
        currentText = currentText.substring(
          0,
          currentText.length - settings.appendSeparator.length,
        );
      }

      // Update
      setPromptText(promptEl, currentText);
      appState.set("lastTranscribedText", "");

      // Notify
      NotificationSystem.showInfo("Transcribed text deleted");

      // Emit event
      eventEmitter.emit("transcription-deleted", { text: lastText });
    } else {
      NotificationSystem.showError("Could not delete - text not found");
    }
  }
});
```

---

## Summary

The refactored code provides a clean, maintainable, and scalable foundation using:

1. **StateManager** - Centralized, observable state
2. **EventEmitter** - Loose coupling via events
3. **NotificationSystem** - Consistent user feedback
4. **SettingsManager** - Persistent configuration
5. **DOMUtils** - Safe DOM operations
6. **APIClient** - Network communication

These utilities work together to create a professional, enterprise-grade extension that's easy to understand, test, and extend.
