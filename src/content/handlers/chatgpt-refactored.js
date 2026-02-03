/**
 * ChatGPT Handler - Refactored with Modular Architecture
 * 
 * Handles:
 * - DOM manipulation for ChatGPT interface
 * - Text insertion and deletion
 * - Button state management
 * - User feedback through notifications
 * - Settings persistence and retrieval
 * 
 * Dependencies:
 * - NotificationSystem: User notifications
 * - EventEmitter: Inter-component communication
 * - StateManager: Application state
 * - SettingsManager: Settings persistence
 * - DOMUtils: DOM manipulation helpers
 */

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const CHATGPT_CONFIG = {
    // Selectors
    PROMPT_CONTAINER: "#prompt-textarea",
    SEND_BUTTON: 'button[data-testid="send-button"]',

    // Timeouts (ms)
    BUTTON_INIT_DELAY: 500,
    AUTO_SEND_DELAY: 100,

    // Button styling
    BUTTON_STYLES: {
        base: {
            position: "absolute",
            bottom: "12px",
            right: "48px",
            width: "36px",
            height: "36px",
            borderRadius: "50%",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "18px",
            zIndex: "1000",
            transition: "all 0.2s ease",
            padding: "0",
            border: "1px solid",
            background: "#f0f0f0",
        }
    },

    // Events
    EVENTS: {
        CLEAR: "clear",
        TRANSCRIPTION: "transcription",
    }
};

const SETTINGS_DEFAULTS = {
    appendMode: true,
    appendSeparator: "\n",
    debug: false,
    autoEnterAfterSubmit: true,
    autoSubmitMessage: false,
    showPartialTranscript: true,
    autoSubmitDelayMs: 500,
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

// Application state
const appState = new StateManager("chatgpt", {
    isRecording: false,
    currentPartialText: "",
    lastTranscribedText: "",
    previewText: "",
    buttonState: "idle",
    lastReceived: "",
});

// Session text state: keeps committed transcript stable while partial hypotheses change.
let sessionBaseText = "";
let sessionCommittedText = "";
let activeTranscriptionSessionId = null;

function dispatchResetSessionToTranscriber() {
    try {
        window.dispatchEvent(
            new CustomEvent("__testExtChatUi", { detail: { type: "resetSession" } })
        );
    } catch {
        // ignore
    }
}

// Event emitter for internal communication
const eventEmitter = new EventEmitter("chatgpt-handler");

// Settings manager
const settingsManager = new SettingsManager(SETTINGS_DEFAULTS);

// ============================================================================
// DOM UTILITIES
// ============================================================================

/**
 * Get the ChatGPT prompt text input element
 * @returns {Element|null} Textarea or contenteditable element
 */
function getPromptElement() {
    const container = DOMUtils.querySelector(CHATGPT_CONFIG.PROMPT_CONTAINER);
    if (!container) return null;

    return (
        DOMUtils.querySelector("textarea", container) ||
        DOMUtils.querySelector("div[contenteditable='true']", container) ||
        container
    );
}

/**
 * Get text from prompt element
 * @param {Element} promptEl - Prompt element
 * @returns {string} Current text content
 */
function getPromptText(promptEl) {
    if (!promptEl) return "";

    if (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT") {
        return promptEl.value || "";
    }

    return promptEl.innerText || "";
}

/**
 * Set text in prompt element
 * @param {Element} promptEl - Prompt element
 * @param {string} text - Text to set
 */
function setPromptText(promptEl, text) {
    if (!promptEl) return;

    if (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT") {
        promptEl.value = text;
    } else {
        promptEl.innerText = text;
    }

    // Trigger input event for React detection
    promptEl.dispatchEvent(new Event("input", { bubbles: true }));
}

function joinTranscriptionText(a, b) {
    const left = a || "";
    const right = b || "";
    if (!left) return right;
    if (!right) return left;
    if (/\s$/.test(left) || /^\s/.test(right)) return left + right;
    if (/^[,.;:!?)}\]]/.test(right)) return left + right;
    return left + " " + right;
}

function joinWithSeparator(base, sep, addition) {
    const left = base || "";
    const right = addition || "";
    if (!left) return right;
    if (!right) return left;
    if (!sep) return left + right;
    return left.endsWith(sep) ? left + right : left + sep + right;
}

function renderSessionText() {
    const promptEl = getPromptElement();
    if (!promptEl) return;

    const partial = appState.get("currentPartialText") || "";
    const speech = joinTranscriptionText(sessionCommittedText, partial);

    const settings = settingsManager.getAll();
    const appendMode = Boolean(settings.appendMode);

    const next = appendMode
        ? joinWithSeparator(sessionBaseText, settings.appendSeparator, speech)
        : speech;

    setPromptText(promptEl, next);
}

