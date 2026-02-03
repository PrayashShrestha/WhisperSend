// API Key Elements
const apiKeyInput = document.querySelector("#api-key");
const toggleApiKeyBtn = document.querySelector("#toggle-api-key");
const saveApiKeyBtn = document.querySelector("#save-api-key");
const deleteApiKeyBtn = document.querySelector("#delete-api-key");
const apiStatusDiv = document.querySelector("#api-status");

// Settings Elements
const appendToggle = document.querySelector("#append-mode");
const autoEnterToggle = document.querySelector("#auto-enter");
const autoSubmitMessageToggle = document.querySelector("#auto-submit-message");
const showPartialTranscriptToggle = document.querySelector("#show-partial-transcript");
const debugToggle = document.querySelector("#debug-mode");

// Mode Elements
const modeTimerRadio = document.querySelector("#mode-timer");
const modeManualRadio = document.querySelector("#mode-manual");
const timerSettingsDiv = document.querySelector("#timer-settings");
const autoSubmitDelayInput = document.querySelector("#auto-submit-delay");

// Note: We store the API key in BOTH:
// - chrome.storage.sync.speechmaticsApiKey (persists across incognito/split modes and reloads)
// - chrome.storage.local.apiKey (fast local cache)
//
// In early iterations we tried to keep the key only in `local`, but some users
// reported it "disappearing" when using incognito/split extension contexts.
const SETTINGS_DEFAULTS = {
    transcriptionMode: "timer",
    autoSubmitDelayMs: 500,
    appendMode: true,
    autoEnterAfterSubmit: true,
    autoSubmitMessage: false,
    showPartialTranscript: true,
    debug: false,
};

// Keep a shadow copy in sync as a fallback (some users run ChatGPT in incognito /
// split profiles where local storage can behave unexpectedly).
const SYNC_KEYS = { ...SETTINGS_DEFAULTS, apiKey: null, speechmaticsApiKey: null };

function getApiKeyFromLocal() {
    return new Promise((resolve) => {
        chrome.storage.local.get({ apiKey: null }, (items) => {
            if (chrome.runtime.lastError) {
                resolve(null);
                return;
            }
            resolve(items.apiKey || null);
        });
    });
}

function setApiKeyInLocal(apiKeyOrNull) {
    return new Promise((resolve, reject) => {
        chrome.storage.local.set({ apiKey: apiKeyOrNull }, () => {
            if (chrome.runtime.lastError) {
                reject(chrome.runtime.lastError);
                return;
            }
            resolve();
        });
    });
}

function getApiKeyFromSync() {
    return new Promise((resolve) => {
        chrome.storage.sync.get({ speechmaticsApiKey: null, apiKey: null }, (items) => {
            if (chrome.runtime.lastError) {
                resolve(null);
                return;
            }
            resolve(items?.speechmaticsApiKey || items?.apiKey || null);
        });
    });
}

function setApiKeyInSync(apiKeyOrNull) {
    return new Promise((resolve, reject) => {
        chrome.storage.sync.set(
            {
                // Keep both for backwards compatibility.
                speechmaticsApiKey: apiKeyOrNull,
                apiKey: apiKeyOrNull,
            },
            () => {
                if (chrome.runtime.lastError) {
                    reject(chrome.runtime.lastError);
                    return;
                }
                resolve();
            }
        );
    });
}

// Load all settings
function loadSettings() {
    chrome.storage.sync.get(SYNC_KEYS, async (items) => {
        // API Key status
        // Prefer sync as the canonical store, then fall back to local cache.
        let apiKey = (await getApiKeyFromSync()) || (await getApiKeyFromLocal());
        // Best-effort hydrate local cache for faster reads elsewhere.
        if (apiKey) {
            try {
                await setApiKeyInLocal(apiKey);
            } catch {
                // ignore
            }
        }
        if (apiKey) {
            apiKeyInput.value = apiKey;
            showApiStatus("API key configured ✓", "success");
        } else {
            apiKeyInput.value = "";
            apiStatusDiv.innerHTML = "";
            showApiStatus("No API key configured", "error");
        }

        // Mode
        const mode = items.transcriptionMode || "timer";
        if (mode === "timer") {
            modeTimerRadio.checked = true;
            timerSettingsDiv.style.display = "block";
        } else {
            modeManualRadio.checked = true;
            timerSettingsDiv.style.display = "none";
        }

        // Timer delay
        const delayMs = items.autoSubmitDelayMs || 2000;
        autoSubmitDelayInput.value = (delayMs / 1000).toFixed(1);

        // Other settings
        appendToggle.checked = Boolean(items.appendMode);
        autoEnterToggle.checked = Boolean(items.autoEnterAfterSubmit);
        autoSubmitMessageToggle.checked = Boolean(items.autoSubmitMessage);
        showPartialTranscriptToggle.checked = Boolean(items.showPartialTranscript !== false);
        debugToggle.checked = Boolean(items.debug);
    });
}

