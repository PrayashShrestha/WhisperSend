const EVENTS = {
    TRANSCRIPTION: "transcription",
    GET_TABS: "getChatGptTabs",
    SET_TARGET: "setChatGptTarget",
    GET_SPEECHMATICS_TEMP_KEY: "getSpeechmaticsTempKey",
};

const TARGETS = {
    CHATGPT: "chatgpt.com",
};

const SETTINGS_DEFAULTS = {
    appendMode: true,
    appendSeparator: "\n",
    transcriptionIntervalMs: 1000,
    targetChatGptTabId: null,
    debug: false,
    // Speechmatics settings
    // apiKey is stored in chrome.storage.local (popup), not in sync settings.
    transcriptionMode: "timer",
    autoSubmitDelayMs: 2000,
    autoEnterAfterSubmit: true,
    allowEditWhileTranscribing: false,
    cursorPinIdleMs: 500,
};

let settingsCache = { ...SETTINGS_DEFAULTS };

function loadSettings() {
    chrome.storage.sync.get(SETTINGS_DEFAULTS, (items) => {
        settingsCache = { ...SETTINGS_DEFAULTS, ...items };
    });
}

function log(...args) {
    if (settingsCache.debug) {
        console.log("[Background]", ...args);
    }
}

function findPreferredTab(tabs, urlSubstring, preferredTabId) {
    const matching = tabs.filter(
        (tab) => tab.url && tab.url.includes(urlSubstring)
    );
    if (matching.length === 0) {
        return null;
    }

    if (preferredTabId) {
        const preferred = matching.find((tab) => tab.id === preferredTabId);
        if (preferred) {
            return preferred;
        }
    }

    const pinned = matching.find((tab) => tab.pinned);
    if (pinned) {
        return pinned;
    }

    const active = matching.find((tab) => tab.active);
    if (active) {
        return active;
    }

    return matching[0];
}

function sendToMatchingTab(urlSubstring, payload, preferredTabId) {
    chrome.tabs.query({}, (tabs) => {
        const targetTab = findPreferredTab(tabs, urlSubstring, preferredTabId);
        if (targetTab?.id) {
            chrome.tabs.sendMessage(targetTab.id, payload);
        } else {
            log("Target tab not found for", urlSubstring);
        }
    });
}

chrome.runtime.onInstalled.addListener(() => {
    chrome.storage.sync.get(SETTINGS_DEFAULTS, (items) => {
        const nextSettings = { ...SETTINGS_DEFAULTS, ...items };
        chrome.storage.sync.set(nextSettings);
    });
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") {
        return;
    }

    Object.keys(changes).forEach((key) => {
        settingsCache[key] = changes[key].newValue;
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (settingsCache.targetChatGptTabId === tabId) {
        settingsCache.targetChatGptTabId = null;
        chrome.storage.sync.set({ targetChatGptTabId: null });
    }
});

loadSettings();

async function getSpeechmaticsApiKey() {
    // Prefer sync (persists reliably across incognito split modes), then local cache.
    const syncKey = await new Promise((resolve) => {
        chrome.storage.sync.get({ speechmaticsApiKey: null, apiKey: null }, (items) => {
            resolve(items?.speechmaticsApiKey || items?.apiKey || null);
        });
    });
    if (syncKey) {
        // Best-effort hydrate local cache for future reads.
        try {
            chrome.storage.local.set({ apiKey: syncKey });
        } catch {
            // ignore
        }
        return syncKey;
    }

    const localKey = await new Promise((resolve) => {
        chrome.storage.local.get({ apiKey: null }, (items) => {
            resolve(items?.apiKey || null);
        });
    });
    return localKey;
}

async function requestSpeechmaticsTempKey({ ttlSeconds }) {
    const apiKey = await getSpeechmaticsApiKey();
    if (!apiKey) {
        return { ok: false, error: "API_KEY_MISSING" };
    }

    // Speechmatics temporary keys API: POST /v1/api_keys?type=rt with Authorization Bearer
    const ttl = Math.max(60, Math.min(86400, Number(ttlSeconds) || 600));
    const resp = await fetch("https://mp.speechmatics.com/v1/api_keys?type=rt", {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ ttl }),
    });

    const text = await resp.text();
    let json = null;
    try {
        json = text ? JSON.parse(text) : null;
    } catch {
        // ignore
    }

    if (!resp.ok) {
        return {
            ok: false,
            error: "TEMP_KEY_REQUEST_FAILED",
            status: resp.status,
            body: json || text,
        };
    }

    const key_value = json?.key_value;
    if (!key_value) {
        return { ok: false, error: "TEMP_KEY_MALFORMED_RESPONSE", body: json || text };
    }

    return { ok: true, tempKey: key_value, ttlSeconds: ttl };
}

chrome.runtime.onMessage.addListener((data, sender, sendResponse) => {
    if (!data?.eventType) {
        return;
    }

    if (data.eventType === EVENTS.TRANSCRIPTION) {
        log("Forwarding transcription to ChatGPT");
        sendToMatchingTab(
            TARGETS.CHATGPT,
            data,
            settingsCache.targetChatGptTabId
        );
        return;
    }

    if (data.eventType === EVENTS.GET_TABS) {
        chrome.tabs.query({}, (tabs) => {
            const chatGptTabs = tabs.filter(
                (tab) => tab.url && tab.url.includes(TARGETS.CHATGPT)
            );
            const payload = {
                tabs: chatGptTabs.map((tab) => ({
                    id: tab.id,
                    title: tab.title,
                    url: tab.url,
                    active: tab.active,
                    pinned: tab.pinned,
                })),
                targetTabId: settingsCache.targetChatGptTabId,
            };
            sendResponse(payload);
        });
        return true;
    }

    if (data.eventType === EVENTS.SET_TARGET) {
        const nextId =
            typeof data.tabId === "number" ? data.tabId : null;
        settingsCache.targetChatGptTabId = nextId;
        chrome.storage.sync.set({ targetChatGptTabId: nextId });
        sendResponse({ ok: true });
        return;
    }

    if (data.eventType === EVENTS.GET_SPEECHMATICS_TEMP_KEY) {
        (async () => {
            try {
                const result = await requestSpeechmaticsTempKey({
                    ttlSeconds: data.ttlSeconds,
                });
                sendResponse(result);
            } catch (err) {
                sendResponse({
                    ok: false,
                    error: "TEMP_KEY_EXCEPTION",
                    message: err?.message || String(err),
                });
            }
        })();
        return true;
    }
});
