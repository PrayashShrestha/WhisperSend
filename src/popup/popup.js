// API Key Elements
const apiKeyInput = document.querySelector("#api-key");
const toggleApiKeyBtn = document.querySelector("#toggle-api-key");
const saveApiKeyBtn = document.querySelector("#save-api-key");
const deleteApiKeyBtn = document.querySelector("#delete-api-key");
const apiStatusDiv = document.querySelector("#api-status");

// Microphone Elements
const micSelect = document.querySelector("#mic-device");
const refreshMicsBtn = document.querySelector("#refresh-mics");
const applyMicBtn = document.querySelector("#apply-mic");
const micStatusDiv = document.querySelector("#mic-status");

// Prompt Checklist Elements
const promptChecklistDiv = document.querySelector("#prompt-checklist");
const promptNewInput = document.querySelector("#prompt-new");
const promptAddBtn = document.querySelector("#prompt-add");
const promptClearBtn = document.querySelector("#prompt-clear");

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
    preferredAudioInputDeviceId: null,
    promptChecklist: [
        { id: "prompt", text: "Make sure to have this in your response", checked: false },
        { id: "professional", text: "Respond the answer in a professional way", checked: false },
        { id: "short", text: "Give short and crisp answer", checked: false },
        { id: "simple", text: "Give me in simple and natural B1 and B2 level English in paragraph", checked: false },
    ],
};

// Keep a shadow copy in sync as a fallback (some users run ChatGPT in incognito /
// split profiles where local storage can behave unexpectedly).
const SYNC_KEYS = { ...SETTINGS_DEFAULTS, apiKey: null, speechmaticsApiKey: null };

function showMicStatus(message, type) {
    micStatusDiv.textContent = message;
    micStatusDiv.className = `status ${type}`;
    micStatusDiv.style.display = "block";
}

function clearMicOptions({ preserveValue = true } = {}) {
    const current = preserveValue ? micSelect.value : "";
    micSelect.innerHTML = "";
    const def = document.createElement("option");
    def.value = "";
    def.textContent = "Default";
    micSelect.appendChild(def);
    if (preserveValue) {
        micSelect.value = current;
    }
}

function getChatGptTab() {
    return new Promise((resolve) => {
        chrome.tabs.query({ currentWindow: true }, (tabs) => {
            if (chrome.runtime.lastError) {
                resolve(null);
                return;
            }
            const isChat = (t) => typeof t?.url === "string" && t.url.includes("chatgpt.com");
            const activeChat = tabs.find((t) => t.active && isChat(t));
            if (activeChat) {
                resolve(activeChat);
                return;
            }
            const anyChat = tabs.find(isChat);
            resolve(anyChat || null);
        });
    });
}

function sendToChatTab(message) {
    return new Promise(async (resolve) => {
        const tab = await getChatGptTab();
        if (!tab?.id) {
            resolve({ ok: false, error: "CHATGPT_TAB_NOT_FOUND" });
            return;
        }

        chrome.tabs.sendMessage(tab.id, message, (resp) => {
            if (chrome.runtime.lastError) {
                resolve({
                    ok: false,
                    error: "NO_CONTENT_SCRIPT",
                    message: chrome.runtime.lastError.message,
                });
                return;
            }
            resolve(resp || { ok: false, error: "EMPTY_RESPONSE" });
        });
    });
}

async function refreshMicrophones({ preferredId = null } = {}) {
    if (!micSelect || !refreshMicsBtn || !applyMicBtn || !micStatusDiv) {
        return;
    }

    applyMicBtn.disabled = true;
    refreshMicsBtn.disabled = true;
    showMicStatus("Loading microphones...", "success");

    const resp = await sendToChatTab({ type: "wispersend:listAudioInputs" });
    if (!resp?.ok) {
        clearMicOptions({ preserveValue: false });
        const msg =
            resp?.error === "CHATGPT_TAB_NOT_FOUND"
                ? "Open a ChatGPT tab to list microphones."
                : "Couldn't list microphones. Refresh ChatGPT and try again.";
        showMicStatus(msg, "error");
        applyMicBtn.disabled = false;
        refreshMicsBtn.disabled = false;
        return;
    }

    clearMicOptions({ preserveValue: false });
    const devices = Array.isArray(resp.devices) ? resp.devices : [];
    devices.forEach((d) => {
        const opt = document.createElement("option");
        opt.value = d.deviceId;
        opt.textContent = d.label || "Microphone";
        micSelect.appendChild(opt);
    });

    const selected =
        typeof preferredId === "string"
            ? preferredId
            : typeof resp.selectedDeviceId === "string"
                ? resp.selectedDeviceId
                : "";
    micSelect.value = selected || "";
    showMicStatus(`Found ${devices.length} microphone(s).`, "success");
    applyMicBtn.disabled = false;
    refreshMicsBtn.disabled = false;
}

