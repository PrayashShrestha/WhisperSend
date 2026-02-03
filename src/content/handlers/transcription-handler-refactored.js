/**
 * Transcription Handler - Refactored with Modular Architecture
 * 
 * Handles:
 * - WebSocket connection to Speechmatics API
 * - Audio streaming and processing
 * - Transcription result handling
 * - Connection state management
 * - Error handling and recovery
 * 
 * Dependencies:
 * - APIClient: Network communication with retry logic
 * - EventEmitter: Inter-component communication
 * - StateManager: Connection and recording state
 * - NotificationSystem: User feedback
 * - SettingsManager: API configuration
 */

// ============================================================================
// CONFIGURATION & CONSTANTS
// ============================================================================

const TRANSCRIPTION_CONFIG = {
    // Audio configuration
    AUDIO: {
        SAMPLE_RATE: 16000,
        CHANNELS: 1,
        FRAME_SIZE: 1024,
    },

    // Speechmatics API
    API: {
        ENDPOINT: "wss://eu2.speechmatics.com/v1/streaming",
        MODEL: "conformer2",
        LANG: "en",
    },

    // Timeouts (ms)
    TIMEOUTS: {
        INITIAL_CONNECT: 5000,
        WS_RECONNECT: 3000,
        KEEP_ALIVE: 30000,
        INACTIVITY: 60000,
    },

    // Events
    EVENTS: {
        RECORDING_STARTED: "recording-started",
        RECORDING_STOPPED: "recording-stopped",
        TRANSCRIPTION_RECEIVED: "transcription-received",
        FINAL_TRANSCRIPT: "final-transcript",
        ERROR: "error",
    },
};

const SETTINGS_DEFAULTS = {
    authToken: "",
    apiKey: "",
    language: "en",
    debug: false,
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

// Connection and recording state
const connectionState = new StateManager("transcription", {
    connected: false,
    connecting: false,
    recording: false,
    lastError: null,
    errorCount: 0,
    connectionAttempts: 0,
});

// Audio stream state
const audioState = new StateManager("audio", {
    streamActive: false,
    processorAttached: false,
});

// Event emitter
const eventEmitter = new EventEmitter("transcription-handler");

// Settings
const settingsManager = new SettingsManager(SETTINGS_DEFAULTS);

// ============================================================================
// AUDIO HANDLING
// ============================================================================

let audioContext = null;
let mediaStream = null;
let audioProcessor = null;
let audioWorkletNode = null;
let muteGain = null;
let audioSource = null;

let audioWorkletLoadPromise = null;
function ensureAudioWorkletLoaded() {
    if (!audioContext?.audioWorklet) {
        return Promise.reject(new Error("AudioWorklet not supported"));
    }
    if (audioWorkletLoadPromise) {
        return audioWorkletLoadPromise;
    }
    const url = chrome.runtime.getURL("src/content/worklets/pcm16-downsampler.js");
    audioWorkletLoadPromise = audioContext.audioWorklet.addModule(url);
    return audioWorkletLoadPromise;
}

/**
 * Initialize audio context and media stream
 */
async function initializeAudioStream() {
    try {
        if (audioState.get("streamActive")) {
            return;
        }

        log("Initializing audio stream...");

        // Get microphone access
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                sampleRate: TRANSCRIPTION_CONFIG.AUDIO.SAMPLE_RATE,
                echoCancellation: true,
                noiseSuppression: true,
            },
        });

        // Create audio context
        audioContext = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: TRANSCRIPTION_CONFIG.AUDIO.SAMPLE_RATE,
        });

        // Create and attach processor
        await attachAudioProcessor();
        audioState.set("streamActive", true);

        log("Audio stream initialized");
        eventEmitter.emit(TRANSCRIPTION_CONFIG.EVENTS.RECORDING_STARTED);
        notifyUI("micStatus", { recording: true });
    } catch (error) {
        const errorType = error.name === "NotAllowedError" ? "permission" : "audio";
        handleError("Failed to initialize audio stream: " + error.message, errorType);
        throw error;
    }
}

/**
 * Attach audio processor to stream
 */
