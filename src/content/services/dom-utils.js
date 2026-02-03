/**
 * DOM Utilities Module
 * Handles all DOM operations for the ChatGPT extension
 * 
 * @module DOMUtils
 * @description Provides clean abstractions for DOM manipulation,
 *              element queries, text management, and event handling
 * 
 * Usage:
 * const promptEl = DOMUtils.getPromptElement();
 * const text = DOMUtils.getPromptText(promptEl);
 * DOMUtils.setPromptText(promptEl, "new text");
 */

const DOMUtils = (() => {
    /**
     * CSS selectors for common elements
     * @constant {Object} SELECTORS
     */
    const SELECTORS = {
        PROMPT_CONTAINER: "#prompt-textarea",
        TEXTAREA_INPUT: "textarea",
        CONTENTEDITABLE_INPUT: "div[contenteditable='true']",
        SEND_BUTTON: "button[data-testid='send-button']",
        MIC_TOGGLE: "#speechmatics-mic-toggle",
        MIC_STATUS: "#speechmatics-mic-status",
    };

    /**
     * Get the ChatGPT prompt input element
     * Tries multiple selectors to handle different ChatGPT versions
     * 
     * @returns {HTMLElement|null} The prompt element or null if not found
     * 
     * @example
     * const promptEl = DOMUtils.getPromptElement();
     * if (promptEl) {
     *   const text = DOMUtils.getPromptText(promptEl);
     *   console.log("Current text:", text);
     * }
     */
    function getPromptElement() {
        const container = document.querySelector(SELECTORS.PROMPT_CONTAINER);
        if (!container) {
            console.warn("[DOMUtils] Prompt container not found");
            return null;
        }

        // Try multiple selectors for different ChatGPT versions
        return (
            container.querySelector(SELECTORS.TEXTAREA_INPUT) ||
            container.querySelector(SELECTORS.CONTENTEDITABLE_INPUT) ||
            container
        );
    }

    /**
     * Get text content from a prompt element
     * Handles both textarea/input and contenteditable elements
     * 
     * @param {HTMLElement} promptEl - The prompt element
     * @returns {string} The text content (empty string if element is null/invalid)
     * 
     * @example
     * const text = DOMUtils.getPromptText(promptEl);
     */
    function getPromptText(promptEl) {
        if (!promptEl) {
            return "";
        }

        // For input elements (textarea, input)
        if (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT") {
            return promptEl.value || "";
        }

        // For contenteditable elements
        return promptEl.innerText || "";
    }

    /**
     * Set text content in a prompt element
     * Handles both textarea/input and contenteditable elements
     * Dispatches input event to notify listeners
     * 
     * @param {HTMLElement} promptEl - The prompt element
     * @param {string} text - The text to set
     * @returns {boolean} True if successful, false otherwise
     * 
     * @example
     * if (DOMUtils.setPromptText(promptEl, "Hello world")) {
     *   console.log("Text set successfully");
     * }
     */
    function setPromptText(promptEl, text) {
        if (!promptEl) {
            console.warn("[DOMUtils] Invalid prompt element");
            return false;
        }

        try {
            // For input elements
            if (promptEl.tagName === "TEXTAREA" || promptEl.tagName === "INPUT") {
                promptEl.value = text;
            } else {
                // For contenteditable elements
                promptEl.innerText = text;
            }

            // Dispatch input event to notify listeners
            promptEl.dispatchEvent(new Event("input", { bubbles: true }));
            return true;
        } catch (error) {
            console.error("[DOMUtils] Failed to set prompt text:", error);
            return false;
        }
    }

    /**
     * Get or create an element by selector
     * Creates element if it doesn't exist
     * 
     * @param {string} selector - CSS selector
     * @param {string} [tagName='div'] - Tag name if creating new element
     * @returns {HTMLElement} The existing or newly created element
     * 
     * @example
     * const container = DOMUtils.getOrCreateElement("#my-container", "div");
     */
    function getOrCreateElement(selector, tagName = "div") {
        let element = document.querySelector(selector);

        if (!element) {
            element = document.createElement(tagName);
            if (selector.startsWith("#")) {
                element.id = selector.substring(1);
            } else if (selector.startsWith(".")) {
                element.className = selector.substring(1);
            }
        }

        return element;
    }

    /**
     * Query for an element
     * 
     * @param {string} selector - CSS selector
     * @returns {HTMLElement|null} The element or null
     */
    function querySelector(selector) {
        return document.querySelector(selector);
    }

    /**
     * Query for multiple elements
     * 
     * @param {string} selector - CSS selector
     * @returns {NodeList} Collection of elements
     */
    function querySelectorAll(selector) {
        return document.querySelectorAll(selector);
    }

    /**
     * Check if an element exists in the DOM
     * 
     * @param {HTMLElement} element - The element to check
     * @returns {boolean} True if element exists in DOM
     */
    function elementExists(element) {
        return element && document.body.contains(element);
    }

    /**
     * Find the Send button in ChatGPT
     * 
     * @returns {HTMLElement|null} The Send button or null
     * 
     * @example
     * const sendBtn = DOMUtils.getSendButton();
     * if (sendBtn) sendBtn.click();
     */
    function getSendButton() {
        return querySelector(SELECTORS.SEND_BUTTON);
    }

    /**
     * Get the mic toggle button
     * 
     * @returns {HTMLElement|null} The mic button or null
     */
    function getMicToggleButton() {
        return querySelector(SELECTORS.MIC_TOGGLE);
    }

    /**
     * Get the mic status indicator
     * 
     * @returns {HTMLElement|null} The status indicator or null
     */
    function getMicStatusIndicator() {
        return querySelector(SELECTORS.MIC_STATUS);
    }

    /**
     * Add a CSS class to an element (safe)
     * 
     * @param {HTMLElement} element - The element
     * @param {string} className - The class name to add
     * @returns {boolean} True if successful
     */
    function addClass(element, className) {
        try {
            element?.classList?.add(className);
            return true;
        } catch (error) {
            console.error("[DOMUtils] Failed to add class:", error);
            return false;
        }
    }

    /**
     * Remove a CSS class from an element (safe)
     * 
     * @param {HTMLElement} element - The element
     * @param {string} className - The class name to remove
     * @returns {boolean} True if successful
     */
    function removeClass(element, className) {
        try {
            element?.classList?.remove(className);
            return true;
        } catch (error) {
            console.error("[DOMUtils] Failed to remove class:", error);
            return false;
        }
    }

    /**
     * Toggle a CSS class on an element (safe)
     * 
     * @param {HTMLElement} element - The element
     * @param {string} className - The class name to toggle
     * @returns {boolean} The current state (true if class is present)
     */
    function toggleClass(element, className) {
        try {
            return element?.classList?.toggle(className) ?? false;
        } catch (error) {
            console.error("[DOMUtils] Failed to toggle class:", error);
            return false;
        }
    }

    /**
     * Set inline styles on an element
     * 
     * @param {HTMLElement} element - The element
     * @param {string} cssText - The CSS text to apply
     * @returns {boolean} True if successful
     * 
     * @example
     * DOMUtils.setInlineStyles(element, 
     *   "color: red; font-size: 16px;");
     */
    function setInlineStyles(element, cssText) {
        if (!element) return false;
        try {
            element.style.cssText = cssText;
            return true;
        } catch (error) {
            console.error("[DOMUtils] Failed to set styles:", error);
            return false;
        }
    }

    /**
     * Set multiple inline styles via object
     * 
     * @param {HTMLElement} element - The element
     * @param {Object} styles - Object with style properties
     * @returns {boolean} True if successful
     * 
     * @example
     * DOMUtils.setStyles(element, {
     *   backgroundColor: "red",
     *   padding: "10px"
     * });
     */
    function setStyles(element, styles) {
        if (!element) return false;
        try {
            Object.assign(element.style, styles);
            return true;
        } catch (error) {
            console.error("[DOMUtils] Failed to set styles:", error);
            return false;
        }
    }

    /**
     * Add an event listener (with automatic cleanup tracking)
     * 
     * @param {HTMLElement} element - The element
     * @param {string} eventType - The event type
     * @param {Function} handler - The handler function
     * @param {Object} [options] - Event listener options
     * @returns {boolean} True if successful
     * 
     * @example
     * DOMUtils.addEventListener(button, "click", () => {
     *   console.log("Clicked!");
     * });
     */
    function addEventListener(element, eventType, handler, options) {
        if (!element) return false;
        try {
            element.addEventListener(eventType, handler, options);
            return true;
        } catch (error) {
            console.error("[DOMUtils] Failed to add event listener:", error);
            return false;
        }
    }

    /**
     * Remove an event listener
     * 
     * @param {HTMLElement} element - The element
     * @param {string} eventType - The event type
     * @param {Function} handler - The handler function
     * @returns {boolean} True if successful
     */
    function removeEventListener(element, eventType, handler) {
        if (!element) return false;
        try {
            element.removeEventListener(eventType, handler);
            return true;
        } catch (error) {
            console.error("[DOMUtils] Failed to remove event listener:", error);
            return false;
        }
    }

    /**
     * Wait for an element to appear in the DOM
     * Useful for waiting for dynamic content to load
     * 
     * @param {string} selector - CSS selector
     * @param {number} [timeout=5000] - Max wait time in milliseconds
     * @returns {Promise<HTMLElement>} Resolves with the element
     * 
     * @example
     * try {
     *   const element = await DOMUtils.waitForElement("#my-element");
     *   console.log("Element found:", element);
     * } catch (error) {
     *   console.error("Element not found within timeout");
     * }
     */
    function waitForElement(selector, timeout = 5000) {
        return new Promise((resolve, reject) => {
            const element = document.querySelector(selector);
            if (element) {
                resolve(element);
                return;
            }

            const observer = new MutationObserver(() => {
                const element = document.querySelector(selector);
                if (element) {
                    observer.disconnect();
                    resolve(element);
                }
            });

            observer.observe(document.body, {
                childList: true,
                subtree: true
            });

            setTimeout(() => {
                observer.disconnect();
                reject(new Error(`Element not found: ${selector}`));
            }, timeout);
        });
    }

    // Public API
    return {
        // Constants
        SELECTORS,

        // Query methods
        getPromptElement,
        querySelector,
        querySelectorAll,
        getOrCreateElement,
        elementExists,
        getSendButton,
        getMicToggleButton,
        getMicStatusIndicator,

        // Text methods
        getPromptText,
        setPromptText,

        // Class methods
        addClass,
        removeClass,
        toggleClass,

        // Style methods
        setInlineStyles,
        setStyles,

        // Event methods
        addEventListener,
        removeEventListener,

        // Async methods
        waitForElement
    };
})();

// Make available to other scripts
if (typeof window !== 'undefined') {
    window.DOMUtils = DOMUtils;
}
