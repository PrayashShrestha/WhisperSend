(() => {
    if (window.__testExtChatGptLoaded) {
        return;
    }
    window.__testExtChatGptLoaded = true;

    // Debug marker to confirm the extension content scripts are running on this page.
    try {
        document.documentElement?.setAttribute("data-test-ext", "loaded");
    } catch {
        // ignore
    }

    const EVENTS = {
        CLEAR: "clear",
        TRANSCRIPTION: "transcription",
    };

    const SETTINGS_DEFAULTS = {
        appendMode: true,
        appendSeparator: "\n",
        debug: false,
        autoEnterAfterSubmit: true,
        autoSubmitMessage: false,
        showPartialTranscript: true,
        promptChecklist: [],
    };

    let settings = { ...SETTINGS_DEFAULTS };
    let lastReceived = "";
    let lastTranscribedText = ""; // Track for deletion
    let micStatusIndicator = null;
    let micToggleButton = null; // Mic button above textarea
    let currentPartialText = ""; // Store partial transcription
    let previewText = ""; // Store preview text for partial transcription
    let micPositionRaf = null;
    let isRecordingSession = false;
    let sessionBaseText = "";
    let sessionCommittedText = "";
    let activeTranscriptionSessionId = null;
    let suppressAutoResetUntilMs = 0;
    let promptPrefixText = "";

    function suppressAutoResetFor(ms) {
        suppressAutoResetUntilMs = Date.now() + Math.max(0, Number(ms) || 0);
    }

    function isAutoResetSuppressed() {
        return Date.now() < suppressAutoResetUntilMs;
    }

    function buildPromptPrefixFromChecklist(list) {
        const items = Array.isArray(list) ? list : [];
        const lines = items
            .filter((i) => Boolean(i?.checked) && typeof i?.text === "string" && i.text.trim())
            .map((i) => `- ${i.text.trim()}`);
        if (lines.length === 0) return "";
        return `${lines.join("\n")}\n\n`;
    }

    function refreshPromptPrefixFromSettings() {
        promptPrefixText = buildPromptPrefixFromChecklist(settings.promptChecklist);
    }

    function splitPrefix(fullText) {
        const text = fullText || "";
        if (!promptPrefixText) return { hasPrefix: false, tail: text };
        if (text.startsWith(promptPrefixText)) {
            return { hasPrefix: true, tail: text.slice(promptPrefixText.length) };
        }
        return { hasPrefix: false, tail: text };
    }

    function ensurePrefix(fullText) {
        const text = fullText || "";
        if (!promptPrefixText) return text;
        const { tail } = splitPrefix(text);
        return `${promptPrefixText}${tail.replace(/^\n+/, "")}`;
    }

    function hardResetTranscription({ stopRecording = false } = {}) {
        const transcriber =
            (typeof window !== "undefined" &&
                (window.SpeechmasticsTranscriber || window.SpeechmaticsTranscriber)) ||
            null;
        const stillRecording =
            !!transcriber && typeof transcriber.isRecording === "function"
                ? transcriber.isRecording()
                : false;

        // Optionally stop recording (not default, as it may auto-finalize/submit depending on settings).
        if (
            stopRecording &&
            stillRecording &&
            typeof transcriber?.toggleRecording === "function"
        ) {
            try {
                transcriber.toggleRecording();
            } catch {
                // ignore
            }
        }

        // Reset UI buffers.
        sessionBaseText = "";
        sessionCommittedText = "";
        currentPartialText = "";
        previewText = "";
        lastTranscribedText = "";
        activeTranscriptionSessionId = null;

        // If recording continues, keep the session "armed" so incoming partials/finals render.
        isRecordingSession = stillRecording && !stopRecording;

        // Clear the ChatGPT composer content.
        const promptEl = getPromptElement();
        if (promptEl) {
            suppressAutoResetFor(750);
            setPromptText(promptEl, promptPrefixText || "");
        }

        // Tell the transcriber to drop buffers / fast-reconnect (server-side reset).
        try {
            window.dispatchEvent(
                new CustomEvent("__testExtChatUi", { detail: { type: "resetSession" } })
            );
        } catch {
            // ignore
        }

        // Ensure renderer doesn't re-hydrate with stale buffers.
        if (isRecordingSession) {
            renderSessionText();
        }
    }

    function getDomHost() {
        return document.body || document.documentElement || null;
    }

    function safeAppendToHost(node) {
        const host = getDomHost();
        if (host) {
            host.appendChild(node);
            return true;
        }

        // Extremely early execution; wait for DOM.
        document.addEventListener(
            "DOMContentLoaded",
            () => {
                const nextHost = getDomHost();
                if (nextHost && node.isConnected === false) {
                    nextHost.appendChild(node);
                }
            },
            { once: true }
        );
        return false;
    }

    function loadSettings() {
        chrome.storage.sync.get(SETTINGS_DEFAULTS, (items) => {
            settings = { ...SETTINGS_DEFAULTS, ...items };
            refreshPromptPrefixFromSettings();

            // Keep the prefix present when not recording.
            if (!isRecordingSession) {
                const promptEl = getPromptElement();
                if (promptEl) {
                    const current = getPromptText(promptEl);
                    const next = ensurePrefix(current);
                    if (next !== current) {
                        suppressAutoResetFor(750);
                        setPromptText(promptEl, next);
                    }
                }
            }
        });
    }

    function log(...args) {
        if (settings.debug) {
            console.log("[ChatGPT]", ...args);
        }
    }

    function getPromptElement() {
        const container = document.querySelector("#prompt-textarea");
        if (!container) {
            return null;
        }

        return (
            container.querySelector("textarea") ||
            container.querySelector("div[contenteditable='true']") ||
            container
        );
    }

    function getPromptContainerElement() {
        // ChatGPT currently uses a ProseMirror editor with #prompt-textarea.
        return document.querySelector("#prompt-textarea");
    }

    function getComposerSurfaceElement() {
        // ChatGPT's rounded composer "pill" wrapper.
        return document.querySelector('[data-composer-surface="true"]');
    }

    function getMicAnchorElement() {
        return getComposerSurfaceElement() || getPromptContainerElement() || getDomHost();
    }

    function safeAppendToAnchor(node) {
        const anchor = getMicAnchorElement();
        if (!anchor) return safeAppendToHost(node);

        // Ensure we can absolutely position inside the anchor.
        if (anchor instanceof HTMLElement) {
            const computed = window.getComputedStyle(anchor);
            if (computed.position === "static") {
                anchor.style.position = "relative";
            }
        }

        anchor.appendChild(node);
        return true;
    }

    function getPromptText(promptEl) {
        if (!promptEl) {
            return "";
        }

        if (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT") {
            return promptEl.value || "";
        }

        return promptEl.innerText || "";
    }

    function setPromptText(promptEl, text) {
        if (!promptEl) {
            return;
        }

        if (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT") {
            promptEl.value = text;
            promptEl.dispatchEvent(new Event("input", { bubbles: true }));
            return;
        }

        promptEl.innerText = text;
        promptEl.dispatchEvent(new Event("input", { bubbles: true }));
    }

    function buildNextText(currentText, incomingText) {
        if (!settings.appendMode) {
            return incomingText;
        }

        const trimmedCurrent = currentText.trim();
        const trimmedIncoming = incomingText.trim();

        if (!trimmedCurrent) {
            return incomingText;
        }

        if (!trimmedIncoming) {
            return currentText;
        }

        return `${currentText}${settings.appendSeparator}${incomingText}`;
    }

    function handleTranscription(message) {
        const cleanedMessage = (message || "").trim();
        if (!cleanedMessage) {
            return;
        }

        if (cleanedMessage === lastReceived) {
            return;
        }

        const promptEl = getPromptElement();
        if (!promptEl) {
            log("Prompt element not found");
            return;
        }

        const currentText = getPromptText(promptEl);
        const nextText = buildNextText(currentText, cleanedMessage);

        setPromptText(promptEl, nextText);
        lastReceived = cleanedMessage;
        lastTranscribedText = cleanedMessage;
    }

    function joinTranscriptionText(a, b) {
        const left = (a || "");
        const right = (b || "");
        if (!left) return right;
        if (!right) return left;
        if (/\s$/.test(left) || /^\s/.test(right)) return left + right;
        if (/^[,.;:!?)}\]]/.test(right)) return left + right;
        return left + " " + right;
    }

    function joinWithSeparator(base, sep, addition) {
        const left = (base || "");
        const right = (addition || "");
        if (!left) return right;
        if (!right) return left;
        if (!sep) return left + right;
        return left.endsWith(sep) ? left + right : left + sep + right;
    }

    function renderSessionText() {
        const promptEl = getPromptElement();
        if (!promptEl) return;

        const speechText = joinTranscriptionText(sessionCommittedText, currentPartialText);
        const appendMode = Boolean(settings.appendMode);

        let next;
        if (!appendMode) {
            next = ensurePrefix(speechText);
        } else {
            const base = ensurePrefix(sessionBaseText);
            next = joinWithSeparator(base, settings.appendSeparator, speechText);
        }

        setPromptText(promptEl, next);
    }

    function getComposerFormElement() {
        const promptEl = getPromptElement();
        if (promptEl && typeof promptEl.closest === "function") {
            const form = promptEl.closest("form");
            if (form) return form;
        }

        const container = getPromptContainerElement();
        if (container && typeof container.closest === "function") {
            const form = container.closest("form");
            if (form) return form;
        }

        return null;
    }

    function isLikelyVoiceButton(btn) {
        if (!btn || !(btn instanceof HTMLElement)) return false;
        const aria = (btn.getAttribute("aria-label") || "").toLowerCase();
        if (aria.includes("voice") || aria.includes("dictate")) return true;
        return false;
    }

    function findChatGptSendButton() {
        const candidates = [
            'button[type="submit"]',
            'button[data-testid="send-button"]',
            'button[data-testid="composer-submit-button"]',
            "button.composer-submit-button",
            "button.composer-submit-button-color",
            'button[aria-label="Send"]',
            'button[aria-label="Send prompt"]',
            'button[aria-label="Send message"]',
            'button[aria-label="Send Message"]',
        ];

        const formEl = getComposerFormElement();
        if (formEl) {
            for (const sel of candidates) {
                const btn = formEl.querySelector(sel);
                if (btn && !isLikelyVoiceButton(btn)) return btn;
            }
        }

        for (const sel of candidates) {
            const btn = document.querySelector(sel);
            if (btn && !isLikelyVoiceButton(btn)) return btn;
        }

        return null;
    }

    function submitChatGptComposer() {
        const promptEl = getPromptElement();
        const formEl = getComposerFormElement();

        try {
            promptEl?.focus?.();
        } catch {
            // ignore
        }

        const sendBtn = findChatGptSendButton();
        if (sendBtn) {
            try {
                sendBtn.click();
                return true;
            } catch {
                // ignore
            }
        }

        // Preferred fallback: trigger native form submission.
        if (formEl) {
            try {
                if (typeof formEl.requestSubmit === "function") {
                    formEl.requestSubmit();
                    return true;
                }
            } catch {
                // ignore
            }

            // Older fallback: inject a temporary submit button and click it.
            try {
                const tmp = document.createElement("button");
                tmp.type = "submit";
                tmp.style.display = "none";
                formEl.appendChild(tmp);
                tmp.click();
                tmp.remove();
                return true;
            } catch {
                // ignore
            }
        }

        // Last resort: emulate Enter on the prompt.
        if (promptEl) {
            try {
                const down = new KeyboardEvent("keydown", {
                    key: "Enter",
                    code: "Enter",
                    bubbles: true,
                    cancelable: true,
                });
                const up = new KeyboardEvent("keyup", {
                    key: "Enter",
                    code: "Enter",
                    bubbles: true,
                    cancelable: true,
                });
                promptEl.dispatchEvent(down);
                promptEl.dispatchEvent(up);
                return true;
            } catch {
                // ignore
            }
        }

        return false;
    }

    function isSubmitButtonDisabled(btn) {
        if (!btn || !(btn instanceof HTMLElement)) return true;
        if (btn.hasAttribute("disabled")) return true;
        const ariaDisabled = (btn.getAttribute("aria-disabled") || "").toLowerCase();
        if (ariaDisabled === "true") return true;
        return false;
    }

    async function submitChatGptComposerWithRetry({ timeoutMs = 2000 } = {}) {
        const startedAt = Date.now();
        const promptEl = getPromptElement();

        // Do not attempt submit for an empty prompt.
        const initialText = promptEl ? getPromptText(promptEl).trim() : "";
        if (!initialText) return false;

        while (Date.now() - startedAt < timeoutMs) {
            const btn = findChatGptSendButton();
            if (btn && !isLikelyVoiceButton(btn) && !isSubmitButtonDisabled(btn)) {
                try {
                    btn.click();
                    return true;
                } catch {
                    // ignore and retry
                }
            }

            // If we don't have a stable "send" control yet, try the generic submit fallback.
            // (Some ChatGPT builds only create the submit button after React state catches up.)
            const didSubmit = submitChatGptComposer();
            if (didSubmit) {
                return true;
            }

            await new Promise((r) => setTimeout(r, 50));
        }

        return false;
    }

    async function waitForPromptToClear({ timeoutMs = 2500 } = {}) {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
            const promptEl = getPromptElement();
            const text = promptEl ? getPromptText(promptEl).trim() : "";
            if (!text) return true;
            await new Promise((r) => setTimeout(r, 50));
        }
        return false;
    }

    function startSessionIfNeeded() {
        if (isRecordingSession) return;
        const promptEl = getPromptElement();
        const currentText = promptEl ? getPromptText(promptEl) : "";
        const withPrefix = ensurePrefix(currentText);
        if (promptEl && withPrefix !== currentText) {
            suppressAutoResetFor(750);
            setPromptText(promptEl, withPrefix);
        }
        sessionBaseText = withPrefix;
        sessionCommittedText = "";
        currentPartialText = "";
        previewText = "";
        isRecordingSession = true;
    }

    function resetSessionState({ clearPrompt = false } = {}) {
        const promptEl = getPromptElement();
        if (clearPrompt && promptEl) {
            setPromptText(promptEl, promptPrefixText || "");
        }
        isRecordingSession = false;
        sessionBaseText = "";
        sessionCommittedText = "";
        currentPartialText = "";
        previewText = "";
    }

    function isPromptElement(el) {
        const promptEl = getPromptElement();
        return !!promptEl && (el === promptEl || (typeof promptEl.contains === "function" && promptEl.contains(el)));
    }

    function scheduleSessionResetAfterSend() {
        // When the user sends while *still recording*, Speechmatics will keep streaming
        // and our UI renderer will keep re-populating the prompt unless we reset both:
        // - the UI session buffers
        // - the transcriber buffers (currentTranscript/currentPartial)
        //
        // Do it on the next tick so ChatGPT's send handler can read the current composer text.
        setTimeout(() => {
            const transcriber =
                (typeof window !== "undefined" && (window.SpeechmasticsTranscriber || window.SpeechmaticsTranscriber)) ||
                null;
            const stillRecording =
                !!transcriber && typeof transcriber.isRecording === "function" ? transcriber.isRecording() : false;

            // Capture the post-send prompt. In practice, ChatGPT may clear a moment later,
            // but for voice sessions we want the *next utterance* to start from empty.
            const promptEl = getPromptElement();
            const postSendText = promptEl ? getPromptText(promptEl) : "";

            // Reset internal buffers so the next transcription starts fresh.
            // Do NOT carry over the previous message text even if ChatGPT hasn't cleared yet.
            sessionBaseText = "";
            sessionCommittedText = "";
            currentPartialText = "";
            previewText = "";

            // Keep session active if recording continues; otherwise fully reset.
            isRecordingSession = stillRecording;

            // Tell the transcriber to drop its accumulated buffers too.
            try {
                window.dispatchEvent(
                    new CustomEvent("__testExtChatUi", { detail: { type: "resetSession" } })
                );
            } catch {
                // ignore
            }

            // If recording continues, force-clear the composer so we don't append to the previous message.
            if (stillRecording && promptEl) {
                // Prevent our own "prompt cleared" detector from re-triggering.
                suppressAutoResetFor(750);
                setPromptText(promptEl, promptPrefixText || "");
            }

            // Also reset session id gating; we’ll accept the next session id the transcriber emits.
            activeTranscriptionSessionId = null;

            renderSessionText();

            if (!stillRecording) {
                // If recording isn't ongoing, fully reset so next start captures a fresh base.
                resetSessionState({ clearPrompt: false });
            }
        }, 0);
    }

    // Handle partial transcription (real-time updates)
    function handlePartialTranscription(text, isPartial) {
        if (!isRecordingSession) {
            // Ignore late/stray partials when not actively recording.
            return;
        }

        if (isPartial) {
            currentPartialText = text;
            // Show partial text in preview if enabled
            if (settings.showPartialTranscript) {
                displayPartialTranscript(text);
            }
        } else {
            currentPartialText = "";
            clearPartialPreview();
        }
    }

    // Handle transcription insertion
    function handleInsertTranscription(text, autoEnter) {
        const promptEl = getPromptElement();
        if (!promptEl) {
            log("Prompt element not found");
            return;
        }

        const currentText = getPromptText(promptEl);
        const nextText = buildNextText(currentText, text);
        setPromptText(promptEl, nextText);
        lastTranscribedText = text; // Store for deletion
        clearPartialPreview();

        log("Transcription inserted:", text);
        showSuccessToast(text);

        // Auto-send message to ChatGPT if enabled
        if (settings.autoSubmitMessage) {
            setTimeout(() => {
                if (submitChatGptComposer()) {
                    log("Auto-sent message to ChatGPT");
                }
            }, 100);
        }
        // Otherwise auto-press Enter if enabled (just inserts Enter without sending)
        else if (autoEnter) {
            setTimeout(() => {
                if (submitChatGptComposer()) {
                    log("Auto-submitted message");
                }
            }, 100);
        }
    }

    // Delete last transcribed text
    function handleDeleteTranscribedText() {
        if (!lastTranscribedText.trim()) {
            return;
        }

        const promptEl = getPromptElement();
        if (!promptEl) return;

        let currentText = getPromptText(promptEl);

        // Remove the transcribed text from the end
        if (currentText.trim().endsWith(lastTranscribedText.trim())) {
            const idx = currentText.lastIndexOf(lastTranscribedText);
            if (idx !== -1) {
                currentText = currentText.substring(0, idx);
                // Also remove the trailing separator
                const sep = settings.appendSeparator;
                if (currentText.endsWith(sep)) {
                    currentText = currentText.substring(0, currentText.length - sep.length);
                }
                setPromptText(promptEl, currentText);
                lastTranscribedText = "";
                showInfoToast("Transcribed text deleted");
                log("Transcribed text deleted");
                return;
            }
        }

        showErrorToast("Could not delete - text not found");
    }

    // Create mic toggle button above textarea
    function createMicToggleButton() {
        const host = getDomHost();
        if (micToggleButton && host && host.contains(micToggleButton)) {
            return micToggleButton;
        }

        // Remove legacy floating mic indicator to avoid multiple extension controls.
        document.querySelector("#speechmatics-mic-status")?.remove();

        const promptContainer = getPromptContainerElement();
        if (!promptContainer) {
            return null;
        }

        // Check if already exists anywhere (we position it as a floating/fixed button).
        const existing = document.querySelector("#speechmatics-mic-toggle");
        if (existing) {
            micToggleButton = existing;
            positionMicToggleButton();
            return existing;
        }

        const button = document.createElement("button");
        button.id = "speechmatics-mic-toggle";
        button.type = "button";
        button.title = "Click to toggle recording (or hold spacebar when not typing)";
        button.innerHTML = "🎤";
        button.style.cssText = `
        position: fixed;
        top: 10px;
        left: 10px;
        width: 36px;
        height: 36px;
        border-radius: 50%;
        background: #f0f0f0;
        border: 1px solid #999;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        z-index: 10005;
        transition: all 0.2s ease;
        padding: 0;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    `;

        // Add hover effect
        button.addEventListener("mouseenter", () => {
            button.style.background = "#e0e0e0";
            button.style.boxShadow = "0 4px 8px rgba(0, 0, 0, 0.15)";
        });

        button.addEventListener("mouseleave", () => {
            const isRecording =
                typeof window.SpeechmasticsTranscriber !== "undefined" &&
                    window.SpeechmasticsTranscriber &&
                    typeof window.SpeechmasticsTranscriber.isRecording === "function"
                    ? window.SpeechmasticsTranscriber.isRecording()
                    : false;
            button.style.background = isRecording ? "#ff4444" : "#f0f0f0";
            button.style.boxShadow = isRecording
                ? "0 0 12px rgba(255, 68, 68, 0.6)"
                : "0 2px 4px rgba(0, 0, 0, 0.1)";
        });

        // Handle click to toggle recording
        button.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();

            try {
                if (
                    typeof window.SpeechmasticsTranscriber === "undefined" ||
                    !window.SpeechmasticsTranscriber ||
                    typeof window.SpeechmasticsTranscriber.toggleRecording !==
                    "function"
                ) {
                    throw new Error(
                        "Transcriber not initialized yet. Try again in a moment."
                    );
                }

                await window.SpeechmasticsTranscriber.toggleRecording();
                updateMicToggleButton();
            } catch (error) {
                log("Error toggling recording:", error);
                showErrorToast("Recording error: " + error.message);
            }
        });

        // Append to the page root; we position it with fixed coordinates relative to the
        // composer bounding box so we don't overlap ChatGPT's own buttons.
        safeAppendToHost(button);
        micToggleButton = button;
        positionMicToggleButton();
        scheduleMicPositioning();

        return button;
    }

    function scheduleMicPositioning() {
        if (!micToggleButton) return;
        if (micPositionRaf) {
            cancelAnimationFrame(micPositionRaf);
            micPositionRaf = null;
        }

        const startedAt = performance.now();
        const run = () => {
            // Re-position for a short time to account for late-rendered controls.
            positionMicToggleButton();
            if (performance.now() - startedAt < 2500) {
                micPositionRaf = requestAnimationFrame(run);
            } else {
                micPositionRaf = null;
            }
        };

        micPositionRaf = requestAnimationFrame(run);
    }

    function positionMicToggleButton() {
        if (!micToggleButton) {
            return;
        }
        const size = 36;

        // Preferred placement: fixed above the top-right corner of the composer pill.
        // This avoids overlapping ChatGPT's built-in voice / dictation buttons.
        const anchor =
            getComposerSurfaceElement() ||
            getPromptContainerElement() ||
            getDomHost();
        if (!anchor) return;

        const rect = anchor.getBoundingClientRect();
        const gap = 12; // distance from the composer edge

        // Place fully above the composer. (We previously used half-overlap which looked bad.)
        const top = rect.top - size - gap;
        const left = rect.right - size - gap;

        const clampedTop = Math.max(8, Math.min(top, window.innerHeight - size - 8));
        const clampedLeft = Math.max(8, Math.min(left, window.innerWidth - size - 8));

        micToggleButton.style.position = "fixed";
        micToggleButton.style.top = `${Math.round(clampedTop)}px`;
        micToggleButton.style.left = `${Math.round(clampedLeft)}px`;
    }

    // Update mic toggle button visual state
    // Button states tracking for visual feedback
    let buttonState = 'idle'; // idle, connecting, recording, error

    // Update mic toggle button visual state
    function updateMicToggleButton(state = null) {
        if (!micToggleButton) return;

        // Determine state
        let currentState = state || buttonState;
        const isRecording =
            typeof window.SpeechmasticsTranscriber !== "undefined" &&
                window.SpeechmasticsTranscriber &&
                typeof window.SpeechmasticsTranscriber.isRecording === "function"
                ? window.SpeechmasticsTranscriber.isRecording()
                : false;

        if (isRecording) {
            currentState = 'recording';
        } else if (currentState === 'recording') {
            currentState = 'idle';
        }

        buttonState = currentState;

        // Apply state-specific styling
        const stateStyles = {
            'idle': {
                background: '#f0f0f0',
                borderColor: '#999',
                boxShadow: '0 2px 4px rgba(0, 0, 0, 0.1)',
                icon: '🎤',
                title: 'Click to start recording (or hold spacebar)'
            },
            'connecting': {
                background: '#FFC107',
                borderColor: '#FFA000',
                boxShadow: '0 0 10px rgba(255, 193, 7, 0.4)',
                icon: '🔄',
                title: 'Connecting...',
                class: 'connecting'
            },
            'recording': {
                background: '#ff4444',
                borderColor: '#cc0000',
                boxShadow: '0 0 12px rgba(255, 68, 68, 0.6)',
                icon: '🔴',
                title: 'Recording... Click to stop',
                class: 'recording'
            },
            'error': {
                background: '#ff5252',
                borderColor: '#d32f2f',
                boxShadow: '0 0 12px rgba(255, 82, 82, 0.5)',
                icon: '⚠️',
                title: 'Error - Click to retry',
                class: 'error'
            }
        };

        const style = stateStyles[currentState] || stateStyles['idle'];

        micToggleButton.style.background = style.background;
        micToggleButton.style.borderColor = style.borderColor;
        micToggleButton.style.boxShadow = style.boxShadow;
        micToggleButton.innerHTML = style.icon;
        micToggleButton.title = style.title;

        // Update animation classes
        micToggleButton.classList.remove('recording', 'connecting', 'error');
        if (currentState === 'recording') {
            micToggleButton.classList.add('recording');
        } else if (currentState === 'connecting') {
            micToggleButton.classList.add('connecting');
        } else if (currentState === 'error') {
            micToggleButton.classList.add('error');
        }
    }

    function handleAppendCommittedTranscript(text) {
        if (!text || !String(text).trim()) return;
        startSessionIfNeeded();
        sessionCommittedText = joinTranscriptionText(sessionCommittedText, text);
        lastTranscribedText = text;
        // Once we get committed chunks, we re-render prompt using base + committed (+ current partial).
        renderSessionText();
    }

    function handleFinalizeTranscription({ autoEnter } = {}) {
        if (!isRecordingSession) {
            return;
        }

        // Remove partial overlay, keep committed text in the box.
        currentPartialText = "";
        previewText = "";
        renderSessionText();

        // Never submit if we have no committed transcript.
        const hasCommitted = Boolean((sessionCommittedText || "").trim());

        const shouldAutoSend = Boolean(settings.autoSubmitMessage) || Boolean(autoEnter);
        if (!shouldAutoSend || !hasCommitted) {
            // User may want to edit before sending.
            isRecordingSession = false;
            return;
        }

        (async () => {
            const didSubmit = await submitChatGptComposerWithRetry({ timeoutMs: 2000 });
            if (!didSubmit) {
                showErrorToast("Couldn't submit: Send action not available");
                // Keep the text so the user can manually click Send.
                isRecordingSession = false;
                return;
            }

            // Don't clear the prompt ourselves; only reset our internal buffers once ChatGPT clears it.
            const cleared = await waitForPromptToClear({ timeoutMs: 2500 });
            if (cleared) {
                resetSessionState({ clearPrompt: false });
            } else {
                // ChatGPT didn't clear (submission may have been prevented). Keep state but stop session.
                isRecordingSession = false;
            }
        })();
    }

    // Display partial transcription in textarea
    function displayPartialTranscript(text) {
        if (!settings.showPartialTranscript) return;
        if (!isRecordingSession) return;
        // Render using current session state, which keeps committed text stable while partials change.
        previewText = text;
        renderSessionText();
    }

    // Clear partial preview
    function clearPartialPreview() {
        previewText = "";
        if (isRecordingSession) {
            renderSessionText();
        }
    }

    // Create mic status indicator
    function createMicStatusIndicator() {
        // Deprecated: we only keep one mic control (the floating toggle button).
        // This is left for backward compatibility but should not be used.
        const host = document.body || document.documentElement;
        if (!host) {
            return null;
        }

        if (micStatusIndicator && host.contains(micStatusIndicator)) {
            return micStatusIndicator;
        }

        const indicator = document.createElement("div");
        indicator.id = "speechmatics-mic-status";
        indicator.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 50px;
        height: 50px;
        border-radius: 50%;
        background: #f0f0f0;
        border: 2px solid #999;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        z-index: 10000;
        font-size: 24px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
        transition: all 0.3s ease;
        user-select: none;
    `;
        indicator.innerHTML = "🎤";
        indicator.title = "WisperSend: Hold Space to talk";

        // Click to toggle recording (optional)
        indicator.addEventListener("click", () => {
            log("Mic indicator clicked");
        });

        safeAppendToHost(indicator);
        micStatusIndicator = indicator;
        return indicator;
    }

    // Update mic status indicator (floating indicator in corner)
    function updateMicStatus(recording) {
        // Single source of truth for visuals is the toggle button.
        updateMicToggleButton(recording ? "recording" : "idle");
        if (recording) {
            startSessionIfNeeded();
        } else if (isRecordingSession) {
            // Remove partial overlay when stopping recording; keep committed text.
            currentPartialText = "";
            previewText = "";
            renderSessionText();
            isRecordingSession = false;
        }
    }

    function installSendResetHooks() {
        if (window.__testExtSendResetHooksInstalled) return;
        window.__testExtSendResetHooksInstalled = true;

        const sendButtonSelector = [
            'button[data-testid="send-button"]',
            'button[data-testid="composer-submit-button"]',
            "button.composer-submit-button",
            "button.composer-submit-button-color",
            'button[aria-label="Send"]',
            'button[aria-label="Send prompt"]',
            'button[aria-label="Send message"]',
        ].join(",");

        function isOurMicButton(el) {
            const id = el?.id;
            return id === "speechmatics-mic-toggle" || id === "speechmatics-mic-status";
        }

        function isComposerForm(formEl) {
            if (!formEl || !(formEl instanceof HTMLElement)) return false;
            const promptEl = getPromptElement();
            if (!promptEl) return false;
            try {
                return formEl.contains(promptEl);
            } catch {
                return false;
            }
        }

        function isLikelySendControl(el) {
            if (!el || !(el instanceof HTMLElement)) return false;
            if (isOurMicButton(el)) return false;

            const aria = (el.getAttribute("aria-label") || "").toLowerCase();
            // Avoid matching ChatGPT's own voice/dictation controls.
            if (aria.includes("voice") || aria.includes("dictate")) return false;

            const testId = (el.getAttribute("data-testid") || "").toLowerCase();
            if (testId.includes("send") || testId.includes("composer-submit")) return true;

            const type = (el.getAttribute("type") || "").toLowerCase();
            if (type === "submit") return true;

            const cls = (el.className || "").toString();
            if (cls.includes("composer-submit-button")) return true;

            if (aria.includes("send")) return true;
            return false;
        }

        // If the user clicks the Send button manually (after a voice draft), reset our buffers.
        document.addEventListener(
            "click",
            (e) => {
                const target = e.target;
                const btn =
                    target?.closest?.(sendButtonSelector) ||
                    target?.closest?.("button,[role='button']") ||
                    null;

                // Fast path: explicit selector match.
                if (btn && btn.matches?.(sendButtonSelector) && !isOurMicButton(btn)) {
                    scheduleSessionResetAfterSend();
                    return;
                }

                // Heuristic path: any likely "send" control inside the composer form.
                const formEl = btn?.closest?.("form") || target?.closest?.("form") || null;
                if (!isComposerForm(formEl)) return;
                if (!isLikelySendControl(btn)) return;
                scheduleSessionResetAfterSend();
            },
            true
        );

        // If the user submits the composer form (covers some UI variants that don't use our selectors).
        document.addEventListener(
            "submit",
            (e) => {
                const formEl = e.target;
                if (!isComposerForm(formEl)) return;
                scheduleSessionResetAfterSend();
            },
            true
        );

        // If the user presses Enter in the composer (ChatGPT send shortcut), reset buffers.
        document.addEventListener(
            "keydown",
            (e) => {
                if (e.key !== "Enter") return;
                if (e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
                if (e.isComposing) return;
                if (!isPromptElement(e.target)) return;
                scheduleSessionResetAfterSend();
            },
            true
        );

        // If ChatGPT clears the prompt after sending, ensure we don't keep stale base/committed text.
        document.addEventListener(
            "input",
            (e) => {
                if (!isPromptElement(e.target)) return;
                const promptEl = getPromptElement();
                const text = promptEl ? getPromptText(promptEl).trim() : "";
                if (!text && isRecordingSession && !isAutoResetSuppressed()) {
                    // Some ChatGPT builds don't expose stable send button selectors/events.
                    // When the composer clears while we're still recording, treat it as "Send".
                    scheduleSessionResetAfterSend();
                    return;
                }
                if (!text && !isRecordingSession) {
                    resetSessionState({ clearPrompt: false });
                }
            },
            true
        );
    }

    // Show notification (legacy - kept for backward compatibility)
    function showNotification(message, type = "info") {
        if (type === "success") {
            showSuccessToast(message);
        } else if (type === "error") {
            showErrorToast(message);
        } else {
            showInfoToast(message);
        }
    }

    // Enhanced success toast with animation and styling
    function showSuccessToast(message, duration = 2500) {
        const toast = document.createElement("div");
        toast.className = "speechmatics-success-toast";

        // Extract just the text if it has the old format
        const displayText = message.replace(/^✓ Transcribed: |[\"']/g, '').replace(/\.\.\.[\"']?$/, '');
        const truncated = displayText.length > 50 ? displayText.substring(0, 50) + "..." : displayText;

        toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 20px;
        background: linear-gradient(135deg, #4CAF50 0%, #45a049 100%);
        color: white;
        padding: 14px 18px;
        border-radius: 8px;
        z-index: 10002;
        font-size: 14px;
        font-weight: 500;
        max-width: 320px;
        word-wrap: break-word;
        box-shadow: 0 4px 12px rgba(76, 175, 80, 0.3), 0 2px 4px rgba(0, 0, 0, 0.1);
        animation: slideInToast 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        border-left: 4px solid #2e7d32;
        display: flex;
        align-items: center;
        gap: 10px;
    `;

        toast.innerHTML = `
        <span style="font-size: 18px; flex-shrink: 0;">✓</span>
        <span>Transcribed: "${truncated}"</span>
    `;

        safeAppendToHost(toast);

        // Auto-remove with slide out animation
        setTimeout(() => {
            toast.style.animation = "slideOutToast 0.3s cubic-bezier(0.4, 0, 1, 1) forwards";
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // Enhanced error toast
    function showErrorToast(message, duration = 3000) {
        const toast = document.createElement("div");
        toast.className = "speechmatics-error-toast";

        toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 20px;
        background: linear-gradient(135deg, #ff5252 0%, #ff1744 100%);
        color: white;
        padding: 14px 18px;
        border-radius: 8px;
        z-index: 10002;
        font-size: 14px;
        font-weight: 500;
        max-width: 320px;
        word-wrap: break-word;
        box-shadow: 0 4px 12px rgba(255, 23, 68, 0.3), 0 2px 4px rgba(0, 0, 0, 0.1);
        animation: slideInToast 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        border-left: 4px solid #c62828;
        display: flex;
        align-items: center;
        gap: 10px;
    `;

        toast.innerHTML = `
        <span style="font-size: 18px; flex-shrink: 0;">⚠️</span>
        <span>${message}</span>
    `;

        safeAppendToHost(toast);

        // Auto-remove with slide out animation
        setTimeout(() => {
            toast.style.animation = "slideOutToast 0.3s cubic-bezier(0.4, 0, 1, 1) forwards";
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // Info toast
    function showInfoToast(message, duration = 2000) {
        const toast = document.createElement("div");
        toast.className = "speechmatics-info-toast";

        toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 20px;
        background: linear-gradient(135deg, #2196F3 0%, #1976D2 100%);
        color: white;
        padding: 14px 18px;
        border-radius: 8px;
        z-index: 10002;
        font-size: 14px;
        font-weight: 500;
        max-width: 320px;
        word-wrap: break-word;
        box-shadow: 0 4px 12px rgba(33, 150, 243, 0.3), 0 2px 4px rgba(0, 0, 0, 0.1);
        animation: slideInToast 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        border-left: 4px solid #0d47a1;
        display: flex;
        align-items: center;
        gap: 10px;
    `;

        toast.innerHTML = `
        <span style="font-size: 18px; flex-shrink: 0;">ℹ️</span>
        <span>${message}</span>
    `;

        safeAppendToHost(toast);

        // Auto-remove with slide out animation
        setTimeout(() => {
            toast.style.animation = "slideOutToast 0.3s cubic-bezier(0.4, 0, 1, 1) forwards";
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    // Show connection status feedback
    function showConnectionStatus(status) {
        const statusMap = {
            'connecting': { icon: '🔄', message: 'Connecting...', color: '#FFC107', duration: 1000 },
            'connected': { icon: '✓', message: 'Ready to record', color: '#4CAF50', duration: 1500 },
            'disconnected': { icon: '✗', message: 'Disconnected', color: '#ff5252', duration: 2000 },
            'error': { icon: '⚠️', message: 'Connection error', color: '#ff1744', duration: 3000 },
        };

        const info = statusMap[status] || statusMap['info'];
        if (!info) return;

        const toast = document.createElement("div");
        toast.className = `speechmatics-status-toast speechmatics-status-${status}`;

        toast.style.cssText = `
        position: fixed;
        top: 20px;
        right: 20px;
        background: ${info.color};
        color: white;
        padding: 12px 16px;
        border-radius: 6px;
        z-index: 10001;
        font-size: 13px;
        font-weight: 500;
        box-shadow: 0 3px 8px rgba(0, 0, 0, 0.2);
        animation: slideInToast 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        display: flex;
        align-items: center;
        gap: 8px;
    `;

        toast.innerHTML = `
        <span>${info.icon}</span>
        <span>${info.message}</span>
    `;

        safeAppendToHost(toast);

        setTimeout(() => {
            toast.style.animation = "slideOutToast 0.3s cubic-bezier(0.4, 0, 1, 1) forwards";
            setTimeout(() => toast.remove(), 300);
        }, info.duration);
    }

    chrome.runtime.onMessage.addListener((request) => {
        // Legacy transcription handling
        if (request?.eventType === EVENTS.TRANSCRIPTION) {
            handleTranscription(request.message);
            return;
        }

        // New Speechmatics messages
        if (request.type === "insertTranscription") {
            handleInsertTranscription(request.text, request.autoEnter);
            return;
        }

        if (request.type === "updateTranscription") {
            handlePartialTranscription(request.text, request.isPartial);
            return;
        }

        if (request.type === "micStatus") {
            updateMicStatus(request.recording);
            return;
        }

        if (request.type === "showError") {
            // Use enhanced error toast if available, otherwise fallback
            if (request.errorType === 'permission') {
                showErrorToast("❌ Microphone access denied. Please check permissions.");
            } else if (request.errorType === 'connection' || request.errorType === 'timeout') {
                showErrorToast("⚠️ Connection error: " + request.message);
            } else {
                showErrorToast(request.message);
            }
            return;
        }

        if (request.type === "updateButtonState") {
            updateMicToggleButton(request.state);
            return;
        }

        if (request.type === "connectionStatus") {
            // Show status indicator and update button
            showConnectionStatus(request.status);
            updateMicToggleButton(request.status === 'connecting' ? 'connecting' :
                request.status === 'connected' ? 'idle' : 'error');
            return;
        }
    });

    // Internal bus: used by the API-based transcriber running in the same ChatGPT tab.
    window.addEventListener("__testExtTranscriber", (event) => {
        const request = event?.detail;
        if (!request) {
            return;
        }

        // Ignore late messages from an older Speechmatics session (we fast-reconnect on Send).
        if (typeof request.sessionId === "number") {
            if (activeTranscriptionSessionId == null) {
                activeTranscriptionSessionId = request.sessionId;
            } else if (request.sessionId !== activeTranscriptionSessionId) {
                // Allow session id change only when we receive a micStatus/connectionStatus,
                // otherwise treat it as stale.
                if (request.type !== "micStatus" && request.type !== "connectionStatus") {
                    return;
                }
                activeTranscriptionSessionId = request.sessionId;
            }
        }

        if (request.type === "insertTranscription") {
            handleInsertTranscription(request.text, request.autoEnter);
            return;
        }

        if (request.type === "appendCommittedTranscript") {
            handleAppendCommittedTranscript(request.text);
            return;
        }

        if (request.type === "updateTranscription") {
            handlePartialTranscription(request.text, request.isPartial);
            return;
        }

        if (request.type === "micStatus") {
            updateMicStatus(request.recording);
            return;
        }

        if (request.type === "finalizeTranscription") {
            handleFinalizeTranscription({ autoEnter: request.autoEnter });
            return;
        }

        if (request.type === "showError") {
            if (request.errorType === "permission") {
                showErrorToast("❌ Microphone access denied. Please check permissions.");
            } else if (
                request.errorType === "connection" ||
                request.errorType === "timeout"
            ) {
                showErrorToast("⚠️ Connection error: " + request.message);
            } else {
                showErrorToast(request.message);
            }
            return;
        }

        if (request.type === "updateButtonState") {
            updateMicToggleButton(request.state);
        }
    });

    // Setup Escape key listener: clear composer + reset Speechmatics session buffers.
    document.addEventListener("keydown", (event) => {
        if (event.key !== "Escape") return;
        if (event.isComposing) return;

        // Only hijack Escape when it relates to the composer/recording session.
        if (!isRecordingSession && !isPromptElement(event.target)) {
            return;
        }

        event.preventDefault();
        hardResetTranscription({ stopRecording: false });
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") {
            return;
        }

        Object.keys(changes).forEach((key) => {
            settings[key] = changes[key].newValue;
        });

        if (Object.prototype.hasOwnProperty.call(changes, "promptChecklist")) {
            refreshPromptPrefixFromSettings();
            if (!isRecordingSession) {
                const promptEl = getPromptElement();
                if (promptEl) {
                    const current = getPromptText(promptEl);
                    const next = ensurePrefix(current);
                    if (next !== current) {
                        suppressAutoResetFor(750);
                        setPromptText(promptEl, next);
                    }
                }
            }
        }
    });

    loadSettings();
    // Remove legacy floating status indicator from older versions (prevents "2 mic" issue).
    try {
        document.querySelector("#speechmatics-mic-status")?.remove();
    } catch {
        // ignore
    }

    function ensureChatUiInjected() {
        const btn = createMicToggleButton();
        if (!btn) {
            return false;
        }
        updateMicToggleButton();
        addAnimationStyles();
        return true;
    }

    // ChatGPT is an SPA; the prompt may appear after initial load or route changes.
    // Use a MutationObserver so our UI reliably shows up.
    function startChatUiObserver() {
        const root = getDomHost();
        if (!root) {
            return;
        }

        if (ensureChatUiInjected()) {
            return;
        }

        const observer = new MutationObserver(() => {
            if (ensureChatUiInjected()) {
                observer.disconnect();
            }
        });

        observer.observe(root, { childList: true, subtree: true });

        // Safety: stop observing after 30s to avoid extra work on long-lived tabs.
        setTimeout(() => observer.disconnect(), 30000);
    }

    // Keep the floating mic button anchored to the prompt on resizes / layout changes.
    window.addEventListener("resize", () => {
        positionMicToggleButton();
    });

    window.addEventListener(
        "scroll",
        () => {
            positionMicToggleButton();
        },
        { passive: true }
    );

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", startChatUiObserver, {
            once: true,
        });
    } else {
        startChatUiObserver();
    }

    installSendResetHooks();

    // Add animation styles for recording indicator and toasts
    function addAnimationStyles() {
        if (document.querySelector("#speechmatics-animations")) {
            return;
        }

        const styleTag = document.createElement("style");
        styleTag.id = "speechmatics-animations";
        styleTag.textContent = `
        /* Mic button pulsing animation */
        @keyframes micPulse {
            0% {
                box-shadow: 0 0 12px rgba(255, 68, 68, 0.6);
            }
            50% {
                box-shadow: 0 0 20px rgba(255, 68, 68, 0.8);
            }
            100% {
                box-shadow: 0 0 12px rgba(255, 68, 68, 0.6);
            }
        }

        #speechmatics-mic-toggle.recording {
            animation: micPulse 1.5s infinite;
        }

        /* Toast entrance animation */
        @keyframes slideInToast {
            from {
                opacity: 0;
                transform: translateY(20px);
            }
            to {
                opacity: 1;
                transform: translateY(0);
            }
        }

        /* Toast exit animation */
        @keyframes slideOutToast {
            from {
                opacity: 1;
                transform: translateY(0);
            }
            to {
                opacity: 0;
                transform: translateY(20px);
            }
        }

        /* Toast base styles */
        .speechmatics-success-toast,
        .speechmatics-error-toast,
        .speechmatics-info-toast {
            animation: slideInToast 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        .speechmatics-status-toast {
            animation: slideInToast 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
        }

        /* Mic button states */
        #speechmatics-mic-toggle {
            transition: all 0.2s ease;
        }

        #speechmatics-mic-toggle:hover {
            transform: scale(1.08);
        }

        #speechmatics-mic-toggle:active {
            transform: scale(0.96);
        }

        /* Status indicator animations */
        .speechmatics-status-connecting {
            animation: pulse-yellow 1s infinite;
        }

        @keyframes pulse-yellow {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.7; }
        }

        .speechmatics-status-error {
            animation: shake 0.5s;
        }

        @keyframes shake {
            0%, 100% { transform: translateX(0); }
            25% { transform: translateX(-5px); }
            75% { transform: translateX(5px); }
        }
    `;
        const head = document.head || document.documentElement;
        if (head) {
            head.appendChild(styleTag);
        } else {
            safeAppendToHost(styleTag);
        }
    }

})();