async function attachAudioProcessor() {
    if (audioState.get("processorAttached")) {
        return;
    }

    try {
        log("Attaching audio processor...");

        audioSource = audioContext.createMediaStreamSource(mediaStream);
        muteGain = audioContext.createGain();
        muteGain.gain.value = 0;

        const canUseWorklet =
            typeof AudioWorkletNode !== "undefined" &&
            !!audioContext.audioWorklet &&
            typeof audioContext.audioWorklet.addModule === "function";

        if (canUseWorklet) {
            try {
                await ensureAudioWorkletLoaded();
                audioWorkletNode = new AudioWorkletNode(audioContext, "pcm16-downsampler", {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [1],
                    processorOptions: {
                        targetSampleRate: TRANSCRIPTION_CONFIG.AUDIO.SAMPLE_RATE,
                        chunkSize: TRANSCRIPTION_CONFIG.AUDIO.FRAME_SIZE,
                    },
                });

                audioWorkletNode.port.onmessage = (event) => {
                    if (!connectionState.get("connected")) return;
                    const data = event?.data;
                    const buffer =
                        data instanceof ArrayBuffer
                            ? data
                            : data?.buffer instanceof ArrayBuffer
                              ? data.buffer
                              : null;
                    if (!buffer) return;
                    if (speechmaticsWS && speechmaticsWS.readyState === WebSocket.OPEN) {
                        speechmaticsWS.send(buffer);
                    }
                };

                audioSource.connect(audioWorkletNode);
                audioWorkletNode.connect(muteGain);
                muteGain.connect(audioContext.destination);

                audioState.set("processorAttached", true);
                log("AudioWorklet processor attached");
                return;
            } catch (error) {
                log("AudioWorklet init failed; falling back to ScriptProcessorNode:", error);
            }
        }

        // Fallback: ScriptProcessorNode (deprecated).
        audioProcessor = audioContext.createScriptProcessor(
            TRANSCRIPTION_CONFIG.AUDIO.FRAME_SIZE,
            1,
            1
        );
        audioProcessor.onaudioprocess = (event) => {
            handleAudioFrame(event.inputBuffer);
        };

        audioSource.connect(audioProcessor);
        audioProcessor.connect(muteGain);
        muteGain.connect(audioContext.destination);

        audioState.set("processorAttached", true);
        log("Audio processor attached");
    } catch (error) {
        handleError("Failed to attach audio processor: " + error.message, "audio");
        throw error;
    }
}

/**
 * Handle audio frame - send to WebSocket
 */