// ============================================================================
// TEXT MANIPULATION
// ============================================================================

/**
 * Build next text with proper formatting
 * @param {string} currentText - Current text
 * @param {string} incomingText - Text to append
 * @returns {string} Combined text
 */
function buildNextText(currentText, incomingText) {
    const settings = settingsManager.getAll();

    if (!settings.appendMode) {
        return incomingText;
    }

    const trimmedCurrent = currentText.trim();
    const trimmedIncoming = incomingText.trim();

    if (!trimmedCurrent) return incomingText;
    if (!trimmedIncoming) return currentText;

    return `${currentText}${settings.appendSeparator}${incomingText}`;
}

/**
 * Insert transcribed text into ChatGPT
 * @param {string} text - Transcribed text
 * @param {boolean} autoEnter - Auto-press enter
 */
function handleInsertTranscription(text, autoEnter = false) {
    if (!text) {
        log("Empty transcription text provided");
        return;
    }

    const promptEl = getPromptElement();
    if (!promptEl) {
        NotificationSystem.showError("Cannot find ChatGPT text area");
        return;
    }

    // Insert text
    const currentText = getPromptText(promptEl);
    const nextText = buildNextText(currentText, text);
    setPromptText(promptEl, nextText);

    // Update state
    appState.set("lastTranscribedText", text);
    sessionBaseText = nextText;
    sessionCommittedText = nextText;
    clearPartialPreview();

    // Show success notification
    NotificationSystem.showSuccess(text);

    log("Transcription inserted:", text);

    // Auto-send if enabled
    const settings = settingsManager.getAll();
    if (settings.autoSubmitMessage) {
        setTimeout(() => {
            const submitBtn = DOMUtils.querySelector(CHATGPT_CONFIG.SEND_BUTTON);
            if (submitBtn) {
                submitBtn.click();
                log("Auto-sent message to ChatGPT");
                eventEmitter.emit("message-sent", { text, auto: true });
            }
        }, CHATGPT_CONFIG.AUTO_SEND_DELAY);
    } else if (autoEnter) {
        setTimeout(() => {
            const submitBtn = DOMUtils.querySelector(CHATGPT_CONFIG.SEND_BUTTON);
            if (submitBtn) {
                submitBtn.click();
                log("Auto-submitted message");
            }
        }, CHATGPT_CONFIG.AUTO_SEND_DELAY);
    }
}

/**
 * Handle partial transcription (live preview)
 * @param {string} text - Partial text
 * @param {boolean} isPartial - Is partial update
 */
function handlePartialTranscription(text, isPartial = true) {
    const promptEl = getPromptElement();
    if (!promptEl) return;

    if (isPartial) {
        appState.set("currentPartialText", text);

        const settings = settingsManager.getAll();
        if (settings.showPartialTranscript) {
            displayPartialTranscript(text);
        }
    } else {
        appState.set("currentPartialText", "");
        clearPartialPreview();
    }
}

/**
 * Display partial transcript in textarea
 * @param {string} text - Partial text
 */
function displayPartialTranscript(text) {
    if (!text && text !== "") return;
    appState.set("previewText", text);
    renderSessionText();
}

/**
 * Clear partial preview
 */
function clearPartialPreview() {
    appState.set("previewText", "");
    renderSessionText();
}

/**
 * Delete last transcribed text
 */
function handleDeleteTranscribedText() {
    const lastText = appState.get("lastTranscribedText");
    if (!lastText || !lastText.trim()) {
        return;
    }

    const promptEl = getPromptElement();
    if (!promptEl) return;

    let currentText = getPromptText(promptEl);
    const settings = settingsManager.getAll();

    // Remove transcribed text
    if (currentText.trim().endsWith(lastText.trim())) {
        const idx = currentText.lastIndexOf(lastText);
        if (idx !== -1) {
            currentText = currentText.substring(0, idx);

            // Remove trailing separator
            const sep = settings.appendSeparator;
            if (currentText.endsWith(sep)) {
                currentText = currentText.substring(0, currentText.length - sep.length);
            }

            setPromptText(promptEl, currentText);
            appState.set("lastTranscribedText", "");
            NotificationSystem.showInfo("Transcribed text deleted");
            log("Transcribed text deleted");
            return;
        }
    }

    NotificationSystem.showError("Could not delete - text not found");
}

// ============================================================================
// MIC BUTTON MANAGEMENT
// ============================================================================

