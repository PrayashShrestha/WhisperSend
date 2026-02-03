/**
 * Notification System Module
 * Centralized notification and toast management
 * 
 * @module NotificationSystem
 * @description Handles all user notifications (toasts, alerts, status messages)
 *              with consistent styling and animations
 * 
 * Usage:
 * NotificationSystem.showSuccess("Text transcribed successfully");
 * NotificationSystem.showError("Connection failed");
 * NotificationSystem.showStatus("Connecting...", "connecting");
 */

const NotificationSystem = (() => {
    /**
     * Toast types with their configuration
     * @constant {Object} TOAST_TYPES
     */
    const TOAST_TYPES = {
        SUCCESS: {
            name: 'success',
            icon: '✓',
            color: '#4CAF50',
            bgGradient: 'linear-gradient(135deg, #4CAF50 0%, #45a049 100%)',
            borderColor: '#2e7d32',
            duration: 2500
        },
        ERROR: {
            name: 'error',
            icon: '⚠️',
            color: '#ff5252',
            bgGradient: 'linear-gradient(135deg, #ff5252 0%, #ff1744 100%)',
            borderColor: '#c62828',
            duration: 3000
        },
        INFO: {
            name: 'info',
            icon: 'ℹ️',
            color: '#2196F3',
            bgGradient: 'linear-gradient(135deg, #2196F3 0%, #1976D2 100%)',
            borderColor: '#0d47a1',
            duration: 2000
        }
    };

    /**
     * Status indicator types
     * @constant {Object} STATUS_TYPES
     */
    const STATUS_TYPES = {
        CONNECTING: {
            icon: '🔄',
            message: 'Connecting...',
            color: '#FFC107',
            duration: 1000
        },
        CONNECTED: {
            icon: '✓',
            message: 'Ready to record',
            color: '#4CAF50',
            duration: 1500
        },
        DISCONNECTED: {
            icon: '✗',
            message: 'Disconnected',
            color: '#ff5252',
            duration: 2000
        },
        ERROR: {
            icon: '⚠️',
            message: 'Connection error',
            color: '#ff1744',
            duration: 3000
        }
    };

    // Track active toasts to prevent stacking
    let activeToasts = [];
    const MAX_TOASTS = 3;

    /**
     * Create and display a toast notification
     * 
     * @param {string} message - Toast message
     * @param {string} type - Toast type (success, error, info)
     * @param {number} [duration] - Override default duration in ms
     * @returns {HTMLElement} The toast element
     * 
     * @example
     * NotificationSystem.showToast("Operation successful!", "success");
     * NotificationSystem.showToast("Error occurred", "error", 5000);
     */
    function showToast(message, type = 'info', duration) {
        // Get toast configuration
        const config = TOAST_TYPES[type.toUpperCase()] || TOAST_TYPES.INFO;
        const displayDuration = duration || config.duration;

        // Remove old toasts if at max
        if (activeToasts.length >= MAX_TOASTS) {
            removeToast(activeToasts[0]);
        }

        // Create toast element
        const toast = document.createElement('div');
        toast.className = `speechmatics-toast speechmatics-toast-${config.name}`;

        toast.style.cssText = `
            position: fixed;
            bottom: 24px;
            right: 20px;
            background: ${config.bgGradient};
            color: white;
            padding: 14px 18px;
            border-radius: 8px;
            z-index: 10002;
            font-size: 14px;
            font-weight: 500;
            max-width: 320px;
            word-wrap: break-word;
            box-shadow: 0 4px 12px rgba(${getRGBFromHex(config.color)}, 0.3), 
                        0 2px 4px rgba(0, 0, 0, 0.1);
            animation: slideInToast 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
            border-left: 4px solid ${config.borderColor};
            display: flex;
            align-items: center;
            gap: 10px;
        `;

        toast.innerHTML = `
            <span style="font-size: 18px; flex-shrink: 0;">${config.icon}</span>
            <span>${message}</span>
        `;

        // Add to DOM and track
        document.body.appendChild(toast);
        activeToasts.push(toast);

        // Auto-remove after duration
        setTimeout(() => {
            removeToast(toast, displayDuration);
        }, displayDuration);

        return toast;
    }

    /**
     * Remove a toast with animation
     * 
     * @param {HTMLElement} toast - The toast element
     * @param {number} [delay=0] - Delay before removal in ms
     * 
     * @private
     */
    function removeToast(toast, delay = 0) {
        if (!toast || !document.body.contains(toast)) {
            return;
        }

        setTimeout(() => {
            try {
                toast.style.animation = "slideOutToast 0.3s cubic-bezier(0.4, 0, 1, 1) forwards";
                setTimeout(() => {
                    if (document.body.contains(toast)) {
                        toast.remove();
                    }
                    // Remove from tracking
                    const index = activeToasts.indexOf(toast);
                    if (index > -1) {
                        activeToasts.splice(index, 1);
                    }
                }, 300);
            } catch (error) {
                console.error("[Notifications] Error removing toast:", error);
                if (document.body.contains(toast)) {
                    toast.remove();
                }
            }
        }, delay);
    }

    /**
     * Show a success toast
     * 
     * @param {string} message - Success message
     * @param {number} [duration] - Custom duration in ms
     * 
     * @example
     * NotificationSystem.showSuccess("Transcription completed!");
     */
    function showSuccess(message, duration) {
        return showToast(message, 'success', duration);
    }

    /**
     * Show an error toast
     * 
     * @param {string} message - Error message
     * @param {number} [duration] - Custom duration in ms
     * 
     * @example
     * NotificationSystem.showError("Failed to connect");
     */
    function showError(message, duration) {
        return showToast(message, 'error', duration);
    }

    /**
     * Show an info toast
     * 
     * @param {string} message - Info message
     * @param {number} [duration] - Custom duration in ms
     * 
     * @example
     * NotificationSystem.showInfo("Text was deleted");
     */
    function showInfo(message, duration) {
        return showToast(message, 'info', duration);
    }

    /**
     * Show a connection status indicator
     * Appears in top-right corner
     * 
     * @param {string} status - Status type
     *        (connecting, connected, disconnected, error)
     * 
     * @example
     * NotificationSystem.showStatus("connecting");
     * // Later
     * NotificationSystem.showStatus("connected");
     */
    function showStatus(status) {
        const statusLower = status.toLowerCase();
        const config = STATUS_TYPES[statusLower.toUpperCase()] || STATUS_TYPES.INFO;

        if (!config) {
            console.warn("[Notifications] Unknown status type:", status);
            return null;
        }

        // Create status toast
        const toast = document.createElement('div');
        toast.className = `speechmatics-status-toast speechmatics-status-${statusLower}`;

        toast.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: ${config.color};
            color: white;
            padding: 12px 16px;
            border-radius: 6px;
            z-index: 10001;
            font-size: 13px;
            font-weight: 500;
            box-shadow: 0 3px 8px rgba(0, 0, 0, 0.2);
            animation: slideInToast 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
            display: flex;
            align-items: center;
            gap: 8px;
        `;

        toast.innerHTML = `
            <span>${config.icon}</span>
            <span>${config.message}</span>
        `;

        // Add to DOM
        document.body.appendChild(toast);

        // Auto-remove after duration
        setTimeout(() => {
            removeToast(toast, config.duration);
        }, config.duration);

        return toast;
    }

    /**
     * Clear all active toasts
     * 
     * @example
     * NotificationSystem.clearAll();
     */
    function clearAll() {
        activeToasts.forEach(toast => {
            if (document.body.contains(toast)) {
                toast.remove();
            }
        });
        activeToasts = [];
    }

    /**
     * Convert hex color to RGB values
     * Used for CSS rgba calculations
     * 
     * @param {string} hex - Hex color code
     * @returns {string} RGB values (e.g., "255, 100, 50")
     * 
     * @private
     */
    function getRGBFromHex(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        if (result) {
            return [
                parseInt(result[1], 16),
                parseInt(result[2], 16),
                parseInt(result[3], 16)
            ].join(', ');
        }
        return '0, 0, 0';
    }

    /**
     * Ensure animations are loaded
     * Adds required CSS animations if not present
     * 
     * @private
     */
    function ensureAnimationsLoaded() {
        if (document.querySelector("#speechmatics-notifications-css")) {
            return; // Already loaded
        }

        const style = document.createElement('style');
        style.id = "speechmatics-notifications-css";
        style.textContent = `
            @keyframes slideInToast {
                from {
                    opacity: 0;
                    transform: translateY(20px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }

            @keyframes slideOutToast {
                from {
                    opacity: 1;
                    transform: translateY(0);
                }
                to {
                    opacity: 0;
                    transform: translateY(20px);
                }
            }
        `;
        document.head.appendChild(style);
    }

    // Initialize animations on load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', ensureAnimationsLoaded);
    } else {
        ensureAnimationsLoaded();
    }

    // Public API
    return {
        // Constants
        TOAST_TYPES,
        STATUS_TYPES,

        // Toast methods
        showToast,
        showSuccess,
        showError,
        showInfo,

        // Status methods
        showStatus,

        // Utility methods
        clearAll
    };
})();

// Make available to other scripts
if (typeof window !== 'undefined') {
    window.NotificationSystem = NotificationSystem;
}
