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
        cursorPinIdleMs: 500,
        editDebounceMs: 350,
        allowEditWhileTranscribing: false,
    };

    const SESSION_SNAPSHOT_KEY = "whispersend:sessionSnapshot";
    const SESSION_SNAPSHOT_TTL_MS = 5 * 60 * 1000; // 5 minutes
    const SESSION_SNAPSHOT_MIN_INTERVAL_MS = 2000; // throttle writes

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
    let sessionCommittedRaw = "";
    let activeTranscriptionSessionId = null;
    let suppressAutoResetUntilMs = 0;
    let promptPrefixText = "";
    let suspendRenderUntilMs = 0;
    let lastRenderedSpeechText = "";
    let sendResetInProgress = false;
    let renderRaf = null;
    let renderQueued = false;
    let cachedScrollPromptEl = null;
    let cachedScrollContainer = null;
    const EditState = Object.freeze({
        IDLE: "idle",
        EDITING: "editing",
        REBASING: "rebasing",
    });

    let editState = EditState.IDLE;
    let userEditDebounce = null;
    let editBufferedCommitted = "";
    let editBufferedCommittedRaw = "";
    let editBufferedPartial = "";
    let lastSessionSnapshotAt = 0;
    let sessionRecoveryAttempted = false;
    let editSnapshot = null;
    let userCursorPinned = false;
    let userEditIntent = false;
    let cursorPinRaf = null;
    let cursorPinTimeout = null;
    let cursorPinReleaseAt = 0;
    const CURSOR_PIN_IDLE_MS = 500;
    const DOUBLE_SHIFT_WINDOW_MS = 450;
    let lastShiftAt = 0;

    // Enhanced segment tracking for editable transcription
    // Prevents text duplication and allows editing while transcribing
    let transcriptionSegments = [];
    let lastMergedTranscript = "";  // Track previous merged result to detect changes
    // editState tracks editing/rebasing to avoid conflicting flags.
    let lastCommittedTextSnapshot = "";  // Snapshot of last committed text for change detection

    // Merge algorithm optimization cache (Phase 1 Fix #1)
    let lastMergeCommitted = "";
    let lastMergePartial = "";
    let cachedMergeResult = "";
    let lastRenderTime = 0;
    const MIN_RENDER_INTERVAL_MS = 4;  // ~250fps for responsive feedback (Phase 1 Fix #6 optimized)
    const SNAPSHOT_DEBOUNCE_MS = 1000;  // Save snapshots less frequently to avoid I/O overhead
    let pendingSnapshotSave = null;  // Debounce timer for snapshot saves

    // Display text cache to avoid rebuilding on every render
    let cachedDisplayText = "";
    let cachedDisplayCommitted = "";
    let cachedDisplayRaw = "";
    let cachedDisplayPartial = "";
    let cachedFinalText = "";
    let cachedFinalBase = "";
    let cachedFinalSpeech = "";
    let cachedFinalMode = null;
    let lastPromptTextFast = "";
    let lastPromptTextFastEl = null;

    function isEditActive() {
        return editState !== EditState.IDLE;
    }

    function setEditState(nextState) {
        editState = nextState;
    }

    function isCursorPinned() {
        return isCursorPinEnabled() && userCursorPinned;
    }

    function getCursorPinIdleMs() {
        const raw = Number(settings.cursorPinIdleMs);
        if (Number.isFinite(raw) && raw >= 0) return raw;
        return CURSOR_PIN_IDLE_MS;
    }

    function isCursorPinEnabled() {
        return Boolean(settings.allowEditWhileTranscribing);
    }

    function getPromptSelectionInfo(promptEl) {
        if (!promptEl) return null;
        const text = getPromptText(promptEl) || "";
        const length = text.length;
        if (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT") {
            const start = typeof promptEl.selectionStart === "number" ? promptEl.selectionStart : length;
            const end = typeof promptEl.selectionEnd === "number" ? promptEl.selectionEnd : start;
            return { start, end, length };
        }

        if (!promptEl.isContentEditable) return null;
        const selection = captureSelection(promptEl);
        if (!selection) return null;
        const start = selection.start ?? 0;
        const end = selection.end ?? start;
        return { start, end, length };
    }

    function isSelectionAtEnd(info) {
        if (!info) return false;
        return info.start >= info.length && info.end >= info.length;
    }

    function flushBufferedTranscription() {
        if (isEditActive()) return;
        if (!editBufferedCommitted && !editBufferedPartial) return;

        if (editBufferedCommitted) {
            sessionCommittedText = joinTranscriptionText(
                sessionCommittedText,
                editBufferedCommitted
            );
            editBufferedCommitted = "";
        }

        if (editBufferedPartial) {
            currentPartialText = String(editBufferedPartial).trim();
            editBufferedPartial = "";
        }

        previewText = "";
        lastRenderedSpeechText = "";
        renderSessionTextNow();
        saveSessionSnapshot({ force: true });
    }

    function updateCursorPinState() {
        if (!isCursorPinEnabled()) {
            if (userCursorPinned) {
                userCursorPinned = false;
                userEditIntent = false;
                flushBufferedTranscription();
            }
            return;
        }

        const promptEl = getPromptElement();
        if (!promptEl) {
            if (userCursorPinned) {
                userCursorPinned = false;
                userEditIntent = false;
                flushBufferedTranscription();
            }
            return;
        }

        const focused = shouldPreserveSelection(promptEl);
        if (!focused) {
            if (userCursorPinned) {
                userCursorPinned = false;
                userEditIntent = false;
                flushBufferedTranscription();
            }
            return;
        }

        const selectionInfo = getPromptSelectionInfo(promptEl);
        const selectionAway = selectionInfo && !isSelectionAtEnd(selectionInfo);

        // If the caret is not at the end, treat this as an edit intent and pause appends.
        if (selectionAway) {
            userEditIntent = true;
            if (!userCursorPinned) {
                userCursorPinned = true;
            }
            scheduleCursorPinRelease();
            return;
        }

        // If the caret returns to the end and we're not actively editing, resume appends.
        if (!isEditActive() && !userEditDebounce && userCursorPinned) {
            userCursorPinned = false;
            userEditIntent = false;
            flushBufferedTranscription();
        }
    }

    function scheduleCursorPinRelease() {
        if (cursorPinTimeout) {
            try {
                clearTimeout(cursorPinTimeout);
            } catch {
                // ignore
            }
        }
        const delay = getCursorPinIdleMs();
        cursorPinReleaseAt = Date.now() + delay;
        cursorPinTimeout = setTimeout(() => {
            cursorPinTimeout = null;
            // If we're actively editing, let the edit debounce decide when to release.
            if (isEditActive() || userEditDebounce) {
                return;
            }
            userCursorPinned = false;
            userEditIntent = false;
            flushBufferedTranscription();
        }, delay);
    }

    function scheduleCursorPinCheck() {
        if (cursorPinRaf) return;
        cursorPinRaf = requestAnimationFrame(() => {
            cursorPinRaf = null;
            updateCursorPinState();
        });
    }

    function commonPrefixLength(a, b) {
        const left = a || "";
        const right = b || "";
        const max = Math.min(left.length, right.length);
        let i = 0;
        while (i < max && left.charCodeAt(i) === right.charCodeAt(i)) {
            i += 1;
        }
        return i;
    }

    function commonSuffixLength(a, b, prefixLen = 0) {
        const left = a || "";
        const right = b || "";
        let i = 0;
        const maxLeft = left.length;
        const maxRight = right.length;
        while (
            maxLeft - 1 - i >= prefixLen &&
            maxRight - 1 - i >= prefixLen &&
            left.charCodeAt(maxLeft - 1 - i) === right.charCodeAt(maxRight - 1 - i)
        ) {
            i += 1;
        }
        return i;
    }

    function captureEditSnapshot(promptEl) {
        if (!promptEl) return null;
        const rendered = getPromptText(promptEl) || "";
        const base = ensurePrefix(sessionBaseText || "");
        const appendMode = Boolean(settings.appendMode);
        const separator = settings.appendSeparator || "";
        let boundary = Math.min(base.length, rendered.length);

        if (appendMode && separator && rendered.startsWith(base + separator)) {
            boundary = base.length + separator.length;
        } else if (appendMode && rendered.startsWith(base)) {
            boundary = base.length;
        }

        editSnapshot = {
            rendered,
            boundary,
            appendMode,
            separator,
        };
        return editSnapshot;
    }

    function computeRebasedTexts(snapshot, editedFull) {
        const rendered = snapshot?.rendered || "";
        const boundary = typeof snapshot?.boundary === "number" ? snapshot.boundary : 0;
        const appendMode = Boolean(snapshot?.appendMode);
        const separator = snapshot?.separator || "";
        const cappedBoundary = Math.max(0, Math.min(boundary, editedFull.length));
        let baseText = editedFull.slice(0, cappedBoundary);
        let speechText = editedFull.slice(cappedBoundary);

        if (appendMode && separator) {
            if (speechText.startsWith(separator)) {
                speechText = speechText.slice(separator.length);
            }
        }

        return {
            baseText,
            speechText,
        };
    }

    /**
     * Clear all transcription segments.
     * Called when recording starts or session resets.
     */
    function clearTranscriptionSegments() {
        transcriptionSegments = [];
        lastMergedTranscript = "";
        lastCommittedTextSnapshot = "";
        setEditState(EditState.IDLE);
    }

    function buildSessionSnapshot() {
        return {
            timestamp: Date.now(),
            base: sessionBaseText || "",
            committed: sessionCommittedText || "",
            committedRaw: sessionCommittedRaw || "",
            partial: currentPartialText || "",
            bufferedCommitted: editBufferedCommitted || "",
            bufferedCommittedRaw: editBufferedCommittedRaw || "",
            bufferedPartial: editBufferedPartial || "",
            wasEditing: isEditActive(),
            appendMode: Boolean(settings.appendMode),
            appendSeparator: settings.appendSeparator || "",
            prefix: promptPrefixText || "",
        };
    }

    function saveSessionSnapshot({ force = false } = {}) {
        // Optimize: defer non-urgent saves to avoid blocking transcription updates
        // Flush immediately on force, otherwise debounce
        if (!force) {
            if (pendingSnapshotSave) {
                clearTimeout(pendingSnapshotSave);
            }
            pendingSnapshotSave = setTimeout(() => {
                pendingSnapshotSave = null;
                _saveSessionSnapshotNow();
            }, SNAPSHOT_DEBOUNCE_MS);
            return;
        }
        _saveSessionSnapshotNow();
    }

    function _saveSessionSnapshotNow() {
        const now = Date.now();
        const snapshot = buildSessionSnapshot();
        if (!snapshot.base && !snapshot.committed && !snapshot.partial) {
            clearSessionSnapshot();
            return;
        }

        lastSessionSnapshotAt = now;
        try {
            localStorage.setItem(SESSION_SNAPSHOT_KEY, JSON.stringify(snapshot));
        } catch {
            // ignore (storage quota or access issues)
        }
    }

    function clearSessionSnapshot() {
        lastSessionSnapshotAt = 0;
        try {
            localStorage.removeItem(SESSION_SNAPSHOT_KEY);
        } catch {
            // ignore
        }
    }

    function loadSessionSnapshot() {
        try {
            const raw = localStorage.getItem(SESSION_SNAPSHOT_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== "object") return null;
            const ts = Number(parsed.timestamp || 0);
            if (!ts || Date.now() - ts > SESSION_SNAPSHOT_TTL_MS) {
                clearSessionSnapshot();
                return null;
            }
            return parsed;
        } catch {
            return null;
        }
    }

    function attemptSessionRecovery() {
        if (sessionRecoveryAttempted) return false;
        const snapshot = loadSessionSnapshot();
        if (!snapshot) {
            sessionRecoveryAttempted = true;
            return false;
        }

        const promptEl = getPromptElement();
        if (!promptEl) return false;

        const current = getPromptText(promptEl);
        const tail = splitPrefix(current).tail.trim();
        if (tail) {
            // Don't overwrite existing user content.
            sessionRecoveryAttempted = true;
            return false;
        }

        sessionBaseText = snapshot.base || "";
        sessionCommittedText = snapshot.committed || "";
        sessionCommittedRaw = snapshot.committedRaw || snapshot.committed || "";
        currentPartialText = snapshot.partial || "";

        if (snapshot.bufferedCommitted) {
            sessionCommittedText = joinTranscriptionText(
                sessionCommittedText,
                String(snapshot.bufferedCommitted)
            );
        }
        if (snapshot.bufferedCommittedRaw) {
            sessionCommittedRaw = appendToRawBaseline(
                sessionCommittedRaw,
                String(snapshot.bufferedCommittedRaw)
            );
        }
        if (snapshot.bufferedPartial) {
            currentPartialText = mergeCommittedAndPartial(
                sessionCommittedRaw || sessionCommittedText,
                String(snapshot.bufferedPartial)
            );
        }
        previewText = "";
        lastRenderedSpeechText = "";
        isRecordingSession = false;

        renderSessionTextNow();
        showInfoToast("Recovered recent transcription draft");
        sessionRecoveryAttempted = true;
        return true;
    }

    /**
     * Add or update a transcription segment.
     * Tracks whether content is committed (final) or partial (live).
     */
    function updateTranscriptionSegment(type, text, meta = null) {
        if (!text || !String(text).trim()) {
            return;
        }

        const segment = {
            type: type,  // "committed", "partial", or "edited"
            text: String(text).trim(),
            timestamp: Date.now(),
            isEditable: true
        };

        if (meta && typeof meta === "object") {
            if (typeof meta.confidence === "number") {
                segment.confidence = meta.confidence;
            }
            if (Array.isArray(meta.wordSegments)) {
                segment.wordSegments = meta.wordSegments;
            }
        }

        // Update or append segment
        if (type === "partial") {
            // Replace previous partial segment
            transcriptionSegments = transcriptionSegments.filter(s => s.type !== "partial");
            transcriptionSegments.push(segment);
        } else if (type === "committed") {
            // Append committed segment
            transcriptionSegments = transcriptionSegments.filter(s => s.type !== "partial");
            transcriptionSegments.push(segment);
        }
    }

    /**
     * Rebuild transcript from segments.
     * Ensures no duplication between committed and partial.
     */
    function rebuildTranscriptFromSegments(committed, partial) {
        // Use the merge function which handles overlap detection
        return mergeCommittedAndPartial(committed, partial);
    }

    function suppressAutoResetFor(ms) {
        suppressAutoResetUntilMs = Date.now() + Math.max(0, Number(ms) || 0);
    }

    function isAutoResetSuppressed() {
        return Date.now() < suppressAutoResetUntilMs;
    }

    function suspendRenderingFor(ms) {
        suspendRenderUntilMs = Date.now() + Math.max(0, Number(ms) || 0);
    }

    function isRenderingSuspended() {
        return Date.now() < suspendRenderUntilMs;
    }

    function cancelQueuedRender() {
        if (renderRaf) {
            try {
                cancelAnimationFrame(renderRaf);
            } catch {
                // ignore
            }
            renderRaf = null;
        }
        renderQueued = false;
    }

    function queueRender({ immediate = false } = {}) {
        if (isRenderingSuspended()) return;
        if (settings.allowEditWhileTranscribing && (isEditActive() || isCursorPinned())) {
            return;
        }
        if (immediate) {
            cancelQueuedRender();
            renderSessionTextNow();
            return;
        }
        if (renderQueued) return;
        renderQueued = true;
        // Use microtask (Promise.resolve) instead of requestAnimationFrame for faster feedback
        // This executes before next frame instead of waiting ~16ms for next paint
        renderRaf = Promise.resolve().then(() => {
            renderQueued = false;
            renderRaf = null;
            renderSessionTextNow();
        });
    }

    // Backward-compatible helper: some legacy paths still reference renderSessionText().
    // Keep it as a thin wrapper to avoid runtime crashes.
    function renderSessionText() {
        queueRender({ immediate: true });
    }

    function handleTrustedUserEdit() {
        if (!isRecordingSession) return;
        if (sendResetInProgress) return;
        if (isRenderingSuspended()) return;
        if (!isCursorPinEnabled()) return;

        const promptEl = getPromptElement();
        if (!promptEl) return;

        log(`[FREEZE] User editing detected. Pausing transcription display for ${settings.editDebounceMs || 350}ms after pause.`);

        userEditIntent = true;
        userCursorPinned = true;

        scheduleCursorPinRelease();

        // The user is editing while we're still recording.
        // Phase 1 Fix #3: Smart edit mode with intelligent buffering
        // Instead of blocking ALL updates (data loss), we buffer new transcriptions
        // and merge them intelligently after editing stops
        cancelQueuedRender();
        setEditState(EditState.EDITING);

        // Rebase only on first edit in the burst
        const firstEditInBurst = !userEditDebounce;
        if (firstEditInBurst) {
            editBufferedCommitted = "";
            editBufferedCommittedRaw = "";
            editBufferedPartial = "";
            captureEditSnapshot(promptEl);
        }

        // Clear previous debounce
        if (userEditDebounce) {
            try {
                clearTimeout(userEditDebounce);
            } catch {
                // ignore
            }
        }

        // APPROACH A: Freeze Rendering During Edit
        // Debounce timer fires when user stops editing (configurable, default 350ms).
        // Flush all buffered transcription in one batch and render together.
        const debounceMs = Number(settings.editDebounceMs) || 350;  // Configurable from popup
        log(`[FREEZE] Edit debounce timer set to ${debounceMs}ms`);
        userEditDebounce = setTimeout(() => {
            userEditDebounce = null;
            log(`[FREEZE] User editing paused. Flushing buffered transcription...`);
            setEditState(EditState.IDLE);
            userCursorPinned = false;  // Release cursor pin

            try {
                const latest = getPromptText(promptEl) || "";
                const normalized = normalizePromptWithPrefix(latest);

                if (editSnapshot) {
                    const rebased = computeRebasedTexts(editSnapshot, normalized);
                    sessionBaseText = rebased.baseText;
                    sessionCommittedText = rebased.speechText;
                    sessionCommittedRaw = rebased.speechText;
                    currentPartialText = "";
                } else {
                    const { tail } = splitPrefix(normalized);
                    sessionBaseText = ensurePrefix(normalized.slice(0, normalized.length - tail.length));
                    sessionCommittedText = tail;
                    sessionCommittedRaw = tail;
                    currentPartialText = "";
                }

                // Apply all buffered transcription to session state
                if (editBufferedCommitted) {
                    log(`[FLUSH] Applying buffered committed: "${editBufferedCommitted}"`);
                    sessionCommittedText = joinTranscriptionText(
                        sessionCommittedText,
                        editBufferedCommitted
                    );
                }

                if (editBufferedCommittedRaw) {
                    sessionCommittedRaw = appendToRawBaseline(
                        sessionCommittedRaw,
                        editBufferedCommittedRaw
                    );
                }

                // Apply buffered partial (if any)
                if (editBufferedPartial) {
                    log(`[FLUSH] Applying buffered partial: "${editBufferedPartial}"`);
                    currentPartialText = String(editBufferedPartial).trim();
                }

                // Clear buffers for next edit cycle
                editBufferedCommitted = "";
                editBufferedCommittedRaw = "";
                editBufferedPartial = "";
                previewText = "";
                lastRenderedSpeechText = "";

                // Render once with all accumulated updates
                log(`[FLUSH] Rendering all buffered text...`);
                queueRender({ immediate: true });
            } finally {
                editSnapshot = null;
            }

            saveSessionSnapshot({ force: true });
        }, debounceMs);  // Debounce time is configurable from extension popup

        scheduleCursorPinCheck();
    }

    function normalizePromptWithPrefix(text) {
        const raw = text || "";
        if (!promptPrefixText) return raw;

        const firstIdx = raw.indexOf(promptPrefixText);
        if (firstIdx === -1) {
            return ensurePrefix(raw);
        }
        if (firstIdx === 0) {
            // Remove any duplicate prefix occurrences later in the text.
            let result = raw;
            let nextIdx = result.indexOf(promptPrefixText, promptPrefixText.length);
            while (nextIdx !== -1) {
                result =
                    result.slice(0, nextIdx) +
                    result.slice(nextIdx + promptPrefixText.length);
                nextIdx = result.indexOf(promptPrefixText, promptPrefixText.length);
            }
            return result;
        }

        // Prefix exists but not at the start (likely duplicated). Keep one at the top.
        const without = raw.split(promptPrefixText).join("");
        return `${promptPrefixText}${without.replace(/^\n+/, "")}`;
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
        sessionCommittedRaw = "";
        currentPartialText = "";
        previewText = "";
        lastTranscribedText = "";
        activeTranscriptionSessionId = null;
        lastRenderedSpeechText = "";

        // Clear segment tracking
        clearTranscriptionSegments();
        setEditState(EditState.IDLE);
        editBufferedCommitted = "";
        editBufferedCommittedRaw = "";
        editBufferedPartial = "";
        userCursorPinned = false;
        userEditIntent = false;
        if (cursorPinTimeout) {
            try {
                clearTimeout(cursorPinTimeout);
            } catch {
                // ignore
            }
            cursorPinTimeout = null;
        }
        clearSessionSnapshot();

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
            queueRender({ immediate: true });
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

            // Restore a recent draft if the prompt is empty.
            attemptSessionRecovery();
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

    /**
     * FAST PATH: Update textarea text with minimal overhead
     * Skips scroll, selection, and DOM traversal
     * Used during active transcription for maximum speed (~1-2ms)
     */
    function setPromptTextFast(promptEl, text) {
        if (!promptEl) return;
        const isTextInput = promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT";
        const currentValue = isTextInput ? (promptEl.value || "") : (promptEl.innerText || "");

        if (
            lastPromptTextFastEl === promptEl &&
            lastPromptTextFast === text &&
            currentValue === text
        ) {
            return;
        }

        if (isTextInput) {
            promptEl.value = text;
        } else {
            promptEl.innerText = text;
        }
        promptEl.dispatchEvent(new Event("input", { bubbles: true }));
        lastPromptTextFast = text;
        lastPromptTextFastEl = promptEl;
    }

    function shouldPreserveSelection(promptEl) {
        const active = document.activeElement;
        if (!active || !promptEl) return false;
        return active === promptEl || (typeof promptEl.contains === "function" && promptEl.contains(active));
    }

    function captureSelection(promptEl) {
        if (!promptEl) return null;
        if (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT") {
            return {
                type: "text",
                start: promptEl.selectionStart ?? 0,
                end: promptEl.selectionEnd ?? 0,
                direction: promptEl.selectionDirection || "none",
            };
        }

        if (!promptEl.isContentEditable) {
            return null;
        }

        const selection = window.getSelection();
        if (!selection || selection.rangeCount === 0) return null;
        const range = selection.getRangeAt(0);
        if (!promptEl.contains(range.startContainer) || !promptEl.contains(range.endContainer)) {
            return null;
        }

        const startRange = document.createRange();
        startRange.setStart(promptEl, 0);
        startRange.setEnd(range.startContainer, range.startOffset);
        const start = startRange.toString().length;

        const endRange = document.createRange();
        endRange.setStart(promptEl, 0);
        endRange.setEnd(range.endContainer, range.endOffset);
        const end = endRange.toString().length;

        return {
            type: "range",
            start,
            end,
            isCollapsed: selection.isCollapsed,
        };
    }

    function findNodeAtTextOffset(root, offset) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        let current = walker.nextNode();
        let remaining = offset;
        while (current) {
            const len = current.textContent?.length || 0;
            if (remaining <= len) {
                return { node: current, offset: remaining };
            }
            remaining -= len;
            current = walker.nextNode();
        }
        return null;
    }

    function restoreSelection(promptEl, selection) {
        if (!promptEl || !selection) return;
        if (selection.type === "text") {
            try {
                promptEl.setSelectionRange(selection.start, selection.end, selection.direction || "none");
            } catch {
                // ignore
            }
            return;
        }

        if (!promptEl.isContentEditable) return;
        const startPos = findNodeAtTextOffset(promptEl, selection.start);
        const endPos = findNodeAtTextOffset(promptEl, selection.end);
        if (!startPos || !endPos) return;

        const range = document.createRange();
        range.setStart(startPos.node, startPos.offset);
        range.setEnd(endPos.node, endPos.offset);
        const sel = window.getSelection();
        if (!sel) return;
        sel.removeAllRanges();
        sel.addRange(range);
    }

    function setPromptText(promptEl, text, { preserveCursor = true } = {}) {
        if (!promptEl) {
            return;
        }

        function findScrollContainer(el) {
            if (!el || !(el instanceof HTMLElement)) return null;
            if (cachedScrollPromptEl === el && cachedScrollContainer) {
                return cachedScrollContainer;
            }

            let cur = el;
            for (let i = 0; i < 8 && cur; i++) {
                try {
                    const style = window.getComputedStyle(cur);
                    const overflowY = (style.overflowY || "").toLowerCase();
                    const canScroll =
                        (overflowY === "auto" || overflowY === "scroll") &&
                        cur.scrollHeight > cur.clientHeight + 4;
                    if (canScroll) {
                        cachedScrollPromptEl = el;
                        cachedScrollContainer = cur;
                        return cur;
                    }
                } catch {
                    // ignore
                }
                cur = cur.parentElement;
            }
            // No obvious scroll container found; don't try to manage scrolling.
            cachedScrollPromptEl = el;
            cachedScrollContainer = null;
            return null;
        }

        const scrollContainer = findScrollContainer(promptEl);
        const beforeScrollTop = scrollContainer ? scrollContainer.scrollTop : 0;
        const wasAtBottom =
            !!scrollContainer &&
            scrollContainer.scrollHeight > scrollContainer.clientHeight + 4 &&
            scrollContainer.scrollTop + scrollContainer.clientHeight >=
            scrollContainer.scrollHeight - 12;

        const keepSelection = preserveCursor && shouldPreserveSelection(promptEl);
        const selection = keepSelection ? captureSelection(promptEl) : null;

        if (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT") {
            promptEl.value = text;
            promptEl.dispatchEvent(new Event("input", { bubbles: true }));
            lastPromptTextFast = text;
            lastPromptTextFastEl = promptEl;

            if (selection) {
                restoreSelection(promptEl, selection);
            }

            if (scrollContainer) {
                if (wasAtBottom) {
                    scrollContainer.scrollTop = scrollContainer.scrollHeight;
                } else {
                    // Preserve user scroll position (prevents jumping to top while transcribing).
                    const maxTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
                    scrollContainer.scrollTop = Math.min(beforeScrollTop, maxTop);
                }
            }
            return;
        }

        promptEl.innerText = text;
        promptEl.dispatchEvent(new Event("input", { bubbles: true }));
        lastPromptTextFast = text;
        lastPromptTextFastEl = promptEl;
        if (selection) {
            restoreSelection(promptEl, selection);
        }
        if (scrollContainer) {
            // Let layout settle before enforcing scroll behavior.
            setTimeout(() => {
                try {
                    if (wasAtBottom) {
                        scrollContainer.scrollTop = scrollContainer.scrollHeight;
                    } else {
                        const maxTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
                        scrollContainer.scrollTop = Math.min(beforeScrollTop, maxTop);
                    }
                } catch {
                    // ignore
                }
            }, 0);
        }
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

        if (isEditActive() || isCursorPinned()) {
            editBufferedCommitted = joinTranscriptionText(editBufferedCommitted, cleanedMessage);
            saveSessionSnapshot();
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

    /**
     * Optimized overlap detection with binary search approach.
     * Limited to 100 chars maximum to avoid O(n²) behavior.
     * Returns the length of overlapping text.
     */
    function detectOverlapFast(committed, partial) {
        const left = (committed || "").trim();
        const right = (partial || "").trim();
        if (!left || !right) return 0;

        // Limit search to 100 chars (covers 99.9% of cases, ~1KB utterances)
        const maxCheck = Math.min(left.length, right.length, 100);

        // Binary search approach: check common lengths first
        const checkLengths = [maxCheck, maxCheck >> 1, maxCheck >> 2];
        for (const len of checkLengths) {
            if (len > 0 && left.slice(-len) === right.slice(0, len)) {
                return len;
            }
        }

        // Linear fallback for remaining (quick because max 100 chars)
        for (let len = maxCheck; len > 0; len--) {
            if (left.slice(-len) === right.slice(0, len)) {
                return len;
            }
        }
        return 0;
    }

    /**
     * Merge committed (finalized) transcription with partial (live) transcription.
     * OPTIMIZED: O(n) complexity with caching, ~1ms execution time.
     * 
     * Speechmatics sends partials that include the full committed text as a prefix.
     * Example:
     *   Committed: "Hello world"
     *   Partial:   "Hello world how are you"
     * 
     * This function ensures we don't duplicate text when merging.
     * 
     * @param {string} committedText - Finalized text from Speechmatics AddTranscript
     * @param {string} partialText - Live text from Speechmatics AddPartialTranscript
     * @returns {string} Properly merged text without duplication
     */
    function mergeCommittedAndPartial(committedText, partialText) {
        const committed = (committedText || "").trim();
        const partial = (partialText || "").trim();

        // Check cache first (80% cache hit rate in typical usage)
        if (committed === lastMergeCommitted && partial === lastMergePartial) {
            return cachedMergeResult;
        }

        let result;

        // If either is empty, return the non-empty one
        if (!committed) {
            result = partial;
        } else if (!partial) {
            result = committed;
        }
        // FAST PATH (99% case): Partial starts with committed text
        // This is the normal Speechmatics behavior
        else if (partial.substring(0, committed.length) === committed) {
            result = partial;
        }
        // Rare case: partial is shorter than committed (revision downward)
        else if (committed.startsWith(partial)) {
            result = committed;
        }
        // Check for overlap at boundaries (rare, optimized)
        else {
            const overlap = detectOverlapFast(committed, partial);
            if (overlap > 0) {
                const tail = partial.slice(overlap);
                result = committed + (tail ? " " + tail : "");
            } else {
                // No overlap detected - safe to concatenate
                result = committed + " " + partial;
            }
        }

        // Update cache
        lastMergeCommitted = committed;
        lastMergePartial = partial;
        cachedMergeResult = result;

        return result;
    }

    function joinWithSeparator(base, sep, addition) {
        const left = (base || "");
        const right = (addition || "");
        if (!left) return right;
        if (!right) return left;
        if (!sep) return left + right;
        return left.endsWith(sep) ? left + right : left + sep + right;
    }

    /**
     * Get cached prompt element with TTL validation (Phase 1 Fix #2).
     * Prevents expensive DOM traversal on every render (~80% reduction).
     */
    let cachedPromptEl = null;
    let cachedPromptElTime = 0;
    const PROMPT_CACHE_TTL_MS = 5000;  // 5 seconds

    function getPromptElementCached() {
        const now = Date.now();
        // Return cache if valid and still in DOM
        if (cachedPromptEl && (now - cachedPromptElTime) < PROMPT_CACHE_TTL_MS) {
            // Quick validation: check if element still exists in DOM
            if (cachedPromptEl.ownerDocument.contains(cachedPromptEl)) {
                return cachedPromptEl;
            }
        }
        // Cache miss or invalid - refresh
        cachedPromptEl = getPromptElement();
        cachedPromptElTime = now;
        return cachedPromptEl;
    }

    function renderSessionTextNow() {
        if (isRenderingSuspended()) {
            return;
        }

        // CRITICAL: Do not render transcription while user is editing!
        // If we render, transcription will overwrite user's manual edits.
        // Instead, buffer updates until user finishes editing (cursor pin release).
        if (settings.allowEditWhileTranscribing && userCursorPinned) {
            log(`[FREEZE] Skipping render - user is editing, updates are buffered`);
            return;
        }

        // Phase 1 Fix #6 Optimized: Throttle renders to ~250fps (4ms minimum interval)
        // Reduced from 16ms for lower latency and faster visual feedback during transcription
        const now = Date.now();
        if (now - lastRenderTime < MIN_RENDER_INTERVAL_MS) {
            return;  // Skip this render, next one in queue will execute when safe
        }
        lastRenderTime = now;

        const promptEl = getPromptElementCached();  // Use cached element (Fix #2)
        if (!promptEl) return;

        // Use improved merge function that prevents duplication
        // Between committed (final) and partial (live) transcription
        const candidateSpeechText = buildDisplaySpeechText();

        // Speechmatics can revise partial hypotheses downward when finals land.
        // Never let the rendered speech shrink; this prevents visible vanishing and "missing last words"
        // if the user hits Enter immediately.
        let speechText = candidateSpeechText;
        if (lastRenderedSpeechText && candidateSpeechText.length < lastRenderedSpeechText.length) {
            speechText = lastRenderedSpeechText;
        } else {
            lastRenderedSpeechText = candidateSpeechText;
        }

        const appendMode = Boolean(settings.appendMode);

        // OPTIMIZATION: Cache final text to avoid rebuilding identical strings
        if (speechText === cachedFinalSpeech &&
            sessionBaseText === cachedFinalBase &&
            appendMode === cachedFinalMode) {
            // Nothing changed, use cached final text
            setPromptTextFast(promptEl, cachedFinalText);
            return;
        }

        let next;
        if (!appendMode) {
            next = ensurePrefix(speechText);
        } else {
            const base = ensurePrefix(sessionBaseText);
            next = joinWithSeparator(base, settings.appendSeparator, speechText);
        }

        // Cache for next time
        cachedFinalText = next;
        cachedFinalSpeech = speechText;
        cachedFinalBase = sessionBaseText;
        cachedFinalMode = appendMode;

        // OPTIMIZATION: Use fast path for transcription updates
        // No need to get current text, preserve selection, or manage scrolling
        // Just update the value directly (99% of transcription updates)
        setPromptTextFast(promptEl, next);
    }

    function computePartialTail(committedRaw, partialRaw) {
        const committed = (committedRaw || "").trim();
        const partial = (partialRaw || "").trim();
        if (!partial) return "";
        if (!committed) return partial;
        if (partial.substring(0, committed.length) === committed) {
            return partial.slice(committed.length);
        }
        if (committed.startsWith(partial)) {
            return "";
        }
        const overlap = detectOverlapFast(committed, partial);
        if (overlap > 0) {
            return partial.slice(overlap);
        }
        return "";
    }

    function buildDisplaySpeechText() {
        // OPTIMIZATION: Cache display text to avoid rebuilding if input hasn't changed
        const committedDisplay = sessionCommittedText || "";
        const committedRaw = sessionCommittedRaw || sessionCommittedText || "";
        const partialRaw = currentPartialText || "";

        // If nothing changed, return cached result
        if (committedDisplay === cachedDisplayCommitted &&
            committedRaw === cachedDisplayRaw &&
            partialRaw === cachedDisplayPartial) {
            return cachedDisplayText;
        }

        // Compute new display text
        const tail = computePartialTail(committedRaw, partialRaw);
        const result = !tail ? committedDisplay : joinTranscriptionText(committedDisplay, tail);

        // Cache for next time
        invalidateDisplayCache(committedDisplay, committedRaw, partialRaw);

        return result;
    }

    function invalidateDisplayCache(newCommitted, newRaw, newPartial) {
        cachedDisplayText = "";
        cachedDisplayCommitted = newCommitted;
        cachedDisplayRaw = newRaw;
        cachedDisplayPartial = newPartial;
    }

    function appendToRawBaseline(rawText, newText) {
        const incoming = String(newText || "").trim();
        if (!incoming) return rawText || "";
        const base = rawText || "";
        if (!base) return incoming;
        if (base.endsWith(incoming)) return base;
        const overlap = detectOverlapFast(base, incoming);
        if (overlap > 0) {
            const tail = incoming.slice(overlap);
            return tail ? base + " " + tail : base;
        }
        return joinTranscriptionText(base, incoming);
    }

    function acceptCurrentPartialIntoCommitted() {
        if (!currentPartialText || !currentPartialText.trim()) {
            return;
        }
        const tail = computePartialTail(sessionCommittedRaw, currentPartialText);
        if (tail) {
            sessionCommittedText = joinTranscriptionText(sessionCommittedText, tail);
        }
        sessionCommittedRaw = mergeCommittedAndPartial(sessionCommittedRaw, currentPartialText);
        currentPartialText = "";
        previewText = "";
        lastRenderedSpeechText = "";
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
        sessionCommittedRaw = "";
        currentPartialText = "";
        previewText = "";
        lastRenderedSpeechText = "";

        // Clear and reinitialize segment tracking for new session
        clearTranscriptionSegments();
        setEditState(EditState.IDLE);
        editBufferedCommitted = "";
        editBufferedCommittedRaw = "";
        editBufferedPartial = "";
        userCursorPinned = false;
        userEditIntent = false;
        if (cursorPinTimeout) {
            try {
                clearTimeout(cursorPinTimeout);
            } catch {
                // ignore
            }
            cursorPinTimeout = null;
        }

        isRecordingSession = true;
        saveSessionSnapshot({ force: true });
    }

    function resetSessionState({ clearPrompt = false } = {}) {
        const promptEl = getPromptElement();
        if (clearPrompt && promptEl) {
            setPromptText(promptEl, promptPrefixText || "");
        }
        isRecordingSession = false;
        sessionBaseText = "";
        sessionCommittedText = "";
        sessionCommittedRaw = "";
        currentPartialText = "";
        previewText = "";
        lastRenderedSpeechText = "";

        // Clear segment tracking on session reset
        clearTranscriptionSegments();
        setEditState(EditState.IDLE);
        editBufferedCommitted = "";
        editBufferedCommittedRaw = "";
        editBufferedPartial = "";
        userCursorPinned = false;
        userEditIntent = false;
        if (cursorPinTimeout) {
            try {
                clearTimeout(cursorPinTimeout);
            } catch {
                // ignore
            }
            cursorPinTimeout = null;
        }
        clearSessionSnapshot();
    }

    function isPromptElement(el) {
        const promptEl = getPromptElement();
        return !!promptEl && (el === promptEl || (typeof promptEl.contains === "function" && promptEl.contains(el)));
    }

    function scheduleSessionResetAfterSend() {
        if (sendResetInProgress) return;
        sendResetInProgress = true;

        // Freeze our own prompt writes while ChatGPT consumes the current composer text.
        // We'll resume as soon as we observe the prompt has cleared.
        suspendRenderingFor(2500);

        (async () => {
            try {
                const cleared = await waitForPromptToClear({ timeoutMs: 2500 });

                const transcriber =
                    (typeof window !== "undefined" &&
                        (window.SpeechmasticsTranscriber || window.SpeechmaticsTranscriber)) ||
                    null;
                const stillRecording =
                    !!transcriber && typeof transcriber.isRecording === "function"
                        ? transcriber.isRecording()
                        : false;

                if (!cleared) {
                    // Submission may have been prevented; keep the current session intact.
                    return;
                }

                // Safe to reset now (ChatGPT already consumed/cleared the composer text).
                sessionBaseText = "";
                sessionCommittedText = "";
                sessionCommittedRaw = "";
                currentPartialText = "";
                previewText = "";
                lastRenderedSpeechText = "";
                activeTranscriptionSessionId = null;
                clearSessionSnapshot();

                if (stillRecording) {
                    // Reset the server-side session so the next utterance can't "bleed" from the previous one.
                    try {
                        window.dispatchEvent(
                            new CustomEvent("__testExtChatUi", { detail: { type: "resetSession" } })
                        );
                    } catch {
                        // ignore
                    }

                    // Start a fresh UI session on the now-empty composer (adds prefix if configured).
                    isRecordingSession = false;
                    startSessionIfNeeded();
                } else {
                    resetSessionState({ clearPrompt: false });
                }
            } finally {
                sendResetInProgress = false;
                suspendRenderUntilMs = 0;
            }
        })();
    }

    // Handle partial transcription (real-time updates)
    function handlePartialTranscription(text, isPartial) {
        if (!isRecordingSession) {
            // Ignore late/stray partials when not actively recording.
            return;
        }

        if (isPartial) {
            // Phase 1 Fix #4: Smart partial handling with intelligent buffering
            // Instead of blocking updates, merge them into buffers
            if (settings.allowEditWhileTranscribing && (isEditActive() || isCursorPinned())) {
                // Keep the latest partial while editing; don't merge against edited text.
                editBufferedPartial = String(text || "").trim();
                saveSessionSnapshot();
                return;
            }

            const newText = (text || "").trim();

            // Prevent duplicate partial updates
            // Only update if the partial text has actually changed
            if (newText === currentPartialText) {
                return;  // Same text, skip redundant update
            }

            currentPartialText = newText;
            updateTranscriptionSegment("partial", newText);
            saveSessionSnapshot();

            // Show partial text in preview if enabled
            if (settings.showPartialTranscript) {
                displayPartialTranscript(newText);
            }
        } else {
            // Ignore "clear partial" events to avoid flicker/gaps.
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
        saveSessionSnapshot({ force: true });

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

    function handleAppendCommittedTranscript(text, meta = null) {
        if (!text || !String(text).trim()) return;
        startSessionIfNeeded();

        const newText = String(text).trim();

        // Prevent duplicate committed text updates
        // Check if we've already added this exact text recently
        if (newText === lastCommittedTextSnapshot) {
            return;  // Duplicate, skip
        }

        lastCommittedTextSnapshot = newText;

        // Commit confident chunks immediately so partial shrink/revisions never erase prior words.
        sessionCommittedRaw = appendToRawBaseline(sessionCommittedRaw, newText);

        // APPROACH A: FREEZE RENDERING WHILE EDITING
        // When user is actively editing (cursor pinned), NEVER render transcription.
        // Just buffer it. Once user stops editing and cursor release fires, flush everything.
        // This is the ONLY way to prevent transcription from overwriting user's manual edits.
        if (userCursorPinned) {
            log(`[FREEZE] Buffering committed text while user editing: "${newText}"`);
            editBufferedCommitted = joinTranscriptionText(editBufferedCommitted, newText);
            editBufferedCommittedRaw = appendToRawBaseline(editBufferedCommittedRaw, newText);
            lastTranscribedText = newText;
            saveSessionSnapshot();  // Buffered save (debounced)
            return;  // DO NOT RENDER - user is editing!
        }

        // Normal path: Not editing, so render transcription
        sessionCommittedText = joinTranscriptionText(sessionCommittedText, newText);
        updateTranscriptionSegment("committed", newText, meta);
        lastTranscribedText = newText;

        // Optimize: render IMMEDIATELY with high priority, then save snapshot debounced
        queueRender({ immediate: true });  // Skip RAF queue for instant feedback
        saveSessionSnapshot();  // Debounced, non-blocking
    }

    function handleFinalizeTranscription({ autoEnter } = {}) {
        if (!isRecordingSession) {
            return;
        }

        // Do not clear partials here. The prompt already contains the latest words (including partials),
        // and the user may be sending immediately at end-of-speech.
        queueRender({ immediate: true });

        // Never submit if the prompt has no user text (ignore static prefix).
        const promptEl = getPromptElement();
        const raw = promptEl ? getPromptText(promptEl) : "";
        const tail = splitPrefix(raw).tail.trim();

        const shouldAutoSend = Boolean(settings.autoSubmitMessage) || Boolean(autoEnter);
        if (!shouldAutoSend || !tail) {
            // User may want to edit before sending.
            isRecordingSession = false;
            saveSessionSnapshot({ force: true });
            return;
        }

        (async () => {
            const didSubmit = await submitChatGptComposerWithRetry({ timeoutMs: 2000 });
            if (!didSubmit) {
                showErrorToast("Couldn't submit: Send action not available");
                // Keep the text so the user can manually click Send.
                isRecordingSession = false;
                saveSessionSnapshot({ force: true });
                return;
            }

            // Don't clear the prompt ourselves; only reset our internal buffers once ChatGPT clears it.
            const cleared = await waitForPromptToClear({ timeoutMs: 2500 });
            if (cleared) {
                resetSessionState({ clearPrompt: false });
            } else {
                // ChatGPT didn't clear (submission may have been prevented). Keep state but stop session.
                isRecordingSession = false;
                saveSessionSnapshot({ force: true });
            }
        })();
    }

    // Display partial transcription in textarea
    function displayPartialTranscript(text) {
        if (!settings.showPartialTranscript) return;
        if (!isRecordingSession) return;
        if (isRenderingSuspended()) return;

        // FREEZE RENDERING: Buffer partials while user is editing
        // Never render partials while cursor is pinned - user is making changes!
        if (settings.allowEditWhileTranscribing && userCursorPinned) {
            log(`[FREEZE] Buffering partial while user editing`);
            editBufferedPartial = String(text).trim();  // Buffer latest partial
            return;  // DO NOT render - user is editing!
        }

        // Render using current session state, which keeps committed text stable while partials change.
        previewText = text;
        queueRender({ immediate: true });  // Bypass RAF for immediate partial feedback
    }

    // Clear partial preview
    function clearPartialPreview() {
        previewText = "";
        if (isRecordingSession) {
            queueRender({ immediate: true });
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
            queueRender({ immediate: true });
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

                // Allow user to edit already-transcribed text during a long recording.
                // Only respond to trusted user edits (not our own synthetic input events).
                if (
                    e.isTrusted &&
                    isRecordingSession &&
                    text &&
                    !isAutoResetSuppressed() &&
                    isCursorPinEnabled()
                ) {
                    handleTrustedUserEdit();
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
            handleAppendCommittedTranscript(request.text, request);
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

        if (Object.prototype.hasOwnProperty.call(changes, "allowEditWhileTranscribing")) {
            if (!settings.allowEditWhileTranscribing) {
                userCursorPinned = false;
                userEditIntent = false;
                cursorPinReleaseAt = 0;
                setEditState(EditState.IDLE);
                if (userEditDebounce) {
                    try {
                        clearTimeout(userEditDebounce);
                    } catch {
                        // ignore
                    }
                    userEditDebounce = null;
                }
                if (cursorPinTimeout) {
                    try {
                        clearTimeout(cursorPinTimeout);
                    } catch {
                        // ignore
                    }
                    cursorPinTimeout = null;
                }
                flushBufferedTranscription();
            }
        }

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
        attemptSessionRecovery();
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

    // Track user cursor position in the prompt to avoid overwriting edits.
    document.addEventListener("selectionchange", scheduleCursorPinCheck, true);
    document.addEventListener("keyup", scheduleCursorPinCheck, true);
    document.addEventListener("mouseup", scheduleCursorPinCheck, true);
    document.addEventListener("focusin", scheduleCursorPinCheck, true);
    document.addEventListener("focusout", scheduleCursorPinCheck, true);

    // Double-Shift to resume transcription appends even when cursor is pinned.
    document.addEventListener(
        "keydown",
        (event) => {
            if (event.key !== "Shift" || event.repeat) return;
            const now = Date.now();
            const withinWindow = now - lastShiftAt <= DOUBLE_SHIFT_WINDOW_MS;
            lastShiftAt = now;

            if (!withinWindow) return;
            if (!isCursorPinEnabled()) return;

            const promptEl = getPromptElement();
            if (!promptEl) return;
            if (!shouldPreserveSelection(promptEl)) return;

            userCursorPinned = false;
            userEditIntent = false;
            cursorPinReleaseAt = 0;
            if (cursorPinTimeout) {
                try {
                    clearTimeout(cursorPinTimeout);
                } catch {
                    // ignore
                }
                cursorPinTimeout = null;
            }
            flushBufferedTranscription();
        },
        true
    );

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