let micToggleButton = null;

/**
 * Create mic toggle button above ChatGPT textarea
 */
function createMicToggleButton() {
    const host = document.body || document.documentElement;
    if (micToggleButton && host && host.contains(micToggleButton)) {
        return micToggleButton;
    }

    const promptContainer = DOMUtils.querySelector(CHATGPT_CONFIG.PROMPT_CONTAINER);
    if (!promptContainer) return null;

    // Check if already exists
    const existing = DOMUtils.querySelector("#speechmatics-mic-toggle", promptContainer);
    if (existing) {
        micToggleButton = existing;
        return existing;
    }

    // Create button
    const button = DOMUtils.createElement("button", {
        id: "speechmatics-mic-toggle",
        type: "button",
        title: "Click to start recording (or hold spacebar)",
        innerHTML: "🎤",
    });

    // Apply styles
    DOMUtils.applyStyles(button, CHATGPT_CONFIG.BUTTON_STYLES.base);
    button.style.background = "#f0f0f0";
    button.style.borderColor = "#999";
    button.style.boxShadow = "0 2px 4px rgba(0, 0, 0, 0.1)";

    // Add event listeners
    button.addEventListener("mouseenter", () => {
        button.style.background = "#e0e0e0";
        button.style.boxShadow = "0 4px 8px rgba(0, 0, 0, 0.15)";
    });

    button.addEventListener("mouseleave", () => {
        const isRecording = appState.get("isRecording");
        button.style.background = isRecording ? "#ff4444" : "#f0f0f0";
        button.style.boxShadow = isRecording
            ? "0 0 12px rgba(255, 68, 68, 0.6)"
            : "0 2px 4px rgba(0, 0, 0, 0.1)";
    });

    button.addEventListener("click", async (e) => {
        e.preventDefault();
        e.stopPropagation();

        try {
            await toggleRecording();
            updateMicToggleButton();
        } catch (error) {
            log("Error toggling recording:", error);
            NotificationSystem.showError("Recording error: " + error.message);
            appState.set("buttonState", "error");
            updateMicToggleButton("error");
        }
    });

    // Insert as a floating button (outside the textarea), positioned near the prompt.
    const domHost = document.body || document.documentElement;
    if (domHost) {
        domHost.appendChild(button);
    }

    micToggleButton = button;
    positionMicToggleButton();
    return button;
}

function positionMicToggleButton() {
    if (!micToggleButton) return;
    const anchor =
        document.querySelector('[data-composer-surface="true"]') ||
        DOMUtils.querySelector(CHATGPT_CONFIG.PROMPT_CONTAINER);
    if (!anchor) return;

    const builtInVoiceBtn =
        anchor.querySelector('button[aria-label="Start Voice"]') ||
        anchor.querySelector('button[aria-label="Start voice"]') ||
        anchor.querySelector('button[aria-label="Dictate button"]') ||
        anchor.querySelector(".composer-submit-button-color");

    const rect = (builtInVoiceBtn || anchor).getBoundingClientRect();
    const size = 36;
    const gap = 8;

    let top;
    let left;

    if (builtInVoiceBtn) {
        top = rect.top - size - 10;
        left = rect.left + Math.round((rect.width - size) / 2);
    } else {
        top = rect.top - size - 10;
        left = rect.right - size - 10;
    }

    top = Math.max(gap, top);
    left = Math.min(Math.max(gap, left), window.innerWidth - size - gap);

    micToggleButton.style.position = "fixed";
    micToggleButton.style.top = `${top}px`;
    micToggleButton.style.left = `${left}px`;
    micToggleButton.style.zIndex = "10005";
}

/**
 * Update mic button appearance based on state
 * @param {string} state - Button state (idle, connecting, recording, error)
 */
function updateMicToggleButton(state = null) {
    if (!micToggleButton) return;

    const currentState = state || appState.get("buttonState");
    const stateStyles = {
        idle: {
            icon: "🎤",
            background: "#f0f0f0",
            borderColor: "#999",
            boxShadow: "0 2px 4px rgba(0, 0, 0, 0.1)",
            title: "Click to start recording",
            class: ""
        },
        connecting: {
            icon: "🔄",
            background: "#FFC107",
            borderColor: "#FFA000",
            boxShadow: "0 0 10px rgba(255, 193, 7, 0.4)",
            title: "Connecting...",
            class: "connecting"
        },
        recording: {
            icon: "🔴",
            background: "#ff4444",
            borderColor: "#cc0000",
            boxShadow: "0 0 12px rgba(255, 68, 68, 0.6)",
            title: "Recording... Click to stop",
            class: "recording"
        },
        error: {
            icon: "⚠️",
            background: "#ff5252",
            borderColor: "#d32f2f",
            boxShadow: "0 0 12px rgba(255, 82, 82, 0.5)",
            title: "Error - Click to retry",
            class: "error"
        }
    };

    const style = stateStyles[currentState] || stateStyles.idle;

    micToggleButton.innerHTML = style.icon;
    micToggleButton.style.background = style.background;
    micToggleButton.style.borderColor = style.borderColor;
    micToggleButton.style.boxShadow = style.boxShadow;
    micToggleButton.title = style.title;

    // Update animation classes
    micToggleButton.classList.remove("recording", "connecting", "error");
    if (style.class) {
        micToggleButton.classList.add(style.class);
    }

    appState.set("buttonState", currentState);
}

