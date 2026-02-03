/**
 * State Manager Module
 * Centralized application state management with change notifications
 * 
 * @module StateManager
 * @description Manages application state with reactive updates,
 *              validation, persistence, and change subscriptions
 * 
 * Usage:
 * const state = new StateManager('app', { recording: false, connected: false });
 * state.subscribe('recording', handleChange);
 * state.set({ recording: true });
 */

class StateManager {
    /**
     * Create a new state manager
     * 
     * @param {string} name - State manager name (for debugging)
     * @param {Object} initialState - Initial state object
     * @param {Object} [options] - Configuration options
     * @param {boolean} [options.persist=false] - Persist to localStorage
     * @param {Function} [options.validator] - Validation function
     * @param {number} [options.maxHistorySize=50] - Max history entries
     * 
     * @example
     * const state = new StateManager('transcription', {
     *     isRecording: false,
     *     transcript: '',
     *     error: null
     * });
     */
    constructor(name, initialState = {}, options = {}) {
        this.name = name;
        this.state = { ...initialState };
        this.initialState = { ...initialState };
        this.subscriptions = new Map(); // eventName -> [callbacks]
        this.history = [];
        this.validators = new Map();

        this.persist = options.persist || false;
        this.validator = options.validator;
        this.maxHistorySize = options.maxHistorySize || 50;

        // Load persisted state if enabled
        if (this.persist) {
            this.restore();
        }
    }

    /**
     * Get current state or specific property
     * 
     * @param {string} [key] - Property key. If omitted, returns entire state
     * @returns {*} Current state or property value
     * 
     * @example
     * const state = manager.get(); // Get all
     * const isRecording = manager.get('isRecording'); // Get specific
     */
    get(key) {
        if (!key) {
            return { ...this.state };
        }

        if (!(key in this.state)) {
            console.warn(`[${this.name}] Property '${key}' not found in state`);
            return undefined;
        }

        return this.state[key];
    }

    /**
     * Set state value(s)
     * 
     * @param {string|Object} keyOrObj - Property key or state object
     * @param {*} [value] - Value if first param is a key
     * @returns {StateManager} Returns this for method chaining
     * 
     * @throws {Error} If validation fails
     * 
     * @example
     * manager.set('recording', true);
     * manager.set({ recording: true, count: 5 });
     */
    set(keyOrObj, value) {
        const updates = typeof keyOrObj === 'string'
            ? { [keyOrObj]: value }
            : keyOrObj;

        // Validate
        if (this.validator) {
            try {
                this.validator({ ...this.state, ...updates });
            } catch (error) {
                console.error(`[${this.name}] Validation failed:`, error.message);
                throw error;
            }
        }

        // Track changes
        const changes = {};
        for (const [key, newValue] of Object.entries(updates)) {
            const oldValue = this.state[key];
            if (oldValue !== newValue) {
                changes[key] = { old: oldValue, new: newValue };
                this.state[key] = newValue;
            }
        }

        // Record history and persist
        if (Object.keys(changes).length > 0) {
            this.recordHistory(changes);
            if (this.persist) {
                this.save();
            }

            // Notify subscribers
            for (const [key, { new: newValue }] of Object.entries(changes)) {
                this.notifySubscribers(key, newValue);
            }
        }

        return this;
    }

    /**
     * Update state by applying a function
     * 
     * @param {string} key - Property key
     * @param {Function} updater - Function that takes old value and returns new value
     * @returns {StateManager} Returns this for method chaining
     * 
     * @example
     * manager.update('count', count => count + 1);
     * manager.update('items', items => [...items, newItem]);
     */
    update(key, updater) {
        if (typeof updater !== 'function') {
            throw new TypeError('Updater must be a function');
        }

        const oldValue = this.state[key];
        const newValue = updater(oldValue);
        return this.set(key, newValue);
    }

    /**
     * Reset state to initial values
     * 
     * @param {string|string[]} [keys] - Specific keys to reset.
     *                                   If omitted, resets all
     * @returns {StateManager} Returns this for method chaining
     * 
     * @example
     * manager.reset(); // Reset everything
     * manager.reset('transcript'); // Reset one property
     * manager.reset(['recording', 'transcript']); // Reset multiple
     */
    reset(keys) {
        if (!keys) {
            // Reset all
            this.set({ ...this.initialState });
        } else {
            // Reset specific keys
            const keysToReset = Array.isArray(keys) ? keys : [keys];
            const updates = {};
            for (const key of keysToReset) {
                if (key in this.initialState) {
                    updates[key] = this.initialState[key];
                }
            }
            if (Object.keys(updates).length > 0) {
                this.set(updates);
            }
        }
        return this;
    }

