# Manifest Integration Guide

## 📝 How to Update manifest.json

Your extension needs to load the new utility modules in the correct order.

### Current manifest.json Status

Check your `manifest.json` file in the root directory.

### Required Update

Find the `content_scripts` section and update it:

```json
{
    "manifest_version": 3,
    "name": "Speechmatics for ChatGPT",
    "version": "1.0.0",

    ...other config...

    "content_scripts": [
        {
            "matches": ["*://*.chatgpt.com/*"],
            "js": [
                "src/content/event-emitter.js",           // 1st - Foundation
                "src/content/notification-system.js",     // 2nd - Uses DOM
                "src/content/api-client.js",              // 3rd - Standalone
                "src/content/state-manager.js",           // 4th - Standalone
                "src/content/dom-utils.js",               // 5th - Utilities
                "src/content/settings-manager.js",        // 6th - Settings
                "src/content/transcription-handler.js",   // 7th - Uses above
                "src/content/inject-ui.js",               // 8th - UI
                "src/content/speechmatics.js",            // 9th - Main
                "src/content/chatgpt.js"                  // 10th - ChatGPT specific
            ],
            "css": [
                "src/content/styles.css"                  // If needed
            ]
        }
    ]
}
```

## ⚠️ Important: Script Load Order

**The order matters!** Load in this sequence:

1. **event-emitter.js** ← No dependencies
2. **notification-system.js** ← Uses EventEmitter
3. **api-client.js** ← No module dependencies
4. **state-manager.js** ← No module dependencies
5. **dom-utils.js** ← Utility functions
6. **settings-manager.js** ← Uses StateManager
7. **transcription-handler.js** ← Uses APIClient, Notifications
8. **inject-ui.js** ← Uses Notifications, DOM utils
9. **speechmatics.js** ← Main handler (uses all)
10. **chatgpt.js** ← ChatGPT specific code

## ✅ Verification Steps

After updating manifest.json:

1. **Open DevTools Console** (F12)
2. Go to **Application** tab
3. Find your extension in left sidebar
4. Check **Service Worker** section
5. Look for any errors about missing scripts

### Manual Test in Console

Type these in DevTools console and confirm each works:

```javascript
// 1. Check EventEmitter loaded
typeof EventEmitter; // Should be 'function'

// 2. Check NotificationSystem loaded
NotificationSystem.showSuccess("Test!"); // Should show green toast

// 3. Check APIClient loaded
typeof APIClient; // Should be 'object'

// 4. Check StateManager loaded
typeof StateManager; // Should be 'function'
```

If all return correctly, your scripts are loaded in right order!

## 🔍 Troubleshooting

### Problem: "EventEmitter is not defined"

**Solution**: Check manifest.json - event-emitter.js might not be loaded

```json
"js": [
    "src/content/event-emitter.js",  // ← Add this first
    ...
]
```

### Problem: Notification doesn't appear

**Solution**: NotificationSystem CSS might not be loaded. Check:

1. Is notification-system.js loaded? ✓
2. Is it after event-emitter.js? ✓
3. Try in console: `NotificationSystem.showSuccess("Test")`

### Problem: "Cannot read property of undefined"

**Solution**: Scripts in wrong order. Double-check load order above.

### Problem: Extension doesn't activate

**Solution**:

1. Save manifest.json
2. Go to `chrome://extensions/`
3. Toggle extension OFF then ON
4. Refresh the page

## 📋 Complete Example manifest.json

Here's a complete working example:

```json
{
  "manifest_version": 3,
  "name": "Speechmatics for ChatGPT",
  "version": "1.0",
  "description": "Add speech-to-text to ChatGPT",

  "permissions": ["activeTab", "scripting"],

  "host_permissions": ["*://*.chatgpt.com/*", "*://api.example.com/*"],

  "background": {
    "service_worker": "src/background.js"
  },

  "action": {
    "default_popup": "src/popup/popup.html",
    "default_title": "Speechmatics for ChatGPT"
  },

  "content_scripts": [
    {
      "matches": ["*://*.chatgpt.com/*"],
      "js": [
        "src/content/event-emitter.js",
        "src/content/notification-system.js",
        "src/content/api-client.js",
        "src/content/state-manager.js",
        "src/content/dom-utils.js",
        "src/content/settings-manager.js",
        "src/content/transcription-handler.js",
        "src/content/inject-ui.js",
        "src/content/speechmatics.js",
        "src/content/chatgpt.js"
      ]
    }
  ]
}
```

## 🚀 Quick Checklist

- [ ] Open `manifest.json`
- [ ] Find `content_scripts` section
- [ ] Update `js` array with modules in correct order
- [ ] Save the file
- [ ] Go to `chrome://extensions/`
- [ ] Click reload button on your extension
- [ ] Open ChatGPT
- [ ] Open DevTools (F12)
- [ ] In console, test: `NotificationSystem.showSuccess("Working!")`
- [ ] ✅ You're done!

## 📞 Questions?

See documentation files:

- **UTILITIES_QUICK_REFERENCE.md** - Quick examples
- **REFACTORING_GUIDE.md** - Detailed guide
- **CODE_QUALITY_SUMMARY.md** - Overview

---

**Next Step**: Once manifest is updated, try the examples in UTILITIES_QUICK_REFERENCE.md!
