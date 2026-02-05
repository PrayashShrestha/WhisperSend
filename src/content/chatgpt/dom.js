(() => {
    const namespace = window.__WisperSendChat || (window.__WisperSendChat = {});
    if (namespace.dom) {
        return;
    }

    let cachedScrollPromptEl = null;
    let cachedScrollContainer = null;
    let lastPromptTextFast = "";
    let lastPromptTextFastEl = null;

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
     * 
     * @param {HTMLElement} promptEl - The prompt element to update
     * @param {string} text - The text to set
     * @param {Object} options - Options for the update
     * @param {boolean} options.skipEvents - Skip event dispatch for ultra-low latency (default: false)
     */
    function setPromptTextFast(promptEl, text, { skipEvents = false } = {}) {
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

        // ULTRA-LOW LATENCY: Skip event dispatch during active transcription
        // Saves 2-5ms per update by avoiding unnecessary handler execution
        if (!skipEvents) {
            promptEl.dispatchEvent(new Event("input", { bubbles: true }));
        }

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
        let currentOffset = 0;

        while (current) {
            const text = current.nodeValue || "";
            const nextOffset = currentOffset + text.length;
            if (offset <= nextOffset) {
                return { node: current, offset: offset - currentOffset };
            }
            currentOffset = nextOffset;
            current = walker.nextNode();
        }

        return { node: root, offset: root.childNodes.length };
    }

    function restoreSelection(promptEl, selection) {
        if (!promptEl || !selection) return;
        if (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT") {
            try {
                promptEl.selectionStart = selection.start ?? 0;
                promptEl.selectionEnd = selection.end ?? selection.start ?? 0;
                if (selection.direction) {
                    promptEl.selectionDirection = selection.direction;
                }
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

    namespace.dom = {
        getDomHost,
        safeAppendToHost,
        getPromptElement,
        getPromptContainerElement,
        getComposerSurfaceElement,
        getMicAnchorElement,
        safeAppendToAnchor,
        getPromptText,
        setPromptTextFast,
        shouldPreserveSelection,
        captureSelection,
        findNodeAtTextOffset,
        restoreSelection,
        setPromptText,
    };
})();
