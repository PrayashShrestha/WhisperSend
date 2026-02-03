# Quick Start Guide - Speechmatics Transcription Extension

## Installation & Setup (2 minutes)

### 1. Get Your API Key

- Visit: https://portal.speechmatics.com/settings/api-keys
- Create new API key (or use existing)
- Copy the key

### 2. Load Extension in Chrome

```bash
# In Chrome:
1. Go to: chrome://extensions/
2. Enable "Developer mode" (top-right)
3. Click "Load unpacked"
4. Select: /Users/prayashshrestha/Documents/personal/projects/test-ext
```

### 3. Configure Extension

```
1. Click extension icon (top-right of Chrome)
2. Paste your API key in the "Speechmatics API Key" field
3. Click "Save Key"
4. Should show: "API key configured ✓"
```

---

## Using the Extension (1 minute)

### Recording Speech

```
1. Open ChatGPT (https://chatgpt.com)
2. Click in the text input area
3. HOLD SPACEBAR → Mic turns RED 🔴
4. Speak clearly (any language)
5. RELEASE SPACEBAR → Text appears in input
```

### Text Management

```
DELETE: Press ESCAPE to remove last transcribed text
SEND:   Press ENTER or click Send button (auto-optional)
EDIT:   Make changes to text before sending
```

---

## Configuration Options

### Transcription Mode

- **Timer Mode** (default): Auto-submit 2 seconds after you stop talking
- **Manual Mode**: You decide when to submit (press spacebar release)

### Change Timer Delay

- Go to popup settings
- Adjust "Delay after last speech" (0.5 - 10 seconds)
- Default: 2 seconds

### Auto-Enter

- Enable: Extension auto-presses Enter after text insertion
- Disable: You press Enter manually

### Append Mode

- Enable: Add transcription to existing text
- Disable: Replace all text with transcription

---

## Keyboard Shortcuts

| Key                    | Action                                    |
| ---------------------- | ----------------------------------------- |
| **SPACEBAR (hold)**    | Start recording                           |
| **SPACEBAR (release)** | Stop recording, submit text               |
| **ESCAPE**             | Delete last transcribed text              |
| **ENTER**              | Send message (manual or after auto-entry) |

---

## Troubleshooting

### "No API key configured"

- Go to extension popup
- Paste your API key
- Click "Save Key"
- Reload ChatGPT tab

### "Microphone access denied"

- Check Chrome permissions: Settings → Privacy → Microphone
- Allow chrome://extensions to access microphone
- Reload ChatGPT tab

### "Failed to connect to transcription service"

- Check internet connection
- Verify API key is valid
- Try again after 5 seconds

### Text not appearing in ChatGPT

- Make sure ChatGPT text input has focus
- Try clicking in the text area first
- Check browser console for errors (popup → Debug logging)

### Mic indicator not showing

- Make sure ChatGPT tab is active
- Reload the tab
- Check if extension is enabled

---

## Settings Explained

### API Key Field

- **What**: Your Speechmatics authentication
- **Where to get**: https://portal.speechmatics.com/settings/api-keys
- **Security**: Encrypted by Chrome, stored locally
- **Show/Hide**: Toggle visibility with "Show" button

### Transcription Mode

- **Timer**: Automatically submit after silence (good for continuous transcription)
- **Manual**: Submit when you release spacebar (more control)

### Auto-Submit Delay

- **Range**: 0.5 to 10 seconds
- **What it does**: Waits this long after last detected speech before auto-submitting
- **Default**: 2 seconds

### Append to Prompt

- **Enabled**: Add transcribed text to existing text
- **Disabled**: Replace all text with transcribed text

### Auto-press Enter

- **Enabled**: Extension sends message automatically
- **Disabled**: You manually click Send button

### Debug Logging

- **Enabled**: Show detailed logs in browser console
- **Disabled**: Less console noise
- **Use**: For troubleshooting issues

---

## Features Summary

✅ **Real-time Transcription**

- Live text as you speak
- Fast response (< 500ms)

✅ **Easy Control**

- Spacebar to record
- Escape to delete
- Auto or manual submit

✅ **Flexible Modes**

- Timer-based auto-submit
- Manual submission
- Configurable delays

✅ **Visual Feedback**

- Red mic indicator while recording
- Success/error notifications
- Clean, non-intrusive UI

✅ **Text Management**

- Edit transcribed text
- Append or replace mode
- Works with all ChatGPT features

---

## Common Workflows

### Workflow 1: Quick Questions

```
1. Hold Spacebar
2. Ask a question
3. Release Spacebar → Auto-submits
4. Read ChatGPT response
```

### Workflow 2: Careful Transcription

1. Hold Spacebar, speak
2. Release Spacebar
3. Review text (it appears in textarea)
4. Edit if needed
5. Press ENTER to send

### Workflow 3: Mistake Correction

1. Hold Spacebar, speak something wrong
2. Release Spacebar
3. Press ESCAPE to delete
4. Hold Spacebar again, re-record
5. Release and submit

---

## Tips & Tricks

### For Best Transcription

- Speak clearly and at normal pace
- Reduce background noise
- Use headphones to minimize echo
- Test with simple sentences first

### For Faster Workflow

- Set Timer Mode to 1-1.5 seconds (less waiting)
- Enable Auto-press Enter (no manual clicking)
- Keep hands on keyboard for quick edits

### For More Control

- Use Manual Mode (you control when to submit)
- Disable Auto-press Enter (review before sending)
- Append Mode enabled (easier to fix mistakes)

---

## Support

### Getting Help

1. Check browser console: Press F12 → Console tab
2. Enable "Debug logging" in extension
3. Try recording a simple phrase
4. Look for error messages

### Report Issues

- Check IMPLEMENTATION.md for detailed technical info
- Verify API key is valid at https://portal.speechmatics.com
- Make sure microphone permission is granted
- Reload ChatGPT tab and try again

### Feature Requests

- Currently supports English (can add more languages)
- Can add auto-punctuation (coming soon)
- Can add multiple language support (in progress)

---

## FAQ

**Q: Will my voice be recorded?**
A: Audio is sent only to Speechmatics servers during recording. Not stored on your device.

**Q: Is my API key secure?**
A: Yes, stored encrypted by Chrome. Only transmitted over HTTPS/WSS.

**Q: Can I use this offline?**
A: No, requires internet connection to Speechmatics servers.

**Q: Does it work in other chat apps?**
A: Currently optimized for ChatGPT only. Can be adapted for other text areas.

**Q: Can I record multiple languages?**
A: Yes, Speechmatics supports 60+ languages. Currently set to English, but can be changed.

**Q: What languages are supported?**
A: All languages supported by Speechmatics (see their documentation).

---

**Version**: 1.0
**Last Updated**: February 1, 2026
**Status**: Production Ready