function normalizeChecklist(list) {
    const arr = Array.isArray(list) ? list : [];
    return arr
        .map((i, idx) => ({
            id: typeof i?.id === "string" && i.id ? i.id : `item-${Date.now()}-${idx}`,
            text: typeof i?.text === "string" ? i.text.trim() : "",
            checked: Boolean(i?.checked),
        }))
        .filter((i) => i.text);
}

function renderChecklist(list) {
    if (!promptChecklistDiv) return;
    promptChecklistDiv.innerHTML = "";

    const items = normalizeChecklist(list);
    if (items.length === 0) {
        const empty = document.createElement("div");
        empty.className = "hint";
        empty.textContent = "No items yet.";
        promptChecklistDiv.appendChild(empty);
        return;
    }

    items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "row";

        const label = document.createElement("label");
        label.style.flex = "1";
        label.style.gap = "8px";

        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = Boolean(item.checked);
        cb.addEventListener("change", () => {
            chrome.storage.sync.get({ promptChecklist: items }, (existing) => {
                const next = normalizeChecklist(existing.promptChecklist).map((x) =>
                    x.id === item.id ? { ...x, checked: cb.checked } : x
                );
                chrome.storage.sync.set({ promptChecklist: next }, () => {
                    renderChecklist(next);
                });
            });
        });

        const text = document.createElement("span");
        text.textContent = item.text;

        const del = document.createElement("button");
        del.type = "button";
        del.className = "danger";
        del.style.padding = "6px 10px";
        del.textContent = "Delete";
        del.addEventListener("click", () => {
            chrome.storage.sync.get({ promptChecklist: items }, (existing) => {
                const next = normalizeChecklist(existing.promptChecklist).filter((x) => x.id !== item.id);
                chrome.storage.sync.set({ promptChecklist: next }, () => {
                    renderChecklist(next);
                });
            });
        });

        label.appendChild(cb);
        label.appendChild(text);
        row.appendChild(label);
        row.appendChild(del);
        promptChecklistDiv.appendChild(row);
    });
}

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

        const preferredDeviceId =
            typeof items.preferredAudioInputDeviceId === "string"
                ? items.preferredAudioInputDeviceId
                : null;
        await refreshMicrophones({ preferredId: preferredDeviceId });

        renderChecklist(items.promptChecklist);
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

refreshMicsBtn?.addEventListener("click", () => {
    refreshMicrophones();
});

applyMicBtn?.addEventListener("click", async () => {
    const deviceId = micSelect?.value || null;
    if (!micStatusDiv) return;

    applyMicBtn.disabled = true;
    chrome.storage.sync.set({ preferredAudioInputDeviceId: deviceId }, async () => {
        if (chrome.runtime.lastError) {
            showMicStatus("Failed to save microphone preference.", "error");
            applyMicBtn.disabled = false;
            return;
        }

        const resp = await sendToChatTab({ type: "wispersend:setAudioInput", deviceId });
        if (!resp?.ok) {
            if (resp?.error === "RECORDING_ACTIVE") {
                showMicStatus("Stop recording to switch microphone.", "error");
            } else {
                showMicStatus("Saved. If it didn’t apply, refresh ChatGPT.", "error");
            }
            applyMicBtn.disabled = false;
            return;
        }

        showMicStatus("Microphone updated ✓", "success");
        applyMicBtn.disabled = false;
    });
});

promptAddBtn?.addEventListener("click", () => {
    const text = (promptNewInput?.value || "").trim();
    if (!text) return;

    chrome.storage.sync.get({ promptChecklist: SETTINGS_DEFAULTS.promptChecklist }, (existing) => {
        const list = normalizeChecklist(existing.promptChecklist);
        const next = [
            ...list,
            {
                id: `custom-${Date.now()}`,
                text,
                checked: true,
            },
        ];
        chrome.storage.sync.set({ promptChecklist: next }, () => {
            if (promptNewInput) promptNewInput.value = "";
            renderChecklist(next);
        });
    });
});

promptNewInput?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
        e.preventDefault();
        promptAddBtn?.click();
    }
});

promptClearBtn?.addEventListener("click", () => {
    if (!confirm("Clear all prompt checklist items?")) return;
    chrome.storage.sync.set({ promptChecklist: [] }, () => {
        renderChecklist([]);
    });
});

// Initialize on popup open
loadSettings();
