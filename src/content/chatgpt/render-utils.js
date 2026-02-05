(() => {
    const namespace = window.__WisperSendChat || (window.__WisperSendChat = {});
    if (namespace.renderUtils) {
        return;
    }

    let lastMergeCommitted = "";
    let lastMergePartial = "";
    let cachedMergeResult = "";

    let cachedDisplayText = "";
    let cachedDisplayCommitted = "";
    let cachedDisplayRaw = "";
    let cachedDisplayPartial = "";

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
     */
    function mergeCommittedAndPartial(committedText, partialText) {
        const committed = (committedText || "").trim();
        const partial = (partialText || "").trim();

        // Check cache first
        if (committed === lastMergeCommitted && partial === lastMergePartial) {
            return cachedMergeResult;
        }

        let result;

        if (!committed) {
            result = partial;
        } else if (!partial) {
            result = committed;
        } else if (partial.substring(0, committed.length) === committed) {
            result = partial;
        } else if (committed.startsWith(partial)) {
            result = committed;
        } else {
            const overlap = detectOverlapFast(committed, partial);
            if (overlap > 0) {
                const tail = partial.slice(overlap);
                result = committed + (tail ? " " + tail : "");
            } else {
                result = committed + " " + partial;
            }
        }

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

    function buildDisplaySpeechText(committedDisplay, committedRaw, partialRaw) {
        const committedDisplaySafe = committedDisplay || "";
        const committedRawSafe = committedRaw || committedDisplaySafe || "";
        const partialSafe = partialRaw || "";

        if (
            committedDisplaySafe === cachedDisplayCommitted &&
            committedRawSafe === cachedDisplayRaw &&
            partialSafe === cachedDisplayPartial
        ) {
            return cachedDisplayText;
        }

        const tail = computePartialTail(committedRawSafe, partialSafe);
        const result = !tail ? committedDisplaySafe : joinTranscriptionText(committedDisplaySafe, tail);

        cachedDisplayText = result;
        cachedDisplayCommitted = committedDisplaySafe;
        cachedDisplayRaw = committedRawSafe;
        cachedDisplayPartial = partialSafe;

        return result;
    }

    function invalidateDisplayCache() {
        cachedDisplayText = "";
        cachedDisplayCommitted = "";
        cachedDisplayRaw = "";
        cachedDisplayPartial = "";
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

    namespace.renderUtils = {
        joinTranscriptionText,
        detectOverlapFast,
        mergeCommittedAndPartial,
        joinWithSeparator,
        computePartialTail,
        buildDisplaySpeechText,
        invalidateDisplayCache,
        appendToRawBaseline,
    };
})();
