# Mic Toggle Button - Quick Start Guide

## What's New? 🎤

The extension now includes an **inline mic toggle button** positioned directly above the ChatGPT text area for easier control.

---

## How to Use

### 1. **Locate the Button**

Look for the **🎤 mic icon** positioned just above the ChatGPT text area (bottom-right of input)

```
[Your text input area                    🎤 ]
```

### 2. **Enable Recording**

Click the 🎤 button once:

- Button changes to 🔴 (red circle)
- Button glows red with pulsing effect
- Mic is now **actively recording**

### 3. **Speak Your Message**

Simply speak while the mic is enabled (🔴):

```
User speaks: "What is the capital of France?"
         ↓
Real-time transcription shows in text area
         ↓
Speechmatics API processes audio in real-time
```

### 4. **Auto-Submit (Optional)**

When you stop speaking:

- Silence detected → Text auto-submitted to ChatGPT
- Message appears in conversation
- ChatGPT generates response

### 5. **Disable Recording**

Click the button again to disable:

- Button returns to 🎤 (gray)
- Mic stops recording
- No more audio is captured

---

## Control Options

### Option A: **Click Toggle** (New - Recommended)

```
✓ Click mic button to start
✓ Keeps recording as you speak
✓ Click again to stop
✓ Best for: Hands-on control, visible feedback
```

### Option B: **Spacebar** (Still Available)

```
✓ Hold spacebar = recording
✓ Release spacebar = stop & submit
✓ Best for: Power users, hands-free feel
```

### Both work together! ✨

You can use button OR spacebar interchangeably.

---

## Visual States

| State        | Icon             | Meaning                         | What to Do             |
| ------------ | ---------------- | ------------------------------- | ---------------------- |
| **Inactive** | 🎤               | Mic disabled, not recording     | Click to start         |
| **Active**   | 🔴               | Mic enabled, actively recording | Speak or click to stop |
| **Hover**    | 🎤 (highlighted) | Mouse over button               | Ready to click         |

---

## Tips & Tricks

### ✅ Do's

- ✓ Click once to start, once to stop
- ✓ Pause between sentences for clarity
- ✓ Speak clearly and at normal pace
- ✓ Let silence finish before clicking
- ✓ Check transcription before auto-submit

### ❌ Don'ts

- ✗ Don't rapidly click on/off
- ✗ Don't speak while button is 🎤 (inactive)
- ✗ Don't background noise while recording
- ✗ Don't forget to disable mic when done

---

## Troubleshooting

### Button doesn't appear

**Solution:** Refresh ChatGPT tab and wait 1-2 seconds for button to load

### Mic not recording

**Problem:** Button is still 🎤 (gray)
**Solution:** Click button once to enable (turns 🔴)

### Text not appearing

**Problem:** No text shows after speaking
**Solutions:**

1. Check if API key is set in popup
2. Verify microphone permission in browser
3. Check browser console (F12) for errors
4. Try spacebar instead (if keyboard works, button control might be issue)

### Transcription is wrong

**Solution:**

- Speak more clearly and at normal pace
- Reduce background noise
- Use shorter phrases/sentences
- Check Speechmatics API status

---

## Settings (Optional)

Access extension settings via popup icon in toolbar:

### Auto-Submit Settings

```
✓ Auto-submit on silence: ON (recommended)
✓ Auto-submit delay: 500ms (fast)
✓ Auto-enter after submit: ON (optional)
```

### Text Settings

```
✓ Append mode: ON (add to existing text)
✓ Separator: Newline
```

### Advanced

```
✓ API Key: [set in popup]
✓ Debug logging: OFF (for troubleshooting)
```

---

## Keyboard Shortcuts

| Key          | Action                          |
| ------------ | ------------------------------- |
| **Spacebar** | Hold = record, Release = submit |
| **Escape**   | Delete last transcribed text    |
| (Click mic)  | Toggle recording on/off         |

---

## Typical Workflow

```
1. Go to ChatGPT chat window
2. See 🎤 button above text area
3. Click button (turns 🔴)
4. Speak: "Write me a Python function that..."
5. See text appear in input box
6. Wait for silence (auto-submit)
7. ChatGPT generates response
8. Repeat! (mic still active for next message)
```

---

## Workflow: Silent/Private Mode

If in public and can't speak aloud:

```
1. Use the popup to set API Key
2. Type manually (button for show)
3. Or use Spacebar:
   - Blur and hold spacebar
   - Record in quiet environment
   - Release when done
```

---

## Performance Notes

- ⚡ First transcription: ~500ms
- ⚡ Subsequent transcriptions: ~100-300ms (API reuse)
- ⚡ Auto-submit: Immediate (no delay)
- ⚡ Total time from speaking to ChatGPT responding: 1-2 seconds

---

## FAQ

**Q: Can I use this without speaking?**
A: Yes! Just type normally. The extension doesn't interfere with typing.

**Q: Does it work offline?**
A: No, it requires internet connection to Speechmatics API.

**Q: Is my audio sent to Speechmatics?**
A: Yes, audio is sent for transcription. Review their privacy policy.

**Q: Can I use both button and spacebar?**
A: Yes! They work independently. Use whichever feels natural.

**Q: What if I'm typing in the middle of recording?**
A: Stop recording first (click button) then type.

**Q: Can I delete the last transcription?**
A: Yes! Press Escape key to delete last transcribed text.

---

## Next Steps

1. **Set up API Key** if not already done:
   - Open popup (toolbar icon)
   - Paste Speechmatics API key
   - Save settings

2. **Try it out:**
   - Click mic button 🎤
   - Speak clearly
   - Watch transcription appear
   - Let it auto-submit

3. **Adjust settings:**
   - Enable/disable auto-submit
   - Change text separator
   - Enable debug logging if needed

---

## Need Help?

### Check Browser Console (F12)

If something's wrong, open DevTools:

```
F12 → Console tab → Look for error messages
```

### Enable Debug Logging

In popup settings:

```
✓ Enable debug logging
→ Console will show detailed info
→ Helps diagnose issues
```

### Common Error Messages

| Error                          | Fix                         |
| ------------------------------ | --------------------------- |
| "API key not set"              | Set API key in popup        |
| "Microphone permission denied" | Allow microphone in browser |
| "WebSocket connection failed"  | Check internet, try refresh |
| "No audio detected"            | Ensure mic volume is up     |

---

## Happy transcribing! 🎙️

**Pro Tip:** Combine with ChatGPT Plus for fastest response times. Speechmatics + ChatGPT = Ultimate productivity boost! 🚀