// ============================================================================
// RECORDING MANAGEMENT
// ============================================================================

/**
 * Toggle recording state (placeholder - actual logic in transcription-handler)
 */
async function toggleRecording() {
    // This communicates with the transcriber from transcription-handler.js (same isolated world).
    const transcriber =
        (typeof window !== "undefined" && window.SpeechmasticsTranscriber) ||
        (typeof window !== "undefined" && window.SpeechmaticsTranscriber) ||
        (typeof SpeechmasticsTranscriber !== "undefined"
            ? SpeechmasticsTranscriber
            : null);

    if (!transcriber || typeof transcriber.toggleRecording !== "function") {
        throw new Error("Transcriber not available");
    }

    await transcriber.toggleRecording();
}

// ============================================================================
// EVENT LISTENERS
// ============================================================================

/**
 * Handle incoming messages from other content scripts
 */
chrome.runtime.onMessage.addListener((request) => {
    if (!request) return;

    if (typeof request.sessionId === "number") {
        if (activeTranscriptionSessionId == null) {
            activeTranscriptionSessionId = request.sessionId;
        } else if (request.sessionId !== activeTranscriptionSessionId) {
            if (request.type !== "micStatus" && request.type !== "connectionStatus") {
                return;
            }
            activeTranscriptionSessionId = request.sessionId;
        }
    }

    // Legacy event handling
    if (request.eventType === CHATGPT_CONFIG.EVENTS.TRANSCRIPTION) {
        handleInsertTranscription(request.message);
        return;
    }

    // New Speechmatics messages
    switch (request.type) {
        case "appendCommittedTranscript":
            sessionCommittedText = joinTranscriptionText(sessionCommittedText, request.text);
            renderSessionText();
            break;

        case "finalizeTranscription": {
            // Remove partial overlay and optionally auto-send.
            appState.set("currentPartialText", "");
            appState.set("previewText", "");
            renderSessionText();

            const settings = settingsManager.getAll();
            const shouldAutoSend = Boolean(settings.autoSubmitMessage) || Boolean(request.autoEnter);
            if (shouldAutoSend) {
                setTimeout(() => {
                    const submitBtn = DOMUtils.querySelector(CHATGPT_CONFIG.SEND_BUTTON);
                    if (submitBtn) submitBtn.click();
                    setTimeout(() => {
                        const promptEl = getPromptElement();
                        if (promptEl) setPromptText(promptEl, "");
                        sessionBaseText = "";
                        sessionCommittedText = "";
                    }, 50);
                }, 0);
            }
            break;
        }

        case "insertTranscription":
            handleInsertTranscription(request.text, request.autoEnter);
            eventEmitter.emit("transcription-inserted", { text: request.text });
            break;

        case "updateTranscription":
            handlePartialTranscription(request.text, request.isPartial);
            eventEmitter.emit("partial-transcription", { text: request.text, isPartial: request.isPartial });
            break;

        case "micStatus":
            appState.set("isRecording", request.recording);
            if (request.recording) {
                const promptEl = getPromptElement();
                sessionBaseText = promptEl ? getPromptText(promptEl) : "";
                sessionCommittedText = "";
            }
            updateMicToggleButton(request.recording ? "recording" : "idle");
            eventEmitter.emit("mic-status-changed", { recording: request.recording });
            break;

        case "showError":
            if (request.errorType === "permission") {
                NotificationSystem.showError("Microphone access denied. Check permissions.");
            } else if (request.errorType === "connection") {
                NotificationSystem.showError("Connection error: " + request.message);
            } else if (request.errorType === "timeout") {
                NotificationSystem.showError("Connection timeout. Try again.");
            } else {
                NotificationSystem.showError(request.message);
            }
            appState.set("buttonState", "error");
            updateMicToggleButton("error");
            eventEmitter.emit("error", { message: request.message, type: request.errorType });
            break;

        case "updateButtonState":
            appState.set("buttonState", request.state);
            updateMicToggleButton(request.state);
            eventEmitter.emit("button-state-changed", { state: request.state });
            break;

        case "connectionStatus":
            NotificationSystem.showStatus(request.status);
            const stateMap = {
                connecting: "connecting",
                connected: "idle",
                disconnected: "error",
                error: "error"
            };
            updateMicToggleButton(stateMap[request.status] || "idle");
            eventEmitter.emit("connection-status-changed", { status: request.status });
            break;
    }
});