    /**
     * Subscribe to state changes
     * 
     * @param {string} key - Property key to watch
     * @param {Function} callback - Called with (newValue, oldValue)
     * @returns {Function} Unsubscribe function
     * 
     * @example
     * const unsubscribe = manager.subscribe('recording', (newVal, oldVal) => {
     *     console.log(`Recording changed: ${oldVal} -> ${newVal}`);
     * });
     * 
     * // Later
     * unsubscribe();
     */
    subscribe(key, callback) {
        if (typeof callback !== 'function') {
            throw new TypeError('Callback must be a function');
        }

        if (!this.subscriptions.has(key)) {
            this.subscriptions.set(key, []);
        }

        this.subscriptions.get(key).push(callback);

        // Return unsubscribe function
        return () => this.unsubscribe(key, callback);
    }

    /**
     * Unsubscribe from state changes
     * 
     * @param {string} key - Property key
     * @param {Function} [callback] - Specific callback to remove.
     *                               If omitted, removes all for this key
     * @returns {StateManager} Returns this for method chaining
     * 
     * @example
     * manager.unsubscribe('recording', handleChange);
     * manager.unsubscribe('recording'); // Remove all
     */
    unsubscribe(key, callback) {
        if (!this.subscriptions.has(key)) {
            return this;
        }

        if (!callback) {
            this.subscriptions.delete(key);
        } else {
            const callbacks = this.subscriptions.get(key);
            const index = callbacks.indexOf(callback);
            if (index > -1) {
                callbacks.splice(index, 1);
                if (callbacks.length === 0) {
                    this.subscriptions.delete(key);
                }
            }
        }

        return this;
    }

    /**
     * Notify all subscribers of a change
     * 
     * @param {string} key - Property key
     * @param {*} newValue - New value
     * 
     * @private
     */
    notifySubscribers(key, newValue) {
        if (!this.subscriptions.has(key)) {
            return;
        }

        const callbacks = this.subscriptions.get(key).slice();
        const oldValue = this.history.length > 0
            ? this.history[this.history.length - 1].changes[key]?.old
            : undefined;

        for (const callback of callbacks) {
            try {
                callback(newValue, oldValue);
            } catch (error) {
                console.error(
                    `[${this.name}] Error in subscriber for '${key}':`,
                    error
                );
            }
        }
    }

    /**
     * Record a change in history
     * 
     * @param {Object} changes - Change object
     * 
     * @private
     */
    recordHistory(changes) {
        this.history.push({
            timestamp: Date.now(),
            changes
        });

        // Limit history size
        if (this.history.length > this.maxHistorySize) {
            this.history.shift();
        }
    }

    /**
     * Get state history
     * 
     * @param {number} [limit] - Max entries to return
     * @returns {Array} History entries
     * 
     * @example
     * const recent = manager.getHistory(5);
     */
    getHistory(limit) {
        if (!limit) {
            return this.history.slice();
        }
        return this.history.slice(-limit);
    }

    /**
     * Clear history
     * 
     * @returns {StateManager} Returns this for method chaining
     */
    clearHistory() {
        this.history = [];
        return this;
    }

    /**
     * Persist state to localStorage
     * 
     * @returns {boolean} True if successful
     * 
     * @example
     * manager.save();
     * 
     * @private
     */
    save() {
        try {
            const key = `__state_${this.name}`;
            localStorage.setItem(key, JSON.stringify(this.state));
            return true;
        } catch (error) {
            console.error(`[${this.name}] Failed to save state:`, error);
            return false;
        }
    }

    /**
     * Restore state from localStorage
     * 
     * @returns {boolean} True if successful
     * 
     * @example
     * manager.restore();
     * 
     * @private
     */
    restore() {
        try {
            const key = `__state_${this.name}`;
            const stored = localStorage.getItem(key);
            if (stored) {
                this.state = JSON.parse(stored);
                return true;
            }
            return false;
        } catch (error) {
            console.error(`[${this.name}] Failed to restore state:`, error);
            return false;
        }
    }

    /**
     * Clear persisted state from localStorage
     * 
     * @returns {StateManager} Returns this for method chaining
     * 
     * @example
     * manager.clearPersisted();
     */
    clearPersisted() {
        try {
            const key = `__state_${this.name}`;
            localStorage.removeItem(key);
        } catch (error) {
            console.error(`[${this.name}] Failed to clear persisted state:`, error);
        }
        return this;
    }

    /**
     * Get debug information
     * 
     * @returns {Object} Debug information
     * 
     * @example
     * console.log(manager.debug());
     */
    debug() {
        return {
            name: this.name,
            state: { ...this.state },
            subscriptions: Array.from(this.subscriptions.keys()),
            historySize: this.history.length,
            persisted: this.persist,
            lastChange: this.history.length > 0
                ? new Date(this.history[this.history.length - 1].timestamp).toISOString()
                : null
        };
    }
}

// Export for use in different environments
if (typeof window !== 'undefined') {
    window.StateManager = StateManager;
}
