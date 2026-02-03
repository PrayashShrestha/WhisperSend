/**
 * API Client Module
 * Centralized HTTP/WebSocket request handler with retry and error handling
 * 
 * @module APIClient
 * @description Manages all API communication with proper error handling,
 *              retries, timeouts, and request logging for debugging
 * 
 * Usage:
 * const response = await APIClient.post('/api/transcribe', { audio: data });
 * const ws = APIClient.openWebSocket('wss://api.example.com');
 */

const APIClient = (() => {
    /**
     * Configuration for API requests
     * @constant {Object} CONFIG
     */
    const CONFIG = {
        DEFAULT_TIMEOUT: 30000,           // 30 seconds
        MAX_RETRIES: 3,
        RETRY_DELAY: 1000,                // Initial delay in ms
        RETRY_BACKOFF: 2,                 // Exponential backoff multiplier
        ENABLE_LOGGING: true,
        LOG_PREFIX: '[APIClient]'
    };

    /**
     * HTTP request headers
     * @constant {Object} DEFAULT_HEADERS
     */
    const DEFAULT_HEADERS = {
        'Content-Type': 'application/json'
    };

    /**
     * Make an HTTP request with retry logic
     * 
     * @param {string} url - The URL to request
     * @param {Object} options - Request options
     * @param {string} [options.method='GET'] - HTTP method
     * @param {Object} [options.headers] - Custom headers
     * @param {*} [options.body] - Request body (auto-serialized if object)
     * @param {number} [options.timeout] - Request timeout in ms
     * @param {number} [options.maxRetries] - Max retry attempts
     * @param {Function} [options.onProgress] - Progress callback
     * @param {AbortSignal} [options.signal] - Abort signal
     * @returns {Promise<Object>} Response object { status, data, headers, ok }
     * 
     * @throws {Error} On failure after all retries
     * 
     * @example
     * const response = await APIClient.request('/api/data', {
     *     method: 'POST',
     *     body: { name: 'John' },
     *     timeout: 5000
     * });
     */
    async function request(url, options = {}) {
        const {
            method = 'GET',
            headers = {},
            body,
            timeout = CONFIG.DEFAULT_TIMEOUT,
            maxRetries = CONFIG.MAX_RETRIES,
            onProgress,
            signal
        } = options;

        // Prepare headers
        const finalHeaders = {
            ...DEFAULT_HEADERS,
            ...headers
        };

        // Prepare body
        let finalBody = body;
        if (body && typeof body === 'object') {
            finalBody = JSON.stringify(body);
        }

        // Attempt request with retries
        let lastError;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            try {
                log(`${method} ${url} (Attempt ${attempt + 1}/${maxRetries + 1})`);

                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), timeout);

                try {
                    const fetchOptions = {
                        method,
                        headers: finalHeaders,
                        signal: signal || controller.signal
                    };

                    if (finalBody) {
                        fetchOptions.body = finalBody;
                    }

                    const response = await fetch(url, fetchOptions);

                    clearTimeout(timeoutId);

                    const contentType = response.headers.get('content-type');
                    let data;

                    try {
                        if (contentType?.includes('application/json')) {
                            data = await response.json();
                        } else if (contentType?.includes('text')) {
                            data = await response.text();
                        } else {
                            data = await response.blob();
                        }
                    } catch (parseError) {
                        log(`Warning: Could not parse response body: ${parseError.message}`);
                        data = null;
                    }

                    const result = {
                        status: response.status,
                        ok: response.ok,
                        data,
                        headers: Object.fromEntries(response.headers.entries())
                    };

                    if (!response.ok) {
                        const error = new Error(
                            `HTTP ${response.status}: ${response.statusText}`
                        );
                        error.response = result;
                        throw error;
                    }

                    log(`✓ ${method} ${url} (${response.status})`);
                    return result;

                } catch (error) {
                    clearTimeout(timeoutId);
                    throw error;
                }

            } catch (error) {
                lastError = error;

                // Check if error is retryable
                const isRetryable = isRetryableError(error);
                const hasMoreAttempts = attempt < maxRetries;

                if (isRetryable && hasMoreAttempts) {
                    const delay = CONFIG.RETRY_DELAY * Math.pow(CONFIG.RETRY_BACKOFF, attempt);
                    log(`⚠ Error (retrying in ${delay}ms): ${error.message}`);

                    // Wait before retry with optional cancellation support
                    await new Promise(resolve => setTimeout(resolve, delay));
                } else {
                    // Final failure or non-retryable error
                    log(`✗ ${method} ${url}: ${error.message}`);

                    if (isRetryable) {
                        log(`  (Max retries exhausted after ${maxRetries} attempts)`);
                    }

                    throw error;
                }
            }
        }

        throw lastError || new Error('Unknown request error');
    }

    /**
     * Make a GET request
     * 
     * @param {string} url - The URL
     * @param {Object} [options] - Additional options
     * @returns {Promise<Object>} Response object
     * 
     * @example
     * const data = await APIClient.get('/api/users');
     */
    async function get(url, options = {}) {
        return request(url, { ...options, method: 'GET' });
    }

    /**
     * Make a POST request
     * 
     * @param {string} url - The URL
     * @param {*} body - Request body
     * @param {Object} [options] - Additional options
     * @returns {Promise<Object>} Response object
     * 
     * @example
     * const response = await APIClient.post('/api/transcribe', { audio: data });
     */
    async function post(url, body, options = {}) {
        return request(url, { ...options, method: 'POST', body });
    }

    /**
     * Make a PUT request
     * 
     * @param {string} url - The URL
     * @param {*} body - Request body
     * @param {Object} [options] - Additional options
     * @returns {Promise<Object>} Response object
     */
    async function put(url, body, options = {}) {
        return request(url, { ...options, method: 'PUT', body });
    }

    /**
     * Make a DELETE request
     * 
     * @param {string} url - The URL
     * @param {Object} [options] - Additional options
     * @returns {Promise<Object>} Response object
     */
    async function deleteRequest(url, options = {}) {
        return request(url, { ...options, method: 'DELETE' });
    }

    /**
     * Open a WebSocket connection with automatic reconnection
     * 
     * @param {string} url - WebSocket URL
     * @param {Object} options - WebSocket options
     * @param {number} [options.maxReconnectAttempts=5] - Max reconnection attempts
     * @param {number} [options.reconnectDelay=1000] - Initial delay between reconnects
     * @param {Function} [options.onOpen] - Open callback
     * @param {Function} [options.onMessage] - Message callback
     * @param {Function} [options.onError] - Error callback
     * @param {Function} [options.onClose] - Close callback
     * @returns {Object} WebSocket wrapper with open/close/send methods
     * 
     * @example
     * const ws = APIClient.openWebSocket('wss://api.example.com', {
     *     onOpen: () => console.log('Connected'),
     *     onMessage: (data) => console.log('Got:', data),
     *     onError: (error) => console.error('Error:', error),
     *     onClose: () => console.log('Disconnected')
     * });
     * 
     * ws.send({ command: 'transcribe' });
     * ws.close();
     */
    function openWebSocket(url, options = {}) {
        const {
            maxReconnectAttempts = 5,
            reconnectDelay = 1000,
            onOpen,
            onMessage,
            onError,
            onClose
        } = options;

        let ws;
        let reconnectAttempts = 0;
        let isClosed = false;

        /**
         * Connect to WebSocket
         * @private
         */
        function connect() {
            try {
                log(`🔗 Connecting to WebSocket: ${url}`);
                ws = new WebSocket(url);

                ws.onopen = () => {
                    reconnectAttempts = 0;
                    log(`✓ WebSocket connected`);
                    if (onOpen) onOpen();
                };

                ws.onmessage = (event) => {
                    try {
                        const data = typeof event.data === 'string'
                            ? JSON.parse(event.data)
                            : event.data;
                        if (onMessage) onMessage(data);
                    } catch (error) {
                        log(`Error parsing WebSocket message: ${error.message}`);
                    }
                };

                ws.onerror = (error) => {
                    log(`✗ WebSocket error: ${error.message}`);
                    if (onError) onError(error);
                };

                ws.onclose = () => {
                    if (!isClosed && reconnectAttempts < maxReconnectAttempts) {
                        reconnectAttempts++;
                        const delay = reconnectDelay * Math.pow(2, reconnectAttempts - 1);
                        log(`↻ Reconnecting (${reconnectAttempts}/${maxReconnectAttempts}) in ${delay}ms...`);
                        setTimeout(connect, delay);
                    } else {
                        log(`✗ WebSocket closed (${isClosed ? 'intentionally' : 'max retries reached'})`);
                        if (onClose) onClose();
                    }
                };
            } catch (error) {
                log(`Error creating WebSocket: ${error.message}`);
                if (onError) onError(error);
            }
        }

        connect();

        // Return wrapper object
        return {
            /**
             * Send a message through WebSocket
             * 
             * @param {*} data - Data to send (auto-serialized if object)
             * @returns {boolean} True if sent, false if not connected
             */
            send(data) {
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    log('Warning: WebSocket not ready for sending');
                    return false;
                }

                try {
                    const message = typeof data === 'string' ? data : JSON.stringify(data);
                    ws.send(message);
                    return true;
                } catch (error) {
                    log(`Error sending WebSocket message: ${error.message}`);
                    return false;
                }
            },

            /**
             * Close the WebSocket connection
             */
            close() {
                isClosed = true;
                if (ws && ws.readyState !== WebSocket.CLOSED) {
                    ws.close();
                }
            },

            /**
             * Check if WebSocket is connected
             */
            isConnected() {
                return ws && ws.readyState === WebSocket.OPEN;
            },

            /**
             * Get current WebSocket state
             */
            getState() {
                if (!ws) return 'not_initialized';
                const states = {
                    [WebSocket.CONNECTING]: 'connecting',
                    [WebSocket.OPEN]: 'open',
                    [WebSocket.CLOSING]: 'closing',
                    [WebSocket.CLOSED]: 'closed'
                };
                return states[ws.readyState] || 'unknown';
            }
        };
    }

    /**
     * Check if an error is retryable
     * 
     * @param {Error} error - The error to check
     * @returns {boolean} True if error is retryable
     * 
     * @private
     */
    function isRetryableError(error) {
        // Network errors are retryable
        if (error instanceof TypeError && error.message.includes('Failed to fetch')) {
            return true;
        }

        // Timeout errors are retryable
        if (error.name === 'AbortError') {
            return true;
        }

        // Server errors are retryable
        if (error.response?.status >= 500) {
            return true;
        }

        // Rate limiting is retryable
        if (error.response?.status === 429) {
            return true;
        }

        return false;
    }

    /**
     * Log a message with APIClient prefix
     * 
     * @param {string} message - Message to log
     * 
     * @private
     */
    function log(message) {
        if (CONFIG.ENABLE_LOGGING) {
            console.log(`${CONFIG.LOG_PREFIX} ${message}`);
        }
    }

    /**
     * Configure APIClient settings
     * 
     * @param {Object} options - Configuration options
     * @param {number} [options.timeout] - Default timeout
     * @param {number} [options.maxRetries] - Max retries
     * @param {boolean} [options.logging] - Enable logging
     * 
     * @example
     * APIClient.configure({ timeout: 20000, logging: false });
     */
    function configure(options = {}) {
        if ('timeout' in options) CONFIG.DEFAULT_TIMEOUT = options.timeout;
        if ('maxRetries' in options) CONFIG.MAX_RETRIES = options.maxRetries;
        if ('logging' in options) CONFIG.ENABLE_LOGGING = options.logging;
    }

    // Public API
    return {
        request,
        get,
        post,
        put,
        delete: deleteRequest,
        openWebSocket,
        configure
    };
})();

// Make available to other scripts
if (typeof window !== 'undefined') {
    window.APIClient = APIClient;
}