function handleAudioFrame(inputBuffer) {
    if (!connectionState.get("connected")) {
        return;
    }

    try {
        // Convert to PCM data
        const channelData = inputBuffer.getChannelData(0);
        const pcmData = new Int16Array(channelData.length);

        for (let i = 0; i < channelData.length; i++) {
            const s = Math.max(-1, Math.min(1, channelData[i]));
            pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        // Send to Speechmatics
        if (speechmaticsWS && speechmaticsWS.readyState === WebSocket.OPEN) {
            speechmaticsWS.send(pcmData);
        }
    } catch (error) {
        handleError("Error processing audio frame: " + error.message, "audio");
    }
}

/**
 * Stop audio stream
 */
function stopAudioStream() {
    try {
        if (audioWorkletNode) {
            try {
                audioWorkletNode.port.onmessage = null;
            } catch {
                // ignore
            }
            try {
                audioWorkletNode.disconnect();
            } catch {
                // ignore
            }
            audioWorkletNode = null;
        }
        if (audioProcessor) {
            audioProcessor.disconnect();
            audioProcessor.onaudioprocess = null;
            audioProcessor = null;
        }

        if (audioSource) {
            try {
                audioSource.disconnect();
            } catch {
                // ignore
            }
            audioSource = null;
        }

        if (muteGain) {
            try {
                muteGain.disconnect();
            } catch {
                // ignore
            }
            muteGain = null;
        }

        if (mediaStream) {
            mediaStream.getTracks().forEach((track) => {
                track.stop();
            });
            mediaStream = null;
        }

        audioState.set("streamActive", false);
        audioState.set("processorAttached", false);

        log("Audio stream stopped");
        eventEmitter.emit(TRANSCRIPTION_CONFIG.EVENTS.RECORDING_STOPPED);
    } catch (error) {
        console.error("[TranscriptionHandler] Error stopping audio:", error);
    }
}

// ============================================================================
// WEBSOCKET MANAGEMENT
// ============================================================================

let speechmaticsWS = null;
let keepAliveInterval = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;

/**
 * Connect to Speechmatics WebSocket
 */
async function connectWebSocket() {
    if (connectionState.get("connecting") || connectionState.get("connected")) {
        log("Connection already in progress or active");
        return;
    }

    connectionState.set("connecting", true);
    notifyUI("updateButtonState", { state: "connecting" });

    try {
        const settings = await settingsManager.load();

        if (!settings.authToken) {
            handleError("Speechmatics API token not configured", "config");
            return;
        }

        log("Connecting to Speechmatics WebSocket...");

        const wsURL = `${TRANSCRIPTION_CONFIG.API.ENDPOINT}?auth_token=${settings.authToken}`;

        speechmaticsWS = new WebSocket(wsURL);
        speechmaticsWS.binaryType = "arraybuffer";

        // Connection established
        speechmaticsWS.onopen = () => {
            handleWebSocketOpen();
        };

        // Messages received
        speechmaticsWS.onmessage = (event) => {
            handleWebSocketMessage(event);
        };

        // Errors
        speechmaticsWS.onerror = (event) => {
            handleWebSocketError(event);
        };

        // Closed
        speechmaticsWS.onclose = () => {
            handleWebSocketClose();
        };

        // Timeout handling
        setTimeout(() => {
            if (connectionState.get("connecting")) {
                handleError("WebSocket connection timeout", "connection");
                if (speechmaticsWS) {
                    speechmaticsWS.close();
                }
            }
        }, TRANSCRIPTION_CONFIG.TIMEOUTS.INITIAL_CONNECT);
    } catch (error) {
        handleError("Failed to connect WebSocket: " + error.message, "connection");
        connectionState.set("connecting", false);
        notifyUI("updateButtonState", { state: "error" });
    }
}

/**
 * Handle WebSocket open event
 */
function handleWebSocketOpen() {
    log("WebSocket connected");

    connectionState.set("connecting", false);
    connectionState.set("connected", true);
    connectionState.set("connectionAttempts", 0);
    reconnectAttempts = 0;

    // Send initial configuration
    sendWebSocketMessage({
        type: "StartRecognition",
        transcription_config: {
            language: TRANSCRIPTION_CONFIG.API.LANG,
            operating_point: "standard",
            additional_vocab: [],
        },
    });

    // Start keep-alive
    startKeepAlive();

    // Notify UI
    NotificationSystem.showSuccess("Connected to Speechmatics");
    notifyUI("connectionStatus", { status: "connected" });
    eventEmitter.emit("connected");

    // Initialize audio
    initializeAudioStream().catch((error) => {
        log("Failed to initialize audio:", error);
    });
}

/**
 * Handle WebSocket message
 */
function handleWebSocketMessage(event) {
    try {
        const message = JSON.parse(event.data);

        switch (message.type) {
            case "Recognition":
                handleRecognitionMessage(message);
                break;

            case "RecognitionStarted":
                log("Recognition started");
                connectionState.set("recording", true);
                notifyUI("micStatus", { recording: true });
                break;

            case "RecognitionStopped":
                log("Recognition stopped");
                connectionState.set("recording", false);
                notifyUI("micStatus", { recording: false });
                break;

            case "Error":
                handleWebSocketErrorMessage(message);
                break;

            default:
                log("Unknown message type:", message.type);
        }
    } catch (error) {
        handleError("Error parsing WebSocket message: " + error.message, "message");
    }
}

/**
 * Handle recognition results
 */
function handleRecognitionMessage(message) {
    const { results } = message;

    if (!results || results.length === 0) {
        return;
    }

    // Process results
    results.forEach((result) => {
        const transcript = result.transcript || "";
        const isFinal = result.is_final === true;

        if (!transcript) return;

        if (isFinal) {
            // Final transcription
            log("Final transcript:", transcript);
            eventEmitter.emit(TRANSCRIPTION_CONFIG.EVENTS.FINAL_TRANSCRIPT, {
                text: transcript,
                confidence: result.confidence,
            });
            notifyUI("insertTranscription", { text: transcript, autoEnter: false });
        } else {
            // Partial transcription
            log("Partial transcript:", transcript);
            eventEmitter.emit(TRANSCRIPTION_CONFIG.EVENTS.TRANSCRIPTION_RECEIVED, {
                text: transcript,
                isPartial: true,
            });
            notifyUI("updateTranscription", { text: transcript, isPartial: true });
        }
    });
}

/**
 * Handle error message from Speechmatics
 */
function handleWebSocketErrorMessage(message) {
    const errorMsg = message.error || "Unknown error";
    log("Speechmatics error:", errorMsg);
    handleError(errorMsg, "speechmatics");
}

/**
 * Send message to Speechmatics
 */
function sendWebSocketMessage(message) {
    if (!speechmaticsWS || speechmaticsWS.readyState !== WebSocket.OPEN) {
        log("WebSocket not connected, cannot send message");
        return;
    }

    try {
        const data = JSON.stringify(message);
        speechmaticsWS.send(data);
        log("WebSocket message sent:", message.type);
    } catch (error) {
        handleError("Failed to send WebSocket message: " + error.message, "connection");
    }
}

/**
 * Handle WebSocket error
 */
function handleWebSocketError(event) {
    log("WebSocket error:", event);
    handleError("WebSocket error - check connection", "connection");
}

/**
 * Handle WebSocket close
 */
function handleWebSocketClose() {
    log("WebSocket closed");

    connectionState.set("connected", false);
    connectionState.set("recording", false);
    stopAudioStream();
    stopKeepAlive();

    // Attempt reconnection
    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        reconnectAttempts++;
        log(`Attempting reconnection (${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);
        setTimeout(() => {
            connectWebSocket();
        }, TRANSCRIPTION_CONFIG.TIMEOUTS.WS_RECONNECT);
    } else {
        notifyUI("connectionStatus", { status: "disconnected" });
        handleError("Max reconnection attempts reached", "connection");
    }
}

/**
 * Keep-alive mechanism
 */
function startKeepAlive() {
    stopKeepAlive();

    keepAliveInterval = setInterval(() => {
        if (connectionState.get("connected")) {
            sendWebSocketMessage({ type: "Ping" });
        }
    }, TRANSCRIPTION_CONFIG.TIMEOUTS.KEEP_ALIVE);

    log("Keep-alive started");
}

/**
 * Stop keep-alive
 */
function stopKeepAlive() {
    if (keepAliveInterval) {
        clearInterval(keepAliveInterval);
        keepAliveInterval = null;
        log("Keep-alive stopped");
    }
}

/**
 * Close WebSocket connection
 */
function closeWebSocket() {
    if (speechmaticsWS) {
        const state = speechmaticsWS.readyState;
        if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
            speechmaticsWS.close();
        }
        speechmaticsWS = null;
    }

    stopKeepAlive();
    stopAudioStream();
    connectionState.set("connected", false);
    connectionState.set("recording", false);
    log("WebSocket closed");
}

// ============================================================================
// ERROR HANDLING
// ============================================================================

/**
 * Handle errors with appropriate notifications and state updates
 */
function handleError(message, errorType = "unknown") {
    log("Error:", message, "Type:", errorType);

    const errorCount = connectionState.get("errorCount");
    connectionState.set("errorCount", errorCount + 1);
    connectionState.set("lastError", message);

    NotificationSystem.showError(message);
    notifyUI("showError", { message, errorType });

    eventEmitter.emit(TRANSCRIPTION_CONFIG.EVENTS.ERROR, {
        message,
        type: errorType,
        timestamp: new Date().toISOString(),
    });

    // Set button state based on error type
    const buttonState = errorType === "permission" ? "error" : "error";
    notifyUI("updateButtonState", { state: buttonState });
}

// ============================================================================
// RECORDING CONTROL
// ============================================================================

/**
 * Start recording
 */
async function startRecording() {
    try {
        if (connectionState.get("recording")) {
            log("Already recording");
            return;
        }

        if (!connectionState.get("connected")) {
            log("Not connected, connecting first...");
            await connectWebSocket();
        }

        // Send start recognition
        sendWebSocketMessage({
            type: "StartRecognition",
            transcription_config: {
                language: TRANSCRIPTION_CONFIG.API.LANG,
                operating_point: "standard",
            },
        });

        connectionState.set("recording", true);
        NotificationSystem.showSuccess("Recording started");
        log("Recording started");
        eventEmitter.emit(TRANSCRIPTION_CONFIG.EVENTS.RECORDING_STARTED);
    } catch (error) {
        handleError("Failed to start recording: " + error.message, "recording");
    }
}

/**
 * Stop recording
 */
async function stopRecording() {
    try {
        if (!connectionState.get("recording")) {
            log("Not currently recording");
            return;
        }

        // Send stop recognition
        sendWebSocketMessage({ type: "StopRecognition" });

        connectionState.set("recording", false);
        NotificationSystem.showStatus("Recording stopped");
        log("Recording stopped");
        eventEmitter.emit(TRANSCRIPTION_CONFIG.EVENTS.RECORDING_STOPPED);
    } catch (error) {
        handleError("Error stopping recording: " + error.message, "recording");
    }
}

/**
 * Toggle recording
 */
async function toggleRecording() {
    const isRecording = connectionState.get("recording");

    if (isRecording) {
        await stopRecording();
    } else {
        await startRecording();
    }
}

// ============================================================================
// NOTIFICATION TO UI
// ============================================================================

/**
 * Send message to ChatGPT content script
 */
function notifyUI(type, data) {
    try {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs.length === 0) {
                return;
            }

            tabs.forEach((tab) => {
                chrome.tabs.sendMessage(
                    tab.id,
                    { type, ...data },
                    (response) => {
                        // Response optional
                    }
                ).catch(() => {
                    // Ignore errors if tab not responding
                });
            });
        });
    } catch (error) {
        log("Failed to notify UI:", error);
    }
}

// ============================================================================
// MESSAGE HANDLING
// ============================================================================

/**
 * Handle incoming messages
 */
chrome.runtime.onMessage.addListener((request) => {
    if (!request) return;

    switch (request.type) {
        case "toggleRecording":
            toggleRecording().catch((error) => {
                log("Error toggling recording:", error);
            });
            break;

        case "startRecording":
            startRecording().catch((error) => {
                log("Error starting recording:", error);
            });
            break;

        case "stopRecording":
            stopRecording().catch((error) => {
                log("Error stopping recording:", error);
            });
            break;

        case "getConnectionStatus":
            return Promise.resolve({
                connected: connectionState.get("connected"),
                recording: connectionState.get("recording"),
            });

        case "getSettings":
            return settingsManager.load();

        case "setSettings":
            Object.entries(request.settings || {}).forEach(([key, value]) => {
                settingsManager.set(key, value);
            });
            eventEmitter.emit("settings-changed", { settings: request.settings });
            break;

        case "disconnect":
            closeWebSocket();
            break;
    }
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
        console.log("[TranscriptionHandler]", ...args);
    }
}

/**
 * Initialize transcription handler
 */
async function initialize() {
    try {
        log("Initializing transcription handler...");

        // Load settings
        await settingsManager.load();

        // Setup event subscriptions
        connectionState.subscribe("connected", (connected) => {
            log("Connection status:", connected);
        });

        connectionState.subscribe("recording", (recording) => {
            log("Recording status:", recording);
        });

        // Auto-connect on startup if configured
        const settings = await settingsManager.load();
        if (settings.authToken && settings.autoConnect) {
            setTimeout(() => {
                connectWebSocket();
            }, 2000);
        }

        log("Transcription handler initialized");
    } catch (error) {
        console.error("[TranscriptionHandler] Initialization error:", error);
    }
}

// Initialize on load
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initialize);
} else {
    initialize();
}

// ============================================================================
// PUBLIC API
// ============================================================================

const SpeechmasticsTranscriber = {
    initialize,
    connectWebSocket,
    closeWebSocket,
    startRecording,
    stopRecording,
    toggleRecording,
    connectionState,
    audioState,
    eventEmitter,
    settingsManager,
};
