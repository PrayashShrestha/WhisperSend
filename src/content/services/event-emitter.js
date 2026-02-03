/**
 * Event Emitter Utility Module
 * Lightweight pub/sub pattern for inter-component communication
 * 
 * @module EventEmitter
 * @description Simple but powerful event system for decoupled communication
 *              between different parts of the extension
 * 
 * Usage:
 * const emitter = new EventEmitter();
 * emitter.on('transcriptionStart', handleStart);
 * emitter.emit('transcriptionStart', { data });
 * emitter.off('transcriptionStart', handleStart);
 */

class EventEmitter {
    /**
     * Initialize a new EventEmitter
     * 
     * @param {string} [name='EventEmitter'] - Optional name for debugging
     */
    constructor(name = 'EventEmitter') {
        this.name = name;
        this.events = new Map();
        this.maxListeners = 10;
        this.listeners = new WeakMap();
    }

    /**
     * Register an event listener
     * 
     * @param {string} eventName - Name of the event
     * @param {Function} callback - Function to call when event is emitted
     * @returns {EventEmitter} Returns this for method chaining
     * 
     * @throws {TypeError} If callback is not a function
     * 
     * @example
     * emitter.on('ready', () => console.log('Ready!'));
     * 
     * @example
     * emitter.on('userAction', (data) => {
     *     console.log('User did:', data.action);
     * });
     */
    on(eventName, callback) {
        if (typeof callback !== 'function') {
            throw new TypeError(`Callback must be a function, got ${typeof callback}`);
        }

        if (!eventName || typeof eventName !== 'string') {
            throw new TypeError(`Event name must be a non-empty string`);
        }

        if (!this.events.has(eventName)) {
            this.events.set(eventName, []);
        }

        const listeners = this.events.get(eventName);

        // Warn if too many listeners (possible memory leak)
        if (listeners.length >= this.maxListeners) {
            console.warn(
                `[${this.name}] Warning: ${listeners.length} listeners for event '${eventName}'. ` +
                `This may indicate a memory leak.`
            );
        }

        listeners.push(callback);

        // Return callback for easier unsubscription
        return this;
    }

    /**
     * Register a one-time event listener (auto-removes after firing)
     * 
     * @param {string} eventName - Name of the event
     * @param {Function} callback - Function to call once when event is emitted
     * @returns {EventEmitter} Returns this for method chaining
     * 
     * @example
     * emitter.once('connected', () => {
     *     console.log('Connected for the first time');
     * });
     */
    once(eventName, callback) {
        if (typeof callback !== 'function') {
            throw new TypeError(`Callback must be a function, got ${typeof callback}`);
        }

        const wrappedCallback = (...args) => {
            callback(...args);
            this.off(eventName, wrappedCallback);
        };

        // Store reference to original callback for cleanup
        wrappedCallback.original = callback;

        return this.on(eventName, wrappedCallback);
    }

    /**
     * Unregister an event listener
     * 
     * @param {string} eventName - Name of the event
     * @param {Function} [callback] - Specific callback to remove.
     *                               If omitted, removes all listeners for the event
     * @returns {EventEmitter} Returns this for method chaining
     * 
     * @example
     * // Remove specific listener
     * emitter.off('transcribe', myCallback);
     * 
     * @example
     * // Remove all listeners for an event
     * emitter.off('transcribe');
     */
    off(eventName, callback) {
        if (!this.events.has(eventName)) {
            return this;
        }

        if (!callback) {
            // Remove all listeners for this event
            this.events.delete(eventName);
            return this;
        }

        const listeners = this.events.get(eventName);
        const index = listeners.findIndex(listener =>
            listener === callback || listener.original === callback
        );

        if (index !== -1) {
            listeners.splice(index, 1);

            // Clean up empty event lists
            if (listeners.length === 0) {
                this.events.delete(eventName);
            }
        }

        return this;
    }

    /**
     * Emit an event and call all registered listeners
     * 
     * @param {string} eventName - Name of the event to emit
     * @param {...*} args - Arguments to pass to listeners
     * @returns {boolean} True if at least one listener was called
     * 
     * @throws {Error} If a listener throws an error (wrapped in context)
     * 
     * @example
     * emitter.emit('transcriptionComplete', { text: 'hello' });
     * 
     * @example
     * emitter.emit('userClick', { x: 100, y: 200 });
     */
    emit(eventName, ...args) {
        if (!this.events.has(eventName)) {
            return false;
        }

        const listeners = this.events.get(eventName).slice(); // Copy array
        let hadListeners = false;

        for (const listener of listeners) {
            try {
                listener(...args);
                hadListeners = true;
            } catch (error) {
                console.error(
                    `[${this.name}] Error in listener for event '${eventName}':`,
                    error
                );
                // Continue calling other listeners even if one fails
            }
        }

        return hadListeners;
    }

    /**
     * Get all listeners for an event
     * 
     * @param {string} eventName - Name of the event
     * @returns {Function[]} Array of listener functions
     * 
     * @example
     * const listeners = emitter.listenerCount('ready');
     */
    listeners(eventName) {
        if (!this.events.has(eventName)) {
            return [];
        }
        return this.events.get(eventName).slice();
    }

    /**
     * Get count of listeners for an event
     * 
     * @param {string} eventName - Name of the event
     * @returns {number} Number of listeners
     * 
     * @example
     * const count = emitter.listenerCount('transcribe');
     */
    listenerCount(eventName) {
        if (!this.events.has(eventName)) {
            return 0;
        }
        return this.events.get(eventName).length;
    }

    /**
     * Get all event names with listeners
     * 
     * @returns {string[]} Array of event names
     * 
     * @example
     * const events = emitter.eventNames();
     */
    eventNames() {
        return Array.from(this.events.keys());
    }

    /**
     * Remove all listeners
     * 
     * @param {string} [eventName] - If provided, only removes listeners for that event
     * @returns {EventEmitter} Returns this for method chaining
     * 
     * @example
     * emitter.removeAllListeners(); // Clear everything
     * 
     * @example
     * emitter.removeAllListeners('ready'); // Clear one event
     */
    removeAllListeners(eventName) {
        if (eventName) {
            this.events.delete(eventName);
        } else {
            this.events.clear();
        }
        return this;
    }

    /**
     * Set the maximum number of listeners before warning
     * 
     * @param {number} count - Maximum listener count
     * @returns {EventEmitter} Returns this for method chaining
     * 
     * @example
     * emitter.setMaxListeners(20);
     */
    setMaxListeners(count) {
        if (typeof count !== 'number' || count < 0) {
            throw new TypeError('Count must be a non-negative number');
        }
        this.maxListeners = count;
        return this;
    }

    /**
     * Get debug information about this emitter
     * 
     * @returns {Object} Debug information
     * 
     * @example
     * console.log(emitter.debug());
     * // { 
     * //   name: 'MyEmitter',
     * //   events: 5,
     * //   totalListeners: 12,
     * //   maxListeners: 10
     * // }
     */
    debug() {
        let totalListeners = 0;
        const eventInfo = {};

        for (const [name, listeners] of this.events) {
            eventInfo[name] = listeners.length;
            totalListeners += listeners.length;
        }

        return {
            name: this.name,
            eventCount: this.events.size,
            totalListeners,
            maxListeners: this.maxListeners,
            events: eventInfo
        };
    }
}

// Export for use in different environments
if (typeof module !== 'undefined' && module.exports) {
    module.exports = EventEmitter;
}

if (typeof window !== 'undefined') {
    window.EventEmitter = EventEmitter;
}
