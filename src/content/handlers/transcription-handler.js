(() => {
if (window.__testExtTranscriberLoaded) {
    return;
}
window.__testExtTranscriberLoaded = true;

// Debug marker to confirm the extension content scripts are running on this page.
try {
    document.documentElement?.setAttribute("data-test-ext", "loaded");
} catch {
    // ignore
}

/**
 * Speechmatics Real-time Transcription Handler
 * Implements WebSocket API for real-time speech-to-text
 * Reference: https://docs.speechmatics.com/api-ref/realtime-transcription-websocket
 */

const SpeechmasticsTranscriber = (() => {
    const WEBSOCKET_URL = "wss://eu.rt.speechmatics.com/v2";
    const TARGET_SAMPLE_RATE = 16000;
    let sessionId = 0;
    // Guards against late WebSocket events from a previous connection instance.
    // Each (re)connect increments the epoch; message handlers ignore stale epochs.
    let messageEpoch = 0;
    let activeMessageEpoch = 0;

    // Settings
    const SETTINGS_DEFAULTS = {
        transcriptionMode: "timer", // "timer" or "manual"
        autoSubmitDelayMs: 500,
        appendMode: true,
        autoEnterAfterSubmit: true,
        autoSubmitMessage: false,
        showPartialTranscript: true,
        debug: false,
    };

    // Legacy key (older versions stored apiKey in sync).
    const SYNC_KEYS = { ...SETTINGS_DEFAULTS, apiKey: null, speechmaticsApiKey: null };

    // State
    let settings = { ...SETTINGS_DEFAULTS };
    let ws = null;
    let isRecording = false;
    // Accumulates *finalized* transcript chunks (AddTranscript).
    // We stream these to the ChatGPT UI as they arrive so the textbox doesn't "rewind"
    // when partial hypotheses change.
    let currentTranscript = "";
    let currentPartial = "";
    let mediaStream = null;
    let audioContext = null;
    let audioSource = null;
    let audioProcessor = null; // ScriptProcessorNode
    let audioWorkletNode = null; // AudioWorkletNode
    let muteGain = null;
    let lastSpeechTime = 0;
    let silenceTimeout = null;
    let lastSeqNo = -1;
    // Speechmatics' schema expectations can vary by endpoint/version.
    // We keep multiple payload variants and retry within a session.
    // 0 = minimal { encoding, sample_rate }
    // 1 = explicit { type: "raw", encoding, sample_rate, channels }
    // 2 = explicit { type: "raw", encoding, sample_rate } (no channels)
    let startConfigVariant = 2;
    let startConfigTried = new Set();
    let retryingStartConfig = false;
    let resetInProgress = false;
    let spacebarPushToTalkActive = false;

    // Temporary key caching (browser WS can't set Authorization headers).
    let cachedTempKey = null;
    let cachedTempKeyExpiresAt = 0;
    const TEMP_KEY_TTL_SECONDS = 600; // 10 minutes

    // Logging
    function log(...args) {
        if (settings.debug) {
            console.log("[SpeechmasticsTranscriber]", ...args);
        }
    }

    // Load settings from chrome storage
    function loadSettings() {
        return new Promise((resolve) => {
            chrome.storage.sync.get(SYNC_KEYS, (items) => {
                const base = { ...SETTINGS_DEFAULTS, ...items };

                // API key: prefer sync (more reliable across incognito split modes),
                // then fall back to local cache.
                chrome.storage.sync.get({ speechmaticsApiKey: null, apiKey: null }, (syncKeys) => {
                    const fromSync = syncKeys?.speechmaticsApiKey || syncKeys?.apiKey || null;
                    chrome.storage.local.get({ apiKey: null }, (localItems) => {
                        const fromLocal = localItems?.apiKey || null;
                        const apiKey = fromSync || fromLocal;

                        // Best-effort hydrate local cache.
                        if (apiKey && apiKey !== fromLocal) {
                            try {
                                chrome.storage.local.set({ apiKey });
                            } catch {
                                // ignore
                            }
                        }

                        base.apiKey = apiKey;

                        settings = base;
                        log("Settings loaded:", settings);
                        resolve(settings);
                    });
                });
            });
        });
    }

    // Initialize audio context and get microphone access
    async function initializeAudio() {
        try {
            if (!mediaStream) {
                mediaStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true,
                    },
                });
            }

            if (!audioContext) {
                audioContext = new (window.AudioContext || window.webkitAudioContext)({
                    latencyHint: "interactive",
                });
            }

            log("Audio initialized");
            return true;
        } catch (error) {
            log("Audio initialization error:", error);
            notifyError("Microphone access denied. Please check permissions.", "permission");
            return false;
        }
    }

    function nowMs() {
        return Date.now();
    }

    async function getTempKey() {
        // Refresh temp key slightly before expiry.
        if (cachedTempKey && cachedTempKeyExpiresAt - nowMs() > 30_000) {
            return cachedTempKey;
        }

        const resp = await new Promise((resolve) => {
            chrome.runtime.sendMessage(
                { eventType: "getSpeechmaticsTempKey", ttlSeconds: TEMP_KEY_TTL_SECONDS },
                (r) => resolve(r)
            );
        });

        if (!resp || resp.ok !== true) {
            const status = resp?.status;
            const body = resp?.body;
            const error = resp?.error || "UNKNOWN";

            if (error === "API_KEY_MISSING") {
                throw new Error("API key not configured");
            }

            const details = status ? ` (HTTP ${status})` : "";
            throw new Error(`Failed to obtain Speechmatics temp key${details}`);
        }

        cachedTempKey = resp.tempKey;
        cachedTempKeyExpiresAt = nowMs() + (Number(resp.ttlSeconds) || TEMP_KEY_TTL_SECONDS) * 1000;
        return cachedTempKey;
    }

    // Connect to Speechmatics WebSocket
    async function connectWebSocket() {
        try {
            const jwt = await getTempKey();
            const url = `${WEBSOCKET_URL}?jwt=${encodeURIComponent(jwt)}`;

            return new Promise((resolve, reject) => {
                const myEpoch = ++messageEpoch;
                activeMessageEpoch = myEpoch;

                ws = new WebSocket(url);

                ws.onopen = () => {
                    if (myEpoch !== activeMessageEpoch) return;
                    log("WebSocket connected");
                    lastSeqNo = -1;
                    sendStartRecognition();
                    resolve();
                };

                ws.onmessage = (event) => {
                    if (myEpoch !== activeMessageEpoch) return;
                    handleMessage(event.data);
                };

                ws.onerror = (error) => {
                    if (myEpoch !== activeMessageEpoch) return;
                    log("WebSocket error:", error);
                    notifyError("Transcription service error. Please try again.", "connection");
                    reject(error);
                };

                ws.onclose = () => {
                    if (myEpoch !== activeMessageEpoch) return;
                    log("WebSocket closed");
                    ws = null;
                };

                setTimeout(() => {
                    if (myEpoch !== activeMessageEpoch) return;
                    if (ws && ws.readyState === WebSocket.CONNECTING) {
                        reject(new Error("WebSocket connection timeout"));
                    }
                }, 10000);
            });
        } catch (error) {
            log("Connection error:", error);
            if (error.message.includes("API key")) {
                notifyError("API key not configured. Please set it in settings.", "error");
            } else if (error.message.includes("Failed to obtain Speechmatics temp key")) {
                notifyError(error.message, "error");
            } else if (error.message.includes("timeout")) {
                notifyError("Connection timeout. Please try again.", "timeout");
            } else {
                notifyError("Failed to connect to Speechmatics. Please try again.", "connection");
            }
            throw error;
        }
    }

    function buildStartRecognitionConfig() {
        // Speechmatics has evolved the `audio_format` schema over time. Some versions accept a
        // minimal object (encoding + sample_rate), others want `type: "raw"` + `channels`.
        // Some reject `channels` entirely. We keep multiple variants and can cycle if rejected.
        const audio_format =
            startConfigVariant === 1
                ? {
                      type: "raw",
                      encoding: "pcm_s16le",
                      sample_rate: TARGET_SAMPLE_RATE,
                      channels: 1,
                  }
                : startConfigVariant === 2
                  ? {
                        type: "raw",
                        encoding: "pcm_s16le",
                        sample_rate: TARGET_SAMPLE_RATE,
                    }
                : {
                      encoding: "pcm_s16le",
                      sample_rate: TARGET_SAMPLE_RATE,
                  };

        return {
            message: "StartRecognition",
            audio_format,
            transcription_config: {
                language: "en",
                // Speechmatics currently supports: "standard" | "enhanced"
                operating_point: "enhanced",
                enable_partials: true,
            },
        };
    }

    // Send StartRecognition message
    function sendStartRecognition() {
        const config = buildStartRecognitionConfig();

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(config));
            log("StartRecognition sent (variant)", startConfigVariant);
            try {
                startConfigTried.add(startConfigVariant);
            } catch {
                // ignore
            }
        }
    }

    function nextStartConfigVariant() {
        // Try the most compatible options first.
        const order = [2, 0, 1];
        for (const v of order) {
            if (!startConfigTried.has(v)) return v;
        }
        return null;
    }

    async function retryWithNextStartConfigVariant(reason) {
        if (retryingStartConfig) return;
        const next = nextStartConfigVariant();
        if (next === null) {
            notifyError(
                `Transcription error: incompatible config (tried variants ${Array.from(startConfigTried).join(
                    ", "
                )}). ${reason}`,
                "error"
            );
            stopRecording();
            return;
        }

        retryingStartConfig = true;
        const prev = startConfigVariant;
        startConfigVariant = next;
        notifyError(
            `Transcription error: incompatible config (variant ${prev}). Retrying with variant ${next}...`,
            "error"
        );

        try {
            await closeWebSocket();
            await connectWebSocket();
        } catch (err) {
            log("Retry with alternate config failed:", err);
            stopRecording();
        } finally {
            retryingStartConfig = false;
        }
    }

    // Handle incoming WebSocket messages
    function handleMessage(data) {
        try {
            const message = JSON.parse(data);
            log("Message received:", message.message);

            if (message.message === "AddPartialTranscript") {
                handlePartialTranscript(message);
            } else if (message.message === "AddTranscript") {
                handleFinalTranscript(message);
            } else if (message.message === "AudioAdded") {
                // Keep track of last seen seq_no for EndOfStream.
                if (typeof message.seq_no === "number") {
                    lastSeqNo = message.seq_no;
                }
            } else if (message.message === "Error") {
                log("Server error:", message.reason);
                const reason = message.reason || "Unknown error";
                if (String(reason).toLowerCase().includes("not authorized")) {
                    notifyError("Transcription error: Not Authorized (check API key)", "error");
                } else if (
                    String(reason).toLowerCase().includes("invalid input") ||
                    String(reason).toLowerCase().includes("must validate one and only one schema") ||
                    String(reason).toLowerCase().includes("oneof")
                ) {
                    retryWithNextStartConfigVariant(reason);
                } else {
                    notifyError(`Transcription error: ${reason}`, "error");
                }
            } else if (message.message === "EndOfUtterance") {
                handleEndOfUtterance();
            } else if (message.message === "RecognitionStarted") {
                log("Recognition started");
            }
        } catch (error) {
            log("Message parsing error:", error);
        }
    }

    // Handle partial transcript (real-time updates)
    function handlePartialTranscript(message) {
        // Per Speechmatics docs, transcript text is in `metadata.transcript`.
        const transcript =
            typeof message?.metadata?.transcript === "string"
                ? message.metadata.transcript
                : typeof message?.transcript === "string"
                  ? message.transcript
                : message?.results && message.results.length
                  ? (() => {
                        let partialText = "";
                        for (const result of message.results) {
                            if (
                                result.type === "word" &&
                                result.alternatives &&
                                result.alternatives[0]
                            ) {
                                partialText += result.alternatives[0].content + " ";
                            }
                        }
                        return partialText.trim();
                    })()
                  : "";

        if (transcript && transcript.trim()) {
            lastSpeechTime = Date.now();
            currentPartial = transcript;
            notifyPartialTranscription(transcript);
        }
    }

    // Handle final transcript
    function handleFinalTranscript(message) {
        // Per Speechmatics docs, transcript text is in `metadata.transcript`.
        const transcript =
            typeof message?.metadata?.transcript === "string"
                ? message.metadata.transcript
                : typeof message?.transcript === "string"
                  ? message.transcript
                : message?.results && message.results.length
                  ? (() => {
                        let finalText = "";
                        for (const result of message.results) {
                            if (
                                result.type === "word" &&
                                result.alternatives &&
                                result.alternatives[0]
                            ) {
                                finalText += result.alternatives[0].content + " ";
                            }
                        }
                        return finalText.trim();
                    })()
                  : "";

        if (transcript && transcript.trim()) {
            // `transcript` is already formatted for concatenation (spacing/punctuation)
            // per Speechmatics' WS protocol.
            currentTranscript += transcript;
            currentPartial = "";
            lastSpeechTime = Date.now();
            log("Final text received:", transcript.trim());

            // Commit finalized words into the ChatGPT textbox immediately so that later partials
            // don't overwrite earlier speech.
            notifyCommittedTranscription(transcript);
            // Clear partial overlay in UI.
            notifyPartialTranscription("");
        }
    }

    // Handle end of utterance (silence detected)
    function handleEndOfUtterance() {
        log("End of utterance detected");
        lastSpeechTime = Date.now();

        // Clear existing timeout
        if (silenceTimeout) {
            clearTimeout(silenceTimeout);
        }

        // Auto-submit if in timer mode
        if (isRecording && settings.transcriptionMode === "timer") {
            silenceTimeout = setTimeout(() => {
                if (isRecording) {
                    stopRecording();
                }
            }, settings.autoSubmitDelayMs);
        }
    }

    function floatTo16BitPCM(f32) {
        const out = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
            let s = Math.max(-1, Math.min(1, f32[i]));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
    }

    // Simple downsampler for speech: averages samples within each output frame.
    function downsampleTo16kHz(input, inputSampleRate) {
        if (!input || input.length === 0) return new Int16Array(0);
        if (inputSampleRate === TARGET_SAMPLE_RATE) {
            return floatTo16BitPCM(input);
        }
        const ratio = inputSampleRate / TARGET_SAMPLE_RATE;
        const newLength = Math.max(1, Math.round(input.length / ratio));
        const result = new Int16Array(newLength);

        let offsetBuffer = 0;
        for (let i = 0; i < newLength; i++) {
            const nextOffsetBuffer = Math.round((i + 1) * ratio);
            let sum = 0;
            let count = 0;
            for (let j = offsetBuffer; j < nextOffsetBuffer && j < input.length; j++) {
                sum += input[j];
                count++;
            }
            offsetBuffer = nextOffsetBuffer;
            const avg = count ? sum / count : 0;
            const s = Math.max(-1, Math.min(1, avg));
            result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        return result;
    }

    function sendPcmChunk(int16Array) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!int16Array || int16Array.length === 0) return;
        try {
            ws.send(int16Array.buffer);
        } catch (error) {
            log("Error sending audio:", error);
        }
    }

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

    function sendPcmBuffer(buffer) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!buffer || !(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return;
        try {
            ws.send(buffer);
        } catch (error) {
            log("Error sending audio buffer:", error);
        }
    }

    async function startAudioStreaming() {
        if (!audioContext || !mediaStream) return;
        if (audioSource || audioProcessor || audioWorkletNode) return;

        audioSource = audioContext.createMediaStreamSource(mediaStream);

        muteGain = audioContext.createGain();
        muteGain.gain.value = 0;

        // Prefer AudioWorkletNode (ScriptProcessorNode is deprecated and logs warnings).
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
                        targetSampleRate: TARGET_SAMPLE_RATE,
                        chunkSize: 4096,
                    },
                });

                audioWorkletNode.port.onmessage = (event) => {
                    if (!isRecording) return;
                    if (!ws || ws.readyState !== WebSocket.OPEN) return;
                    const data = event?.data;
                    // The processor posts an ArrayBuffer as the message payload.
                    if (data instanceof ArrayBuffer) {
                        sendPcmBuffer(data);
                    } else if (data?.buffer instanceof ArrayBuffer) {
                        sendPcmBuffer(data.buffer);
                    }
                };

                audioSource.connect(audioWorkletNode);
                audioWorkletNode.connect(muteGain);
                muteGain.connect(audioContext.destination);
                return;
            } catch (error) {
                log("AudioWorklet init failed; falling back to ScriptProcessorNode:", error);
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
            }
        }

        // Fallback: ScriptProcessorNode (deprecated, but keeps older browsers working).
        const bufferSize = 4096;
        audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
        audioProcessor.onaudioprocess = (event) => {
            if (!isRecording) return;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;

            const input = event.inputBuffer.getChannelData(0);
            const pcm16 = downsampleTo16kHz(input, audioContext.sampleRate);
            sendPcmChunk(pcm16);
        };

        audioSource.connect(audioProcessor);
        audioProcessor.connect(muteGain);
        muteGain.connect(audioContext.destination);
    }

    function stopAudioStreaming() {
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
            try {
                audioProcessor.disconnect();
            } catch {
                // ignore
            }
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
    }

    // Start recording
    async function startRecording() {
        if (isRecording) return;

        try {
            // Reload settings in case they changed
            await loadSettings();

            // Initialize audio
            const audioOk = await initializeAudio();
            if (!audioOk) return;

            // Connect to WebSocket
            await connectWebSocket();

            isRecording = true;
            sessionId++;
            currentTranscript = "";
            currentPartial = "";
            lastSpeechTime = Date.now();
            retryingStartConfig = false;
            startConfigTried = new Set();
            // Default to the most explicit-but-permissive schema first.
            startConfigVariant = 2;

            // Start raw PCM streaming to Speechmatics.
            await startAudioStreaming();

            // Notify UI
            notifyMicStatus(true);
            log("Recording started");
        } catch (error) {
            log("Start recording error:", error);
            isRecording = false;
            notifyMicStatus(false);
            await closeWebSocket();
        }
    }

    // Stop recording
    async function stopRecording() {
        return stopRecordingWithOptions();
    }

    async function stopRecordingWithOptions({ forceAutoEnter = false } = {}) {
        if (!isRecording) return;

        isRecording = false;
        spacebarPushToTalkActive = false;
        // Capture before we clear buffers.
        const shouldForceAutoEnter = Boolean(forceAutoEnter);

        stopAudioStreaming();

        // Clear timeouts
        if (silenceTimeout) {
            clearTimeout(silenceTimeout);
        }

        // Close WebSocket
        await closeWebSocket();

        // Notify UI
        notifyMicStatus(false);

        // Finalize session: UI already received committed chunks in real-time.
        // This event is used to (optionally) auto-send the ChatGPT message and clear the partial overlay.
        // Safety: if Speechmatics didn't emit an AddTranscript for the last utterance yet,
        // fall back to committing the last partial so we don't lose text.
        if ((!currentTranscript || !currentTranscript.trim()) && currentPartial && currentPartial.trim()) {
            currentTranscript += currentPartial;
            notifyCommittedTranscription(currentPartial);
            notifyPartialTranscription("");
        }

        if ((currentTranscript && currentTranscript.trim()) || (currentPartial && currentPartial.trim())) {
            notifyFinalizeTranscription({ forceAutoEnter: shouldForceAutoEnter });
        }
        currentTranscript = "";
        currentPartial = "";

        log("Recording stopped");
    }

    // Close WebSocket connection
    function closeWebSocket() {
        return new Promise((resolve) => {
            if (ws) {
                // Invalidate any in-flight callbacks from this socket immediately.
                activeMessageEpoch = ++messageEpoch;

                const timeout = setTimeout(() => {
                    if (ws) {
                        ws.close();
                        ws = null;
                    }
                    resolve();
                }, 1000);

                ws.onclose = () => {
                    clearTimeout(timeout);
                    resolve();
                };

                // Send EndOfStream if still connected
                if (ws.readyState === WebSocket.OPEN) {
                    // Speechmatics expects last_seq_no to match the last AudioAdded seq_no.
                    const eos = {
                        message: "EndOfStream",
                        last_seq_no: lastSeqNo >= 0 ? lastSeqNo : 0,
                    };
                    ws.send(JSON.stringify(eos));
                }
            } else {
                resolve();
            }
        });
    }

    // Emit events to the ChatGPT content script (same tab). This avoids relying on a
    // Speechmatics portal tab or extension-only APIs from a content script.
    function emitToChatGpt(detail) {
        try {
            if (detail && typeof detail === "object" && detail.sessionId == null) {
                detail.sessionId = sessionId;
            }
            window.dispatchEvent(
                new CustomEvent("__testExtTranscriber", { detail })
            );
        } catch (error) {
            log("Failed to emit event:", error);
        }
    }

    // Submit transcription to ChatGPT
    function submitTranscription(text) {
        if (!text.trim()) return;

        emitToChatGpt({
            type: "insertTranscription",
            text: text.trim(),
            autoEnter: settings.autoEnterAfterSubmit,
        });

        currentTranscript = "";
    }

    // Setup keyboard listener
    function setupKeyboardListener() {
        function isChatGptPromptContext(el) {
            if (!el || !(el instanceof HTMLElement)) {
                return false;
            }
            if (el.id === "prompt-textarea") {
                return true;
            }
            try {
                return Boolean(el.closest?.("#prompt-textarea"));
            } catch {
                return false;
            }
        }

        function isEditableElement(el) {
            if (!el || el === document.body || el === document.documentElement) {
                return false;
            }
            const tag = (el.tagName || "").toUpperCase();
            if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
                return true;
            }
            if (el.isContentEditable) {
                return true;
            }
            // Some UIs use role=textbox for custom editors.
            const role =
                typeof el.getAttribute === "function" ? el.getAttribute("role") : null;
            if (role === "textbox") {
                return true;
            }
            return false;
        }

        function shouldHandleSpacebar(event) {
            if (!event || event.defaultPrevented) {
                return false;
            }
            if (event.ctrlKey || event.metaKey || event.altKey) {
                return false;
            }
            if (event.repeat) {
                return false;
            }

            // If the user is focused in any editable field (ChatGPT prompt, search, etc),
            // Space must behave normally.
            const active = document.activeElement;
            if (isEditableElement(active) && !isChatGptPromptContext(active)) {
                return false;
            }
            if (isEditableElement(event.target) && !isChatGptPromptContext(event.target)) {
                return false;
            }

            return true;
        }

        document.addEventListener("keydown", (event) => {
            if (event.code === "Space" && !isRecording && shouldHandleSpacebar(event)) {
                event.preventDefault(); // avoid page scroll when starting push-to-talk
                spacebarPushToTalkActive = true;
                startRecording();
            }
        });

        document.addEventListener("keyup", (event) => {
            if (
                event.code === "Space" &&
                isRecording &&
                spacebarPushToTalkActive &&
                shouldHandleSpacebar(event)
            ) {
                event.preventDefault();
                spacebarPushToTalkActive = false;
                stopRecordingWithOptions({ forceAutoEnter: true });
            } else if (event.code === "Space") {
                // If the user released Space without us owning the session, clear the flag.
                spacebarPushToTalkActive = false;
            }
        });

        log("Keyboard listener setup");
    }

    // Notification functions
    function notifyPartialTranscription(text) {
        emitToChatGpt({
            type: "updateTranscription",
            text,
            isPartial: true,
        });
    }

    function notifyCommittedTranscription(text) {
        emitToChatGpt({
            type: "appendCommittedTranscript",
            text,
        });
    }

    function notifyFinalizeTranscription({ forceAutoEnter = false } = {}) {
        emitToChatGpt({
            type: "finalizeTranscription",
            autoEnter: Boolean(forceAutoEnter) || settings.autoEnterAfterSubmit,
        });
    }

    function notifyMicStatus(recording) {
        emitToChatGpt({
            type: "micStatus",
            recording,
        });
    }

    function notifyConnectionStatus(status) {
        emitToChatGpt({
            type: "connectionStatus",
            status,
        });
    }

    function notifyError(message, type = "error") {
        emitToChatGpt({
            type: "showError",
            message,
            errorType: type,
        });

        if (type === "connection" || type === "timeout") {
            emitToChatGpt({
                type: "updateButtonState",
                state: "error",
            });
        }
    }

    // Initialize
    function init() {
        log("Initializing SpeechmasticsTranscriber");
        loadSettings();
        setupKeyboardListener();

        // Listen for UI-driven resets (e.g., user pressed Send while still recording).
        // This resets our accumulated transcript buffers so the next message starts clean.
        try {
            if (!window.__testExtChatUiListenerInstalled) {
                window.__testExtChatUiListenerInstalled = true;
                window.addEventListener("__testExtChatUi", (event) => {
                    const detail = event?.detail;
                    if (!detail || detail.type !== "resetSession") return;

                    // If we're still recording, do a fast reconnect so the server-side transcript
                    // context resets too. This avoids "previous message bleeding into next message".
                    (async () => {
                        if (resetInProgress) return;
                        resetInProgress = true;
                        try {
                            // New logical session so the UI can ignore late events (if any).
                            sessionId++;
                            currentTranscript = "";
                            currentPartial = "";
                            lastSpeechTime = Date.now();
                            if (silenceTimeout) {
                                try {
                                    clearTimeout(silenceTimeout);
                                } catch {
                                    // ignore
                                }
                                silenceTimeout = null;
                            }

                            if (isRecording) {
                                notifyConnectionStatus("connecting");
                                // Reset config retry state for the new session.
                                retryingStartConfig = false;
                                startConfigTried = new Set();
                                startConfigVariant = 2;

                                await closeWebSocket();
                                await connectWebSocket();
                                notifyConnectionStatus("connected");
                            }

                            log("Session reset requested by UI");
                        } catch (err) {
                            log("Session reset failed:", err);
                            notifyConnectionStatus("error");
                        } finally {
                            resetInProgress = false;
                        }
                    })();
                });
            }
        } catch {
            // ignore
        }

        // Keep settings hot-reloaded while the tab stays open (important for apiKey).
        chrome.storage.onChanged.addListener((changes, areaName) => {
            if (areaName === "sync") {
                Object.keys(changes).forEach((key) => {
                    settings[key] = changes[key].newValue;
                });
                if (changes.speechmaticsApiKey) settings.apiKey = changes.speechmaticsApiKey.newValue || null;
                if (changes.apiKey) settings.apiKey = changes.apiKey.newValue || null;
            }
            if (areaName === "local" && changes.apiKey) {
                settings.apiKey = changes.apiKey.newValue || null;
            }
        });
    }

    // Public API
    return {
        init,
        isRecording: () => isRecording,
        toggleRecording: async () => {
            if (isRecording) {
                await stopRecording();
            } else {
                await startRecording();
            }
            return isRecording;
        },
        getState: () => ({
            isRecording,
            currentTranscript,
            hasApiKey: !!settings.apiKey,
        }),
    };
})();

// Expose a small API for the ChatGPT UI content script to call (same isolated world).
// Without this, the UI script can't toggle recording because the transcriber is scoped
// inside this file's IIFE.
try {
    window.SpeechmasticsTranscriber = SpeechmasticsTranscriber;
    // Back-compat for the correct spelling (some files/logs use this).
    window.SpeechmaticsTranscriber = SpeechmasticsTranscriber;
} catch {
    // ignore
}

// Initialize when DOM is ready
if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
        SpeechmasticsTranscriber.init();
    });
} else {
    SpeechmasticsTranscriber.init();
}

})();
