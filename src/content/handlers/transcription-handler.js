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
    const WEBSOCKET_ENDPOINTS = {
        us: "wss://us.rt.speechmatics.com/v2",
        eu: "wss://eu.rt.speechmatics.com/v2",
    };
    const TARGET_SAMPLE_RATE = 16000;
    const AUDIO_CHUNK_FAST = 256;
    const AUDIO_CHUNK_ACCURATE = 1024;
    const OPERATING_POINT_FAST = "standard";
    const OPERATING_POINT_ACCURATE = "enhanced";
    const FINAL_DRAIN_TIMEOUT_MS = 1200;
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
        preferredAudioInputDeviceId: null,
        speechmaticsRegion: "us",
        latencyMode: "fast", // "fast" | "accurate"
        maxDelaySeconds: 0.7,
        lowLatencyAudio: true,
        hotStandbyMs: 15000,
        prebufferMs: 1500,
    };

    // Legacy key (older versions stored apiKey in sync).
    const SYNC_KEYS = { ...SETTINGS_DEFAULTS, apiKey: null, speechmaticsApiKey: null };

    // State
    let settings = { ...SETTINGS_DEFAULTS };
    let settingsLoaded = false;
    let settingsLoadPromise = null;
    let ws = null;
    let isRecording = false;
    let isConnecting = false;
    // Accumulates *finalized* transcript chunks (AddTranscript).
    // We stream these to the ChatGPT UI as they arrive so the textbox doesn't "rewind"
    // when partial hypotheses change.
    let currentTranscript = "";
    let currentPartial = "";
    let mediaStream = null;
    let activeAudioDeviceId = null;
    let audioContext = null;
    let audioSource = null;
    let audioProcessor = null; // ScriptProcessorNode
    let audioWorkletNode = null; // AudioWorkletNode
    let audioTrackProcessor = null; // MediaStreamTrackProcessor
    let audioTrackReader = null;
    let audioTrackReadAbort = false;
    let muteGain = null;
    let audioProcessingPaused = false;
    let standbyTimer = null;
    let lastSpeechTime = 0;
    let lastFinalTranscriptAt = 0;
    let silenceTimeout = null;
    let lastSeqNo = -1;
    let pendingDrainResolve = null;
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
    let authRegionFallbackAttempted = false;

    let pendingAudioQueue = [];
    let pendingAudioBytes = 0;
    let pendingAudioMaxBytes = 0;

    // Temporary key caching (browser WS can't set Authorization headers).
    let cachedTempKey = null;
    let cachedTempKeyExpiresAt = 0;
    // Larger TTL reduces the number of network round-trips needed before recording can start.
    const TEMP_KEY_TTL_SECONDS = 3600; // 60 minutes
    let tempKeyPromise = null;

    // Logging
    function log(...args) {
        if (settings.debug) {
            console.log("[SpeechmasticsTranscriber]", ...args);
        }
    }

    function updatePrebufferLimit() {
        const ms = Number(settings.prebufferMs);
        const safeMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
        pendingAudioMaxBytes = Math.max(
            0,
            Math.round((TARGET_SAMPLE_RATE * 2 * safeMs) / 1000)
        );
        trimPendingAudioQueue();
    }

    function trimPendingAudioQueue() {
        if (pendingAudioMaxBytes <= 0) {
            pendingAudioQueue = [];
            pendingAudioBytes = 0;
            return;
        }
        while (pendingAudioBytes > pendingAudioMaxBytes && pendingAudioQueue.length) {
            const dropped = pendingAudioQueue.shift();
            if (dropped?.byteLength) {
                pendingAudioBytes -= dropped.byteLength;
            }
        }
    }

    function queuePendingAudio(buffer) {
        if (!buffer || !(buffer instanceof ArrayBuffer)) return;
        if (pendingAudioMaxBytes <= 0) return;

        if (buffer.byteLength > pendingAudioMaxBytes) {
            pendingAudioQueue = [buffer];
            pendingAudioBytes = buffer.byteLength;
            return;
        }

        while (
            pendingAudioQueue.length &&
            pendingAudioBytes + buffer.byteLength > pendingAudioMaxBytes
        ) {
            const dropped = pendingAudioQueue.shift();
            if (dropped?.byteLength) {
                pendingAudioBytes -= dropped.byteLength;
            }
        }

        pendingAudioQueue.push(buffer);
        pendingAudioBytes += buffer.byteLength;
    }

    function flushPendingAudio() {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!pendingAudioQueue.length) return;
        for (const buffer of pendingAudioQueue) {
            try {
                ws.send(buffer);
            } catch (error) {
                log("Error flushing audio buffer:", error);
                break;
            }
        }
        pendingAudioQueue = [];
        pendingAudioBytes = 0;
    }

    function clearPendingAudio() {
        pendingAudioQueue = [];
        pendingAudioBytes = 0;
    }

    function resolveDrainWaiter() {
        if (pendingDrainResolve) {
            try {
                pendingDrainResolve();
            } catch {
                // ignore
            }
            pendingDrainResolve = null;
        }
    }

    function getLatencyMode() {
        return settings.latencyMode === "accurate" ? "accurate" : "fast";
    }

    function getAudioChunkSize() {
        return getLatencyMode() === "accurate" ? AUDIO_CHUNK_ACCURATE : AUDIO_CHUNK_FAST;
    }

    function getOperatingPoint() {
        return getLatencyMode() === "accurate" ? OPERATING_POINT_ACCURATE : OPERATING_POINT_FAST;
    }

    function getWebsocketBaseUrl() {
        const region = typeof settings.speechmaticsRegion === "string"
            ? settings.speechmaticsRegion.toLowerCase()
            : "us";
        return WEBSOCKET_ENDPOINTS[region] || WEBSOCKET_ENDPOINTS.us;
    }

    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    // Load settings from chrome storage
    function loadSettings({ force = false } = {}) {
        if (!force && settingsLoadPromise) {
            return settingsLoadPromise;
        }
        if (!force && settingsLoaded) {
            return Promise.resolve(settings);
        }

        settingsLoadPromise = new Promise((resolve) => {
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
                        updatePrebufferLimit();
                        settingsLoaded = true;
                        log("Settings loaded:", settings);
                        resolve(settings);
                    });
                });
            });
        }).finally(() => {
            settingsLoadPromise = null;
        });

        return settingsLoadPromise;
    }

    function installSettingsWatcher() {
        if (window.__testExtTranscriberSettingsWatcherInstalled) return;
        window.__testExtTranscriberSettingsWatcherInstalled = true;

        chrome.storage.onChanged.addListener((changes, area) => {
            if (area !== "sync" && area !== "local") return;

            // Only update known keys; ignore unrelated noise.
            for (const key of Object.keys(changes || {})) {
                const next = changes[key]?.newValue;
                if (key in SETTINGS_DEFAULTS) {
                    settings[key] = next;
                }
                if (key === "prebufferMs") {
                    updatePrebufferLimit();
                }
                if (key === "lowLatencyAudio" && !isRecording) {
                    stopMediaStream();
                }
                if (key === "speechmaticsApiKey" || key === "apiKey") {
                    // Token must be refreshed for a new key.
                    cachedTempKey = null;
                    cachedTempKeyExpiresAt = 0;
                }
            }
        });
    }

    // Initialize audio context and get microphone access
    async function initializeAudio() {
        try {
            const preferred =
                typeof settings.preferredAudioInputDeviceId === "string" &&
                settings.preferredAudioInputDeviceId.trim()
                    ? settings.preferredAudioInputDeviceId.trim()
                    : null;

            // If we already have a stream but it doesn't match the preferred device, drop it.
            if (mediaStream) {
                try {
                    const track = mediaStream.getAudioTracks?.()[0] || null;
                    const currentId = track?.getSettings?.().deviceId || null;
                    if (preferred && currentId && currentId !== preferred) {
                        stopMediaStream();
                    }
                } catch {
                    // ignore
                }
            }

            if (!mediaStream) {
                const useLowLatencyAudio = settings.lowLatencyAudio !== false;
                const baseAudio = {
                    echoCancellation: !useLowLatencyAudio,
                    noiseSuppression: !useLowLatencyAudio,
                    autoGainControl: !useLowLatencyAudio,
                    channelCount: 1,
                    sampleRate: TARGET_SAMPLE_RATE,
                };

                const constraints = preferred
                    ? { audio: { ...baseAudio, deviceId: { exact: preferred } } }
                    : { audio: baseAudio };

                try {
                    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
                } catch (err) {
                    // If the preferred device isn't available, fall back to default.
                    const name = err?.name || "";
                    if (preferred && (name === "OverconstrainedError" || name === "NotFoundError")) {
                        notifyError("Selected microphone not available. Using default.", "error");
                        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: baseAudio });
                    } else if (name === "OverconstrainedError") {
                        // Retry with relaxed constraints (drop sampleRate/channelCount).
                        mediaStream = await navigator.mediaDevices.getUserMedia({
                            audio: {
                                echoCancellation: baseAudio.echoCancellation,
                                noiseSuppression: baseAudio.noiseSuppression,
                                autoGainControl: baseAudio.autoGainControl,
                            },
                        });
                    } else {
                        throw err;
                    }
                }

                try {
                    const track = mediaStream.getAudioTracks?.()[0] || null;
                    activeAudioDeviceId = track?.getSettings?.().deviceId || null;
                } catch {
                    activeAudioDeviceId = null;
                }
            }

            if (!audioContext) {
                const AudioCtx = window.AudioContext || window.webkitAudioContext;
                try {
                    audioContext = new AudioCtx({
                        latencyHint: "interactive",
                        sampleRate: TARGET_SAMPLE_RATE,
                    });
                } catch (err) {
                    // Fallback: some browsers may reject custom sample rates.
                    audioContext = new AudioCtx({
                        latencyHint: "interactive",
                    });
                }
            }

            // Best-effort warm-up: load the AudioWorklet module ahead of time so startRecording
            // doesn't block on worklet compilation/loading.
            try {
                ensureAudioWorkletLoaded().catch(() => {
                    // ignore
                });
            } catch {
                // ignore
            }

            log("Audio initialized");
            return true;
        } catch (error) {
            log("Audio initialization error:", error);
            notifyError("Microphone access denied. Please check permissions.", "permission");
            return false;
        }
    }

    function stopMediaStream() {
        if (!mediaStream) return;
        try {
            mediaStream.getTracks?.().forEach((t) => {
                try {
                    t.stop();
                } catch {
                    // ignore
                }
            });
        } catch {
            // ignore
        }
        mediaStream = null;
        activeAudioDeviceId = null;
    }

    async function listAudioInputs() {
        if (!navigator.mediaDevices?.enumerateDevices) {
            return { ok: false, error: "ENUMERATE_UNSUPPORTED" };
        }

        // enumerateDevices returns labels only if mic permission was granted on the page.
        const all = await navigator.mediaDevices.enumerateDevices();
        const inputs = all.filter((d) => d.kind === "audioinput");

        const devices = inputs.map((d, idx) => ({
            deviceId: d.deviceId,
            label: d.label || `Microphone ${idx + 1}`,
        }));

        const selected =
            typeof settings.preferredAudioInputDeviceId === "string"
                ? settings.preferredAudioInputDeviceId
                : null;

        return { ok: true, devices, selectedDeviceId: selected || "" };
    }

    function applyPreferredAudioInputDeviceId(deviceIdOrNull) {
        const id =
            typeof deviceIdOrNull === "string" && deviceIdOrNull.trim()
                ? deviceIdOrNull.trim()
                : null;
        settings.preferredAudioInputDeviceId = id;

        // Only apply immediately when not recording (to avoid disrupting transcription).
        if (isRecording) {
            return { ok: false, error: "RECORDING_ACTIVE" };
        }

        // Drop the stream so the next start uses the new device.
        stopMediaStream();
        return { ok: true };
    }

    // Allow the popup to list/set microphones via the ChatGPT tab.
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
        if (!request?.type) return;

        if (request.type === "wispersend:listAudioInputs") {
            (async () => {
                try {
                    await loadSettings();
                    const resp = await listAudioInputs();
                    sendResponse(resp);
                } catch (err) {
                    sendResponse({ ok: false, error: "LIST_FAILED", message: err?.message || String(err) });
                }
            })();
            return true;
        }

        if (request.type === "wispersend:setAudioInput") {
            const deviceId = request.deviceId || null;
            const result = applyPreferredAudioInputDeviceId(deviceId);
            // Best-effort persist (popup also persists, but this keeps the tab consistent).
            try {
                chrome.storage.sync.set({ preferredAudioInputDeviceId: result.ok ? (settings.preferredAudioInputDeviceId || null) : (deviceId || null) });
            } catch {
                // ignore
            }
            sendResponse(result);
            return;
        }
    });

    function nowMs() {
        return Date.now();
    }

    async function getTempKey() {
        // Refresh temp key slightly before expiry.
        if (cachedTempKey && cachedTempKeyExpiresAt - nowMs() > 30_000) {
            return cachedTempKey;
        }
        if (tempKeyPromise) {
            return tempKeyPromise;
        }

        tempKeyPromise = (async () => {
            const resp = await new Promise((resolve) => {
                chrome.runtime.sendMessage(
                    { eventType: "getSpeechmaticsTempKey", ttlSeconds: TEMP_KEY_TTL_SECONDS },
                    (r) => resolve(r)
                );
            });

            if (!resp || resp.ok !== true) {
                const status = resp?.status;
                const error = resp?.error || "UNKNOWN";

                if (error === "API_KEY_MISSING") {
                    throw new Error("API key not configured");
                }

                const details = status ? ` (HTTP ${status})` : "";
                throw new Error(`Failed to obtain session token${details}`);
            }

            cachedTempKey = resp.tempKey;
            cachedTempKeyExpiresAt =
                nowMs() + (Number(resp.ttlSeconds) || TEMP_KEY_TTL_SECONDS) * 1000;
            return cachedTempKey;
        })();

        try {
            return await tempKeyPromise;
        } finally {
            tempKeyPromise = null;
        }
    }

    // Connect to Speechmatics WebSocket
    async function connectWebSocket({ jwt, suppressErrors = false } = {}) {
        try {
            const token = typeof jwt === "string" && jwt ? jwt : await getTempKey();
            const baseUrl = getWebsocketBaseUrl();
            const url = `${baseUrl}?jwt=${encodeURIComponent(token)}`;

            return new Promise((resolve, reject) => {
                const myEpoch = ++messageEpoch;
                activeMessageEpoch = myEpoch;

                ws = new WebSocket(url);

                ws.onopen = () => {
                    if (myEpoch !== activeMessageEpoch) return;
                    log("WebSocket connected");
                    notifyConnectionStatus("connected");
                    lastSeqNo = -1;
                    sendStartRecognition();
                    flushPendingAudio();
                    resolve();
                };

                ws.onmessage = (event) => {
                    if (myEpoch !== activeMessageEpoch) return;
                    handleMessage(event.data);
                };

                ws.onerror = (error) => {
                    if (myEpoch !== activeMessageEpoch) return;
                    log("WebSocket error:", error);
                    resolveDrainWaiter();
                    if (!suppressErrors) {
                        notifyConnectionStatus("error");
                        notifyError("Transcription service error. Please try again.", "connection");
                    }
                    reject(error);
                };

                ws.onclose = () => {
                    if (myEpoch !== activeMessageEpoch) return;
                    log("WebSocket closed");
                    resolveDrainWaiter();
                    if (!suppressErrors) {
                        notifyConnectionStatus("error");
                    }
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
            if (!suppressErrors) {
                if (error.message.includes("API key")) {
                    notifyError("API key not configured. Please set it in settings.", "error");
                } else if (error.message.includes("Failed to obtain session token")) {
                    notifyError(error.message, "error");
                } else if (error.message.includes("timeout")) {
                    notifyError("Connection timeout. Please try again.", "timeout");
                } else {
                    notifyError("Failed to connect to the transcription service. Please try again.", "connection");
                }
            }
            throw error;
        }
    }

    async function connectWebSocketWithRetry({ jwt, maxRetries = 5 } = {}) {
        let lastError = null;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const suppressErrors = attempt < maxRetries - 1;
            try {
                await connectWebSocket({ jwt, suppressErrors });
                return;
            } catch (error) {
                lastError = error;
                await closeWebSocket();
                if (attempt >= maxRetries - 1) {
                    break;
                }
                const delayMs = Math.min(16000, Math.pow(2, attempt) * 1000);
                log(`WebSocket retry ${attempt + 1}/${maxRetries} after ${delayMs}ms`);
                await sleep(delayMs);
            }
        }
        throw lastError || new Error("WebSocket connection failed");
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
                operating_point: getOperatingPoint(),
                enable_partials: true,
                max_delay: (() => {
                    const raw = Number(settings.maxDelaySeconds);
                    if (!Number.isFinite(raw) || raw <= 0) return undefined;
                    return Math.min(Math.max(raw, 0.7), 2.0);
                })(),
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

    async function retryWithAlternateRegionOnAuthError(reason) {
        if (authRegionFallbackAttempted) return;
        authRegionFallbackAttempted = true;

        const current = typeof settings.speechmaticsRegion === "string"
            ? settings.speechmaticsRegion.toLowerCase()
            : "us";
        const next = current === "us" ? "eu" : "us";

        notifyError(
            `Transcription error: Not Authorized (${current.toUpperCase()}). Retrying with ${next.toUpperCase()} region...`,
            "error"
        );

        try {
            await closeWebSocket();
            settings.speechmaticsRegion = next;
            try {
                chrome.storage.sync.set({ speechmaticsRegion: next });
            } catch {
                // ignore
            }
            await connectWebSocket();
        } catch (err) {
            log("Retry with alternate region failed:", err);
            notifyError(
                `Transcription error: Not Authorized on ${current.toUpperCase()} and ${next.toUpperCase()} regions.`,
                "error"
            );
            stopRecording();
        }
    }

    // Handle incoming WebSocket messages
    function handleMessage(data) {
        try {
            const message = JSON.parse(data);
            if (!message || typeof message !== "object" || typeof message.message !== "string") {
                return;
            }
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
                resolveDrainWaiter();
                if (String(reason).toLowerCase().includes("not authorized")) {
                    retryWithAlternateRegionOnAuthError(reason);
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
            } else if (message.message === "EndOfTranscript") {
                resolveDrainWaiter();
            }
        } catch (error) {
            log("Message parsing error:", error);
        }
    }

    function extractTranscriptText(message) {
        if (typeof message?.metadata?.transcript === "string") {
            return message.metadata.transcript;
        }
        if (typeof message?.transcript === "string") {
            return message.transcript;
        }
        const results = message?.results || message?.metadata?.results;
        if (Array.isArray(results) && results.length) {
            let text = "";
            for (const result of results) {
                if (result?.type === "word" && result.alternatives && result.alternatives[0]) {
                    text += result.alternatives[0].content + " ";
                }
            }
            return text.trim();
        }
        return "";
    }

    function extractWordSegments(message) {
        const results = message?.metadata?.results || message?.results;
        if (!Array.isArray(results)) {
            return [];
        }

        const segments = [];
        for (const result of results) {
            if (result?.type !== "word") continue;
            const alt = result.alternatives && result.alternatives[0] ? result.alternatives[0] : null;
            const text = alt?.content;
            if (!text) continue;

            segments.push({
                text: String(text),
                confidence:
                    typeof alt?.confidence === "number" ? alt.confidence : null,
                startTime:
                    typeof result.start_time === "number" ? result.start_time : null,
                endTime:
                    typeof result.end_time === "number" ? result.end_time : null,
            });
        }

        return segments;
    }

    function computeAverageConfidence(segments) {
        if (!Array.isArray(segments) || segments.length === 0) {
            return null;
        }
        let total = 0;
        let count = 0;
        for (const seg of segments) {
            if (typeof seg.confidence === "number") {
                total += seg.confidence;
                count += 1;
            }
        }
        if (!count) return null;
        return total / count;
    }

    // Handle partial transcript (real-time updates)
    function handlePartialTranscript(message) {
        // Per Speechmatics docs, transcript text is in `metadata.transcript`.
        const transcript = extractTranscriptText(message);

        if (transcript && transcript.trim()) {
            lastSpeechTime = Date.now();
            currentPartial = transcript;
            notifyPartialTranscription(transcript);
        }
    }

    // Handle final transcript
    function handleFinalTranscript(message) {
        // Per Speechmatics docs, transcript text is in `metadata.transcript`.
        const transcript = extractTranscriptText(message);
        const wordSegments = extractWordSegments(message);
        const confidence = computeAverageConfidence(wordSegments);

        if (transcript && transcript.trim()) {
            // `transcript` is already formatted for concatenation (spacing/punctuation)
            // per Speechmatics' WS protocol.
            currentTranscript += transcript;
            currentPartial = "";
            lastSpeechTime = Date.now();
            lastFinalTranscriptAt = lastSpeechTime;
            log("Final text received:", transcript.trim());

            // Commit finalized words into the ChatGPT textbox immediately so that later partials
            // don't overwrite earlier speech.
            notifyCommittedTranscription(transcript, {
                confidence,
                wordSegments: wordSegments.length ? wordSegments : null,
            });
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
        if (!int16Array || int16Array.length === 0) return;
        sendOrQueuePcmBuffer(int16Array.buffer);
    }

    let audioWorkletLoadPromise = null;
    let audioWorkletInitFailedOnce = false;
    let audioWorkletModuleSource = null;
    let audioWorkletModuleBlobUrl = null;
    let audioWorkletModuleDataUrl = null;
    const INLINE_PCM16_WORKLET_SOURCE = `/* eslint-disable no-restricted-globals */
/**
 * AudioWorkletProcessor that:
 * - Buffers input Float32 PCM
 * - Downsamples to a target sample rate (defaults to 16kHz)
 * - Converts to signed 16-bit PCM (little-endian via Int16Array)
 * - Posts ArrayBuffer chunks back to the main thread
 *
 * The main thread can forward these buffers to a WebSocket directly.
 */

class Pcm16DownsamplerProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        const processorOptions = options?.processorOptions || {};
        this._targetSampleRate = Number(processorOptions.targetSampleRate) || 16000;
        this._chunkSize = Math.max(256, Number(processorOptions.chunkSize) || 4096);

        // Circular buffer to accumulate input samples so we can process in larger chunks.
        this._capacity = Math.max(this._chunkSize * 4, 16384);
        this._buffer = new Float32Array(this._capacity);
        this._write = 0;
        this._read = 0;
        this._available = 0;
        this._paused = false;

        this.port.onmessage = (event) => {
            const data = event?.data || {};
            if (data.type === "setPaused") {
                this._paused = Boolean(data.paused);
                if (this._paused) {
                    this._write = 0;
                    this._read = 0;
                    this._available = 0;
                }
            } else if (data.type === "reset") {
                this._write = 0;
                this._read = 0;
                this._available = 0;
            }
        };
    }

    _push(input) {
        // If we overflow, drop newest samples (keeps audio graph alive without crashing).
        for (let i = 0; i < input.length; i++) {
            if (this._available >= this._capacity) {
                return;
            }
            this._buffer[this._write] = input[i];
            this._write = (this._write + 1) % this._capacity;
            this._available++;
        }
    }

    _popChunk(out) {
        for (let i = 0; i < out.length; i++) {
            out[i] = this._buffer[this._read];
            this._read = (this._read + 1) % this._capacity;
        }
        this._available -= out.length;
    }

    _floatTo16BitPcm(f32) {
        const out = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
    }

    // Simple downsampler for speech: averages samples within each output frame.
    _downsampleToTargetRate(input, inputSampleRate) {
        if (!input || input.length === 0) return new Int16Array(0);
        if (inputSampleRate === this._targetSampleRate) {
            return this._floatTo16BitPcm(input);
        }

        const ratio = inputSampleRate / this._targetSampleRate;
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

    process(inputs, outputs) {
        const input = inputs?.[0]?.[0];
        const output = outputs?.[0]?.[0];

        // Keep the node "active" by passing audio through (it will be muted by GainNode in main thread).
        if (input && output) {
            output.set(input);
        }

        if (this._paused) {
            return true;
        }

        if (!input || input.length === 0) {
            return true;
        }

        this._push(input);

        // Use the global worklet \`sampleRate\` (same as the AudioContext rate).
        while (this._available >= this._chunkSize) {
            const chunk = new Float32Array(this._chunkSize);
            this._popChunk(chunk);

            const pcm16 = this._downsampleToTargetRate(chunk, sampleRate);
            if (pcm16.length > 0) {
                // Transfer the underlying ArrayBuffer for efficiency.
                this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
            }
        }

        return true;
    }
}

registerProcessor("pcm16-downsampler", Pcm16DownsamplerProcessor);
`;

    function resetAudioWorkletModuleCache() {
        if (audioWorkletModuleBlobUrl) {
            try {
                URL.revokeObjectURL(audioWorkletModuleBlobUrl);
            } catch {
                // ignore
            }
            audioWorkletModuleBlobUrl = null;
        }
        audioWorkletModuleDataUrl = null;
        audioWorkletModuleSource = null;
    }

    async function tryLoadAudioWorkletWithBlob(baseUrl, { forceReload = false } = {}) {
        if (!audioWorkletModuleSource || forceReload) {
            const response = await fetch(baseUrl, { cache: forceReload ? "no-store" : "default" });
            if (!response.ok) {
                throw new Error(`Worklet fetch failed (HTTP ${response.status})`);
            }
            audioWorkletModuleSource = await response.text();
        }

        if (!audioWorkletModuleSource) {
            throw new Error("Worklet source empty after fetch");
        }

        const blob = new Blob([audioWorkletModuleSource], { type: "application/javascript" });
        audioWorkletModuleBlobUrl = URL.createObjectURL(blob);
        await audioContext.audioWorklet.addModule(audioWorkletModuleBlobUrl);
        return "blob-url";
    }

    function base64FromUtf8(text) {
        const bytes = new TextEncoder().encode(text);
        let binary = "";
        const chunkSize = 0x8000;
        for (let i = 0; i < bytes.length; i += chunkSize) {
            binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
        }
        return btoa(binary);
    }

    async function tryLoadAudioWorkletWithDataUrl(baseUrl) {
        if (!audioWorkletModuleSource) {
            const response = await fetch(baseUrl, { cache: "no-store" });
            if (!response.ok) {
                throw new Error(`Worklet fetch failed (HTTP ${response.status})`);
            }
            audioWorkletModuleSource = await response.text();
        }

        const base64 = base64FromUtf8(audioWorkletModuleSource);
        audioWorkletModuleDataUrl = `data:application/javascript;base64,${base64}`;
        await audioContext.audioWorklet.addModule(audioWorkletModuleDataUrl);
        return "data-url";
    }

    async function tryLoadAudioWorkletInline() {
        const base64 = base64FromUtf8(INLINE_PCM16_WORKLET_SOURCE);
        const inlineUrl = `data:application/javascript;base64,${base64}`;
        await audioContext.audioWorklet.addModule(inlineUrl);
        return "inline-data-url";
    }

    function ensureAudioWorkletLoaded({ forceReload = false } = {}) {
        if (!audioContext?.audioWorklet) {
            return Promise.reject(new Error("AudioWorklet not supported"));
        }
        if (audioWorkletLoadPromise && !forceReload) {
            return audioWorkletLoadPromise;
        }

        if (forceReload) {
            audioWorkletLoadPromise = null;
            resetAudioWorkletModuleCache();
        }

        const baseUrl = chrome.runtime.getURL("src/content/worklets/pcm16-downsampler.js");
        const url = forceReload ? `${baseUrl}?v=${Date.now()}` : baseUrl;
        audioWorkletLoadPromise = (async () => {
            try {
                await audioContext.audioWorklet.addModule(url);
                log("AudioWorklet module loaded via extension URL");
                return "extension-url";
            } catch (error) {
                log("AudioWorklet addModule failed for extension URL:", error);
                try {
                    const method = await tryLoadAudioWorkletWithBlob(baseUrl, { forceReload });
                    log("AudioWorklet module loaded via blob URL");
                    return method;
                } catch (blobError) {
                    log("AudioWorklet addModule failed for blob URL:", blobError);
                    try {
                        const method = await tryLoadAudioWorkletWithDataUrl(baseUrl);
                        log("AudioWorklet module loaded via data URL");
                        return method;
                    } catch (dataError) {
                        log("AudioWorklet addModule failed for data URL:", dataError);
                        const method = await tryLoadAudioWorkletInline();
                        log("AudioWorklet module loaded via inline data URL");
                        return method;
                    }
                }
            }
        })().catch((error) => {
            // Allow retry later (warm-up might fail before user gesture).
            audioWorkletLoadPromise = null;
            throw error;
        });
        return audioWorkletLoadPromise;
    }

    function sendPcmBuffer(buffer) {
        if (!buffer || !(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) return;
        sendOrQueuePcmBuffer(buffer);
    }

    function sendOrQueuePcmBuffer(buffer) {
        if (!buffer || !(buffer instanceof ArrayBuffer)) return;

        if (ws && ws.readyState === WebSocket.OPEN) {
            try {
                ws.send(buffer);
                return;
            } catch (error) {
                log("Error sending audio buffer:", error);
            }
        }

        if (isRecording || isConnecting) {
            queuePendingAudio(buffer);
        }
    }

    function setAudioProcessingPaused(paused) {
        audioProcessingPaused = Boolean(paused);
        if (audioWorkletNode && audioWorkletNode.port) {
            try {
                audioWorkletNode.port.postMessage({
                    type: "setPaused",
                    paused: audioProcessingPaused,
                });
            } catch {
                // ignore
            }
        }
    }

    async function startTrackProcessorStreaming(track) {
        if (!track || typeof MediaStreamTrackProcessor === "undefined") {
            return false;
        }
        if (audioTrackProcessor || audioTrackReader) {
            return true;
        }

        try {
            audioTrackReadAbort = false;
            audioTrackProcessor = new MediaStreamTrackProcessor({ track });
            audioTrackReader = audioTrackProcessor.readable.getReader();

            (async () => {
                while (!audioTrackReadAbort) {
                    let value = null;
                    try {
                        const { value: frame, done } = await audioTrackReader.read();
                        if (done || audioTrackReadAbort) break;
                        if (!frame) continue;
                        value = frame;

                        if (audioProcessingPaused || (!isRecording && !isConnecting)) {
                            value.close();
                            continue;
                        }

                        const frames = value.numberOfFrames;
                        if (!frames) {
                            value.close();
                            continue;
                        }

                        const f32 = new Float32Array(frames);
                        value.copyTo(f32, { planeIndex: 0 });
                        const pcm16 = downsampleTo16kHz(f32, value.sampleRate);
                        sendPcmChunk(pcm16);
                        value.close();
                    } catch (err) {
                        if (value) {
                            try {
                                value.close();
                            } catch {
                                // ignore
                            }
                        }
                        if (!audioTrackReadAbort) {
                            log("MediaStreamTrackProcessor read failed:", err);
                        }
                        break;
                    }
                }
            })();

            log("MediaStreamTrackProcessor attached");
            return true;
        } catch (error) {
            log("MediaStreamTrackProcessor init failed:", error);
            try {
                audioTrackReader?.cancel?.();
            } catch {
                // ignore
            }
            audioTrackReader = null;
            audioTrackProcessor = null;
            return false;
        }
    }

    function stopTrackProcessorStreaming() {
        audioTrackReadAbort = true;
        if (audioTrackReader) {
            try {
                audioTrackReader.cancel();
            } catch {
                // ignore
            }
        }
        audioTrackReader = null;
        audioTrackProcessor = null;
    }

    async function startAudioStreaming() {
        if (!audioContext || !mediaStream) return;
        if (audioSource || audioProcessor || audioWorkletNode || audioTrackProcessor || audioTrackReader) return;

        if (audioContext.state === "suspended") {
            try {
                await audioContext.resume();
            } catch {
                // ignore; we'll still attempt to start nodes
            }
        }

        // Prefer AudioWorkletNode (ScriptProcessorNode is deprecated and logs warnings).
        const canUseWorklet =
            typeof AudioWorkletNode !== "undefined" &&
            !!audioContext.audioWorklet &&
            typeof audioContext.audioWorklet.addModule === "function";

        if (canUseWorklet) {
            try {
                await ensureAudioWorkletLoaded();

                audioSource = audioContext.createMediaStreamSource(mediaStream);
                muteGain = audioContext.createGain();
                muteGain.gain.value = 0;

                const chunkSize = getAudioChunkSize();
                audioWorkletNode = new AudioWorkletNode(audioContext, "pcm16-downsampler", {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                    outputChannelCount: [1],
                    processorOptions: {
                        targetSampleRate: TARGET_SAMPLE_RATE,
                        chunkSize,
                    },
                });

                audioWorkletNode.port.onmessage = (event) => {
                    if (audioProcessingPaused) return;
                    if (!isRecording && !isConnecting) return;
                    const data = event?.data;
                    // The processor posts an ArrayBuffer as the message payload.
                    if (data instanceof ArrayBuffer) {
                        sendPcmBuffer(data);
                    } else if (data?.buffer instanceof ArrayBuffer) {
                        sendPcmBuffer(data.buffer);
                    }
                };
                try {
                    audioWorkletNode.port.postMessage({
                        type: "setPaused",
                        paused: audioProcessingPaused,
                    });
                } catch {
                    // ignore
                }

                audioSource.connect(audioWorkletNode);
                audioWorkletNode.connect(muteGain);
                muteGain.connect(audioContext.destination);
                return;
            } catch (error) {
                if (!audioWorkletInitFailedOnce) {
                    audioWorkletInitFailedOnce = true;
                    console.warn(
                        "[SpeechmasticsTranscriber] AudioWorklet init failed; falling back to ScriptProcessorNode:",
                        error
                    );
                }
                log("AudioWorklet init failed; falling back to ScriptProcessorNode:", error);
                // Retry once with a cache-busted module URL in case of stale/cached failure.
                try {
                    await ensureAudioWorkletLoaded({ forceReload: true });

                    audioSource = audioContext.createMediaStreamSource(mediaStream);
                    muteGain = audioContext.createGain();
                    muteGain.gain.value = 0;

                    const chunkSize = getAudioChunkSize();
                    audioWorkletNode = new AudioWorkletNode(audioContext, "pcm16-downsampler", {
                        numberOfInputs: 1,
                        numberOfOutputs: 1,
                        outputChannelCount: [1],
                        processorOptions: {
                            targetSampleRate: TARGET_SAMPLE_RATE,
                            chunkSize,
                        },
                    });

                    audioWorkletNode.port.onmessage = (event) => {
                        if (audioProcessingPaused) return;
                        if (!isRecording && !isConnecting) return;
                        const data = event?.data;
                        if (data instanceof ArrayBuffer) {
                            sendPcmBuffer(data);
                        } else if (data?.buffer instanceof ArrayBuffer) {
                            sendPcmBuffer(data.buffer);
                        }
                    };
                    try {
                        audioWorkletNode.port.postMessage({
                            type: "setPaused",
                            paused: audioProcessingPaused,
                        });
                    } catch {
                        // ignore
                    }

                    audioSource.connect(audioWorkletNode);
                    audioWorkletNode.connect(muteGain);
                    muteGain.connect(audioContext.destination);
                    return;
                } catch (retryError) {
                    log("AudioWorklet retry failed; using ScriptProcessorNode:", retryError);
                }
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

        // Fallback 2: MediaStreamTrackProcessor (preferred over ScriptProcessorNode when available).
        if (typeof MediaStreamTrackProcessor !== "undefined") {
            const track = mediaStream?.getAudioTracks?.()[0] || null;
            if (await startTrackProcessorStreaming(track)) {
                return;
            }
        }

        // Fallback 3: ScriptProcessorNode (deprecated, but keeps older browsers working).
        audioSource = audioContext.createMediaStreamSource(mediaStream);
        muteGain = audioContext.createGain();
        muteGain.gain.value = 0;

        const bufferSize = getAudioChunkSize();
        audioProcessor = audioContext.createScriptProcessor(bufferSize, 1, 1);
        audioProcessor.onaudioprocess = (event) => {
            if (audioProcessingPaused || (!isRecording && !isConnecting)) return;

            const input = event.inputBuffer.getChannelData(0);
            const pcm16 = downsampleTo16kHz(input, audioContext.sampleRate);
            sendPcmChunk(pcm16);
        };

        audioSource.connect(audioProcessor);
        audioProcessor.connect(muteGain);
        muteGain.connect(audioContext.destination);
    }

    function stopAudioStreaming() {
        if (audioTrackProcessor || audioTrackReader) {
            stopTrackProcessorStreaming();
        }
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

    function scheduleStandbyTeardown() {
        if (standbyTimer) {
            try {
                clearTimeout(standbyTimer);
            } catch {
                // ignore
            }
            standbyTimer = null;
        }

        const ms = Number(settings.hotStandbyMs);
        const delay = Number.isFinite(ms) ? ms : 0;
        if (delay <= 0) {
            teardownAudioResources();
            return;
        }

        standbyTimer = setTimeout(() => {
            standbyTimer = null;
            if (isRecording || isConnecting) {
                return;
            }
            teardownAudioResources();
        }, delay);
    }

    function teardownAudioResources() {
        stopAudioStreaming();
        stopMediaStream();
        audioProcessingPaused = false;
        if (audioContext && audioContext.state === "running") {
            try {
                audioContext.suspend();
            } catch {
                // ignore
            }
        }
    }

    // Start recording
    async function startRecording() {
        if (isRecording || isConnecting) return;

        try {
            // Ensure we have settings loaded (avoid re-loading on every start).
            await loadSettings();

            if (standbyTimer) {
                clearTimeout(standbyTimer);
                standbyTimer = null;
            }

            notifyConnectionStatus("connecting");

            // Fetch the session token in parallel with the microphone prompt for faster starts.
            const jwtPromise = getTempKey().catch(() => null);

            // Initialize audio
            const audioOk = await initializeAudio();
            if (!audioOk) return;

            // Start capturing audio immediately; queue audio while WebSocket connects.
            isConnecting = true;
            isRecording = true;
            sessionId++;
            authRegionFallbackAttempted = false;
            currentTranscript = "";
            currentPartial = "";
            lastSpeechTime = Date.now();
            lastFinalTranscriptAt = 0;
            retryingStartConfig = false;
            startConfigTried = new Set();
            // Default to the most explicit-but-permissive schema first.
            startConfigVariant = 2;
            clearPendingAudio();

            setAudioProcessingPaused(false);
            await startAudioStreaming();

            // Notify UI immediately for instant mic feedback.
            notifyMicStatus(true);

            // Connect to WebSocket
            const jwt = await jwtPromise;
            await connectWebSocketWithRetry({ jwt });

            isConnecting = false;
            log("Recording started");
        } catch (error) {
            log("Start recording error:", error);
            isConnecting = false;
            isRecording = false;
            setAudioProcessingPaused(true);
            notifyMicStatus(false);
            clearPendingAudio();
            scheduleStandbyTeardown();
            await closeWebSocket({ drain: false });
        }
    }

    // Stop recording
    async function stopRecording() {
        return stopRecordingWithOptions();
    }

    async function stopRecordingWithOptions({ forceAutoEnter = false, autoEnter = null } = {}) {
        if (!isRecording) return;

        isRecording = false;
        isConnecting = false;
        spacebarPushToTalkActive = false;
        // Capture before we clear buffers.
        const shouldForceAutoEnter = Boolean(forceAutoEnter);
        const hasAutoEnterOverride = typeof autoEnter === "boolean";

        setAudioProcessingPaused(true);
        clearPendingAudio();
        scheduleStandbyTeardown();

        // Clear timeouts
        if (silenceTimeout) {
            clearTimeout(silenceTimeout);
        }

        // Notify UI immediately for instant mic feedback
        notifyMicStatus(false);

        // Close WebSocket
        await closeWebSocket({ drain: true, timeoutMs: FINAL_DRAIN_TIMEOUT_MS });

        // Finalize session: UI already received committed chunks in real-time.
        // This event is used to (optionally) auto-send the ChatGPT message and clear the partial overlay.
        // Safety: if Speechmatics didn't emit an AddTranscript for the last utterance yet,
        // fall back to committing the last partial so we don't lose text.
        if (currentPartial && currentPartial.trim()) {
            const committed = (currentTranscript || "").trim();
            const partial = currentPartial.trim();
            let tail = "";
            if (!committed) {
                tail = partial;
            } else if (partial.startsWith(committed)) {
                tail = partial.slice(committed.length).trimStart();
            } else {
                const maxCheck = Math.min(committed.length, partial.length, 100);
                for (let len = maxCheck; len > 0; len--) {
                    if (committed.slice(-len) === partial.slice(0, len)) {
                        tail = partial.slice(len).trimStart();
                        break;
                    }
                }
                if (!tail) {
                    tail = partial;
                }
            }

            if (tail) {
                currentTranscript = committed ? `${committed} ${tail}` : tail;
                notifyCommittedTranscription(tail);
            }
            notifyPartialTranscription("");
        }

        if ((currentTranscript && currentTranscript.trim()) || (currentPartial && currentPartial.trim())) {
            notifyFinalizeTranscription({
                forceAutoEnter: shouldForceAutoEnter,
                autoEnter: hasAutoEnterOverride ? Boolean(autoEnter) : null,
            });
        }
        currentTranscript = "";
        currentPartial = "";

        log("Recording stopped");
    }

    // Close WebSocket connection
    async function closeWebSocket({ drain = false, timeoutMs = 1000 } = {}) {
        if (!ws) {
            return;
        }

        const socket = ws;
        const closingEpoch = activeMessageEpoch;
        const shouldDrain = drain && socket.readyState === WebSocket.OPEN;

        if (shouldDrain) {
            try {
                const eos = {
                    message: "EndOfStream",
                    last_seq_no: lastSeqNo >= 0 ? lastSeqNo : 0,
                };
                socket.send(JSON.stringify(eos));
            } catch {
                // ignore
            }

            const drainPromise = new Promise((resolve) => {
                pendingDrainResolve = resolve;
            });

            await Promise.race([drainPromise, sleep(FINAL_DRAIN_TIMEOUT_MS)]);
            resolveDrainWaiter();
        } else {
            // Invalidate any in-flight callbacks from this socket immediately.
            activeMessageEpoch = ++messageEpoch;
        }

        await new Promise((resolve) => {
            const timeout = setTimeout(resolve, timeoutMs);

            socket.onclose = () => {
                clearTimeout(timeout);
                resolve();
            };

            try {
                socket.close();
            } catch {
                // ignore
            }
        });

        if (ws === socket) {
            ws = null;
        }
        if (activeMessageEpoch === closingEpoch) {
            activeMessageEpoch = ++messageEpoch;
        }
        resolveDrainWaiter();
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
            if (isEditableElement(active)) {
                return false;
            }
            if (isEditableElement(event.target)) {
                return false;
            }

            return true;
        }

        document.addEventListener("keydown", (event) => {
            // Toggle recording: Cmd+M (macOS) / Ctrl+M (Windows/Linux).
            // This stops recording WITHOUT auto-submitting so the user can edit before sending.
            if (
                (event.code === "KeyM" || event.key === "m" || event.key === "M") &&
                !event.repeat &&
                !event.isComposing &&
                !event.altKey &&
                (event.metaKey || event.ctrlKey)
            ) {
                try {
                    event.preventDefault();
                    event.stopPropagation();
                } catch {
                    // ignore
                }

                if (isRecording) {
                    stopRecordingWithOptions({ autoEnter: false });
                } else {
                    startRecording();
                }
                return;
            }

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

    function notifyCommittedTranscription(text, meta = null) {
        const detail = {
            type: "appendCommittedTranscript",
            text,
        };

        if (meta && typeof meta === "object") {
            if (typeof meta.confidence === "number") {
                detail.confidence = meta.confidence;
            }
            if (Array.isArray(meta.wordSegments)) {
                detail.wordSegments = meta.wordSegments;
            }
        }

        emitToChatGpt(detail);
    }

    function notifyFinalizeTranscription({ forceAutoEnter = false, autoEnter = null } = {}) {
        const resolvedAutoEnter =
            typeof autoEnter === "boolean"
                ? autoEnter
                : Boolean(forceAutoEnter) || settings.autoEnterAfterSubmit;
        emitToChatGpt({
            type: "finalizeTranscription",
            autoEnter: resolvedAutoEnter,
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
        installSettingsWatcher();
        // Warm up settings and temp key in the background so first-start feels snappy.
        loadSettings().then(() => {
            if (settings?.apiKey) {
                getTempKey().catch(() => {
                    // ignore (user may not have configured a key yet)
                });
            }
        });
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
                                await connectWebSocketWithRetry();
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
                if (changes.prebufferMs) {
                    updatePrebufferLimit();
                }
                if (changes.lowLatencyAudio && !isRecording) {
                    stopMediaStream();
                }
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