function showApiStatus(message, type) {
    apiStatusDiv.textContent = message;
    apiStatusDiv.className = `status ${type}`;
    apiStatusDiv.style.display = "block";
}

// Toggle API key visibility
toggleApiKeyBtn.addEventListener("click", (e) => {
    e.preventDefault();
    const isPassword = apiKeyInput.type === "password";
    apiKeyInput.type = isPassword ? "text" : "password";
    toggleApiKeyBtn.textContent = isPassword ? "Hide" : "Show";
});

// Save API key
saveApiKeyBtn.addEventListener("click", () => {
    const apiKey = apiKeyInput.value.trim();

    if (!apiKey) {
        showApiStatus("Please enter an API key", "error");
        return;
    }

    if (apiKey.length < 10) {
        showApiStatus("API key seems too short", "error");
        return;
    }

    saveApiKeyBtn.disabled = true;
    saveApiKeyBtn.textContent = "Saving...";

    Promise.all([setApiKeyInLocal(apiKey), setApiKeyInSync(apiKey)])
        .then(() => loadSettings())
        .then(() => {
            saveApiKeyBtn.disabled = false;
            saveApiKeyBtn.textContent = "Save Key";
            showApiStatus("API key saved successfully ✓", "success");
        })
        .catch((err) => {
            saveApiKeyBtn.disabled = false;
            saveApiKeyBtn.textContent = "Save Key";
            showApiStatus(`Failed to save API key: ${err?.message || err}`, "error");
        });
});

// Delete API key
deleteApiKeyBtn.addEventListener("click", () => {
    if (!apiKeyInput.value) {
        showApiStatus("No API key to delete", "error");
        return;
    }

    if (!confirm("Are you sure you want to delete the API key?")) {
        return;
    }

    deleteApiKeyBtn.disabled = true;
    Promise.all([setApiKeyInLocal(null), setApiKeyInSync(null)])
        .then(() => loadSettings())
        .then(() => {
            deleteApiKeyBtn.disabled = false;
            apiKeyInput.value = "";
            apiKeyInput.type = "password";
            toggleApiKeyBtn.textContent = "Show";
            showApiStatus("API key deleted", "error");
        })
        .catch((err) => {
            deleteApiKeyBtn.disabled = false;
            showApiStatus(`Failed to delete API key: ${err?.message || err}`, "error");
        });
});

// Mode radio changes
modeTimerRadio.addEventListener("change", () => {
    if (modeTimerRadio.checked) {
        timerSettingsDiv.style.display = "block";
        chrome.storage.sync.set({ transcriptionMode: "timer" });
    }
});

modeManualRadio.addEventListener("change", () => {
    if (modeManualRadio.checked) {
        timerSettingsDiv.style.display = "none";
        chrome.storage.sync.set({ transcriptionMode: "manual" });
    }
});

// Auto-submit delay change
autoSubmitDelayInput.addEventListener("change", () => {
    let value = parseFloat(autoSubmitDelayInput.value);

    if (!Number.isFinite(value) || value < 0) {
        value = 0.5;
    }
    if (value > 10) {
        value = 10;
    }

    autoSubmitDelayInput.value = value.toFixed(1);
    const delayMs = Math.round(value * 1000);
    chrome.storage.sync.set({ autoSubmitDelayMs: delayMs });
});

// Settings changes
appendToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ appendMode: appendToggle.checked });
});

autoEnterToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ autoEnterAfterSubmit: autoEnterToggle.checked });
});

autoSubmitMessageToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ autoSubmitMessage: autoSubmitMessageToggle.checked });
});

showPartialTranscriptToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ showPartialTranscript: showPartialTranscriptToggle.checked });
});

debugToggle.addEventListener("change", () => {
    chrome.storage.sync.set({ debug: debugToggle.checked });
});

// Initialize on popup open
loadSettings();