// If the user clicks Send / presses Enter while still recording, reset buffers so the next
// message starts fresh.
try {
    if (!window.__testExtSendResetHooksInstalledRefactored) {
        window.__testExtSendResetHooksInstalledRefactored = true;

        const sendButtonSelector = [
            'button[data-testid="send-button"]',
            'button[data-testid="composer-submit-button"]',
            "button.composer-submit-button",
            "button.composer-submit-button-color",
            'button[aria-label="Send"]',
            'button[aria-label="Send prompt"]',
            'button[aria-label="Send message"]',
        ].join(",");

        const scheduleReset = () => {
            setTimeout(() => {
                const transcriber =
                    (typeof window !== "undefined" &&
                        (window.SpeechmasticsTranscriber || window.SpeechmaticsTranscriber)) ||
                    null;
                const stillRecording =
                    !!transcriber && typeof transcriber.isRecording === "function"
                        ? transcriber.isRecording()
                        : false;

                const promptEl = getPromptElement();
                // Always start a fresh voice message after send.
                sessionBaseText = "";
                sessionCommittedText = "";
                appState.set("currentPartialText", "");
                appState.set("previewText", "");
                if (stillRecording && promptEl) {
                    setPromptText(promptEl, "");
                }
                renderSessionText();
                dispatchResetSessionToTranscriber();

                if (!stillRecording) {
                    sessionBaseText = "";
                    sessionCommittedText = "";
                }
            }, 0);
        };

        document.addEventListener(
            "click",
            (e) => {
                const btn = e.target?.closest?.(sendButtonSelector);
                if (!btn) return;
                scheduleReset();
            },
            true
        );

        document.addEventListener(
            "submit",
            (e) => {
                scheduleReset();
            },
            true
        );

        document.addEventListener(
            "keydown",
            (e) => {
                if (e.key !== "Enter") return;
                if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
                if (e.isComposing) return;
                scheduleReset();
            },
            true
        );
    }
} catch {
    // ignore
}

/**
 * Handle keyboard events
 */
document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
        event.preventDefault();
        handleDeleteTranscribedText();
    }
});

/**
 * Handle settings changes from other tabs
 */
chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;

    Object.keys(changes).forEach((key) => {
        settingsManager.set(key, changes[key].newValue);
    });

    eventEmitter.emit("settings-changed", { changes });
});

// ============================================================================
// INITIALIZATION
// ============================================================================

/**
 * Logging utility
 */
function log(...args) {
    const settings = settingsManager.getAll();
    if (settings.debug) {
        console.log("[ChatGPT-Handler]", ...args);
    }
}

/**
 * Initialize ChatGPT handler
 */
async function initialize() {
    try {
        log("Initializing ChatGPT handler...");

        // Load settings
        await settingsManager.load();

        // Create UI elements
        createMicToggleButton();

        // Initialize state subscriptions
        appState.subscribe("buttonState", (state) => {
            log("Button state changed:", state);
        });

        appState.subscribe("isRecording", (recording) => {
            log("Recording state:", recording);
        });

        // Setup event listeners
        eventEmitter.on("error", ({ message, type }) => {
            log("Error event:", { message, type });
        });

        log("ChatGPT handler initialized successfully");
        NotificationSystem.showInfo("Voice transcription ready");
    } catch (error) {
        console.error("[ChatGPT-Handler] Initialization error:", error);
        NotificationSystem.showError("Failed to initialize voice transcription");
    }
}

// Initialize after a short delay
setTimeout(initialize, CHATGPT_CONFIG.BUTTON_INIT_DELAY);

// ============================================================================
// PUBLIC API
// ============================================================================

const ChatGPTHandler = {
    initialize,
    handleInsertTranscription,
    handlePartialTranscription,
    handleDeleteTranscribedText,
    updateMicToggleButton,
    getPromptElement,
    getPromptText,
    setPromptText,
    appState,
    eventEmitter,
    settingsManager,
};
