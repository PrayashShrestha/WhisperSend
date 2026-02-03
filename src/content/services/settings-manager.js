/**
 * Settings Management Module
 * Centralized settings management for the Speechmatics extension
 * 
 * @module SettingsManager
 * @description Handles all settings: loading, saving, validation, defaults
 *              Provides reactive settings with change listeners
 * 
 * Usage:
 * const settings = await SettingsManager.loadSettings();
 * SettingsManager.onSettingsChanged((newSettings) => {
 *   console.log("Settings changed:", newSettings);
 * });
 * SettingsManager.updateSetting("debug", true);
 */

const SettingsManager = (() => {
    /**
     * Default settings for all features
     * @constant {Object} DEFAULTS
     */
    const DEFAULTS = {
        // Text handling
        appendMode: true,
        appendSeparator: "\n",

        // Transcription behavior
        autoEnterAfterSubmit: true,
        autoSubmitMessage: false,
        autoSubmitDelayMs: 500,

        // UI/Display
        showPartialTranscript: true,

        // Debugging
        debug: false
    };

    /**
     * Setting validation rules
     * Each rule: (value) => boolean
     * @constant {Object} VALIDATION_RULES
     */
    const VALIDATION_RULES = {
        appendMode: (v) => typeof v === 'boolean',
        appendSeparator: (v) => typeof v === 'string',
        autoEnterAfterSubmit: (v) => typeof v === 'boolean',
        autoSubmitMessage: (v) => typeof v === 'boolean',
        autoSubmitDelayMs: (v) => Number.isInteger(v) && v >= 0 && v <= 10000,
        showPartialTranscript: (v) => typeof v === 'boolean',
        debug: (v) => typeof v === 'boolean'
    };

    // Internal state
    let currentSettings = { ...DEFAULTS };
    let changeListeners = [];

    /**
     * Load settings from Chrome storage
     * Merges stored settings with defaults
     * 
     * @returns {Promise<Object>} Current settings
     * 
     * @example
     * const settings = await SettingsManager.loadSettings();
     * console.log("Auto-submit delay:", settings.autoSubmitDelayMs);
     */
    function loadSettings() {
        return new Promise((resolve, reject) => {
            try {
                chrome.storage.sync.get(DEFAULTS, (items) => {
                    if (chrome.runtime.lastError) {
                        console.error("[Settings] Chrome storage error:", chrome.runtime.lastError);
                        // Fallback to defaults if storage fails
                        currentSettings = { ...DEFAULTS };
                        resolve(currentSettings);
                        return;
                    }

                    // Validate and filter settings
                    currentSettings = validateSettings(items);
                    notifyListeners(currentSettings);
                    resolve(currentSettings);
                });
            } catch (error) {
                console.error("[Settings] Failed to load settings:", error);
                reject(error);
            }
        });
    }

    /**
     * Validate settings against rules
     * Invalid settings are replaced with defaults
     * 
     * @param {Object} settings - Settings to validate
     * @returns {Object} Validated settings
     * 
     * @private
     */
    function validateSettings(settings) {
        const validated = { ...DEFAULTS };

        for (const [key, value] of Object.entries(settings)) {
            if (key in VALIDATION_RULES) {
                if (VALIDATION_RULES[key](value)) {
                    validated[key] = value;
                } else {
                    console.warn(`[Settings] Invalid value for ${key}, using default`);
                }
            }
        }

        return validated;
    }

    /**
     * Get the current value of a setting
     * 
     * @param {string} key - Setting key
     * @param {*} [defaultValue] - Default if not found
     * @returns {*} Setting value
     * 
     * @example
     * const delay = SettingsManager.getSetting("autoSubmitDelayMs");
     */
    function getSetting(key, defaultValue = undefined) {
        if (key in currentSettings) {
            return currentSettings[key];
        }
        return defaultValue !== undefined ? defaultValue : DEFAULTS[key];
    }

    /**
     * Get all current settings
     * Returns a copy to prevent external mutation
     * 
     * @returns {Object} Current settings object
     * 
     * @example
     * const allSettings = SettingsManager.getAllSettings();
     */
    function getAllSettings() {
        return { ...currentSettings };
    }

    /**
     * Update a single setting
     * Validates and saves to Chrome storage
     * 
     * @param {string} key - Setting key
     * @param {*} value - New value
     * @returns {Promise<boolean>} True if update succeeded
     * 
     * @example
     * const success = await SettingsManager.updateSetting("debug", true);
     * if (success) {
     *   console.log("Setting updated");
     * }
     */
    function updateSetting(key, value) {
        return new Promise((resolve, reject) => {
            // Validate the new value
            if (key in VALIDATION_RULES && !VALIDATION_RULES[key](value)) {
                console.error(`[Settings] Invalid value for ${key}:`, value);
                resolve(false);
                return;
            }

            // Update in memory
            currentSettings[key] = value;

            // Save to storage
            try {
                chrome.storage.sync.set({ [key]: value }, () => {
                    if (chrome.runtime.lastError) {
                        console.error("[Settings] Chrome storage error:", chrome.runtime.lastError);
                        resolve(false);
                        return;
                    }

                    notifyListeners(currentSettings);
                    resolve(true);
                });
            } catch (error) {
                console.error("[Settings] Failed to update setting:", error);
                reject(error);
            }
        });
    }

    /**
     * Update multiple settings at once
     * 
     * @param {Object} updates - Object with key-value pairs to update
     * @returns {Promise<boolean>} True if all updates succeeded
     * 
     * @example
     * await SettingsManager.updateSettings({
     *   autoSubmitDelayMs: 1000,
     *   showPartialTranscript: false
     * });
     */
    function updateSettings(updates) {
        return new Promise((resolve, reject) => {
            // Validate all updates
            for (const [key, value] of Object.entries(updates)) {
                if (key in VALIDATION_RULES && !VALIDATION_RULES[key](value)) {
                    console.error(`[Settings] Invalid value for ${key}:`, value);
                    resolve(false);
                    return;
                }
            }

            // Update in memory
            Object.assign(currentSettings, updates);

            // Save to storage
            try {
                chrome.storage.sync.set(updates, () => {
                    if (chrome.runtime.lastError) {
                        console.error("[Settings] Chrome storage error:", chrome.runtime.lastError);
                        resolve(false);
                        return;
                    }

                    notifyListeners(currentSettings);
                    resolve(true);
                });
            } catch (error) {
                console.error("[Settings] Failed to update settings:", error);
                reject(error);
            }
        });
    }

    /**
     * Reset settings to defaults
     * 
     * @returns {Promise<boolean>} True if reset succeeded
     * 
     * @example
     * const success = await SettingsManager.resetToDefaults();
     */
    function resetToDefaults() {
        currentSettings = { ...DEFAULTS };

        return new Promise((resolve) => {
            try {
                chrome.storage.sync.clear(() => {
                    chrome.storage.sync.set(DEFAULTS, () => {
                        notifyListeners(currentSettings);
                        resolve(true);
                    });
                });
            } catch (error) {
                console.error("[Settings] Failed to reset settings:", error);
                resolve(false);
            }
        });
    }

    /**
     * Register a listener for settings changes
     * Called whenever any setting changes
     * 
     * @param {Function} callback - Function to call with new settings
     * @returns {Function} Unsubscribe function
     * 
     * @example
     * const unsubscribe = SettingsManager.onSettingsChanged((settings) => {
     *   console.log("Settings changed:", settings);
     * });
     * 
     * // Later, to stop listening:
     * unsubscribe();
     */
    function onSettingsChanged(callback) {
        if (typeof callback !== 'function') {
            throw new Error("Callback must be a function");
        }

        changeListeners.push(callback);

        // Return unsubscribe function
        return () => {
            const index = changeListeners.indexOf(callback);
            if (index > -1) {
                changeListeners.splice(index, 1);
            }
        };
    }

    /**
     * Notify all listeners of settings changes
     * 
     * @param {Object} settings - Updated settings
     * 
     * @private
     */
    function notifyListeners(settings) {
        changeListeners.forEach(callback => {
            try {
                callback({ ...settings });
            } catch (error) {
                console.error("[Settings] Listener error:", error);
            }
        });
    }

    /**
     * Set up Chrome storage listener for external changes
     * Called automatically on module load
     * 
     * @private
     */
    function setupStorageListener() {
        try {
            chrome.storage.onChanged.addListener((changes, area) => {
                if (area !== "sync") return;

                // Update current settings
                for (const [key, change] of Object.entries(changes)) {
                    if ('newValue' in change) {
                        currentSettings[key] = change.newValue;
                    }
                }

                notifyListeners(currentSettings);
            });
        } catch (error) {
            console.error("[Settings] Failed to set up storage listener:", error);
        }
    }

    // Initialize storage listener
    setupStorageListener();

    // Public API
    return {
        // Constants
        DEFAULTS,
        VALIDATION_RULES,

        // Core methods
        loadSettings,
        getSetting,
        getAllSettings,
        updateSetting,
        updateSettings,
        resetToDefaults,
        onSettingsChanged
    };
})();

// Make available to other scripts
if (typeof window !== 'undefined') {
    window.SettingsManager = SettingsManager;
}
