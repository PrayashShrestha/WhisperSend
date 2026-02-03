# Visual Guide - Mic Toggle Button Placement

## UI Layout

### Complete View

```
╔════════════════════════════════════════════════════════════════╗
║                      ChatGPT Chat Window                       ║
║                                                                ║
║  ┌────────────────────────────────────────────────────────┐   ║
║  │  Assistant: Hello! How can I help you today?          │   ║
║  └────────────────────────────────────────────────────────┘   ║
║                                                                ║
║  ┌────────────────────────────────────────────────────────┐   ║
║  │  User: Tell me about Python                           │   ║
║  └────────────────────────────────────────────────────────┘   ║
║                                                                ║
║  ┌────────────────────────────────────────────────────────┐   ║
║  │  ┌──────────────────────────────────────────────────┐ │   ║
║  │  │                                                  │ │   ║
║  │  │  Type or speak here... [Your message text]      │ │   ║
║  │  │                                      🎤         │ │   ║
║  │  │                                    ↑            │ │   ║
║  │  │                            Mic Toggle Button    │ │   ║
║  │  │                            (36x36 pixels)       │ │   ║
║  │  │                                                 │ │   ║
║  │  └─────────────────────────────────────────────────┘ │   ║
║  │              [Send Message]                 🎤💬    │   ║
║  └────────────────────────────────────────────────────────┘   ║
║                                    ▲                           ║
║                          Corner indicator                      ║
║                          (floating, separate)                  ║
╚════════════════════════════════════════════════════════════════╝
```

---

## Button States

### State 1: Inactive (Ready to Record)

```
┌─────────────────────────────────────┐
│  Text input area                    │
│                              ┌───┐  │
│                              │ 🎤 │  │
│                              └───┘  │
│                            Gray     │
│                          #f0f0f0    │
│                                    │
└─────────────────────────────────────┘

Properties:
- Icon: 🎤 (gray microphone)
- Background: #f0f0f0 (light gray)
- Border: 1px solid #999 (medium gray)
- Shadow: 0 2px 4px rgba(0,0,0,0.1) (subtle)
- Size: 36x36px
- State: Click to start recording
```

### State 2: Active (Recording)

```
┌─────────────────────────────────────┐
│  Text input area                    │
│                              ┌───┐  │
│                              │🔴 │  │
│                              └───┘  │
│                          Red glow   │
│                          #ff4444    │
│                          Pulsing    │
│                                    │
└─────────────────────────────────────┘

Properties:
- Icon: 🔴 (red circle)
- Background: #ff4444 (bright red)
- Border: 1px solid #cc0000 (dark red)
- Shadow: 0 0 12px rgba(255,68,68,0.6) (red glow)
- Animation: Subtle pulsing effect
- Size: 36x36px
- State: Recording active - click to stop
```

### State 3: Hover/Focus

```
┌─────────────────────────────────────┐
│  Text input area                    │
│                              ┌───┐  │
│                              │ 🎤 │  │
│                              └───┘  │
│                          Darker     │
│                          #e0e0e0    │
│                          Elevated   │
│                                    │
└─────────────────────────────────────┘

Properties:
- Background: #e0e0e0 (darker gray)
- Shadow: 0 4px 8px rgba(0,0,0,0.15) (elevated effect)
- Transition: 0.2s ease
- Cursor: pointer
```

---

## Position Details

### Relative to Text Input Container

```
┌──────────────────────────────────────────────────┐
│  #prompt-textarea (ChatGPT input container)      │
│                                                  │
│  ┌────────────────────────────────────────┐    │
│  │                                        │    │
│  │  Text input area                       │ 🎤  │
│  │  (textarea or contenteditable div)     │    │
│  │                                        │    │
│  └────────────────────────────────────────┘    │
│                              ↑                  │
│                   Button positioned here        │
│                   bottom: 12px                  │
│                   right: 48px                   │
│                   (relative to container)       │
│                                                │
└──────────────────────────────────────────────────┘
```

### CSS Positioning

```css
#speechmatics-mic-toggle {
  position: absolute; /* Relative to #prompt-textarea */
  bottom: 12px; /* 12px from bottom of container */
  right: 48px; /* 48px from right edge */
  width: 36px; /* Small, compact size */
  height: 36px; /* Square = circle with radius */
  border-radius: 50%; /* Makes square into circle */
  z-index: 1000; /* Above text input */
}
```

---

## Interaction Flow (Visual)

### Scenario: User Records a Message

```
1. PAGE LOADS
   ┌─────────┐
   │  🎤     │  Inactive (gray)
   └─────────┘

            ↓ User clicks button

2. RECORDING STARTS
   ┌─────────┐
   │  🔴     │  Active (red, glowing)
   └─────────┘
   🎙️ Mic listening...

            ↓ User speaks: "What is AI?"

3. TRANSCRIPTION SHOWN
   ┌─────────────────────────────────┐
   │ What is AI?                 🔴   │
   └─────────────────────────────────┘
   (Text appears in textarea)

            ↓ User stops speaking (silence detected)

4. AUTO-SUBMIT
   ┌──────────────────────────────────┐
   │ Message sent to ChatGPT      ✓   │
   │ (may auto-press Enter)           │
   └──────────────────────────────────┘

            ↓ ChatGPT generates response

5. CONVERSATION CONTINUES
   ┌─────────────────────────────────┐
   │ Chat History                    │
   │ User: What is AI?              │
   │ Assistant: AI is...            │
   │ [Ready for next message]   🎤   │
   └─────────────────────────────────┘
   (Button still active, ready for next)

            ↓ User clicks again to disable

6. RECORDING DISABLED
   ┌─────────┐
   │  🎤     │  Inactive (gray)
   └─────────┘
```

---

## Keyboard Alternative (Spacebar)

The button **complements** the spacebar control:

```
METHOD 1: Click Toggle (New)
┌──────────────────────────────────────┐
│ Click: 🎤 → 🔴 (start)              │
│ Click: 🔴 → 🎤 (stop)               │
│ Visual feedback while active         │
└──────────────────────────────────────┘

METHOD 2: Spacebar (Existing)
┌──────────────────────────────────────┐
│ Hold spacebar: Start recording       │
│ Release spacebar: Stop recording     │
│ No visual feedback needed (hand busy) │
└──────────────────────────────────────┘

BOTH WORK SIMULTANEOUSLY ✨
```

---

## Mobile/Responsive Behavior

### On Desktop (Primary)

```
┌──────────────────────────────────┐
│  Input area              [🎤]    │  Button visible, positioned
└──────────────────────────────────┘  to the right
```

### On Small Tablet

```
┌────────────────────────────┐
│  Input area         [🎤]   │  Button still visible
└────────────────────────────┘  (space permitting)
```

### On Mobile (if applicable)

```
┌──────────────────────────────┐
│  Input area        [🎤]     │  Button smaller or repositioned
└──────────────────────────────┘  (device-specific layout)
```

---

## Comparison: Before & After

### BEFORE (Original Design)

```
┌──────────────────────────────────────┐
│  Input area                          │
│                                      │
│  "User must know about spacebar..."  │
└──────────────────────────────────────┘

              Floating indicator
              in corner (🎤 or 🔴)

Hidden feature → Low discoverability
```

### AFTER (With Toggle Button)

```
┌──────────────────────────────────────┐
│  Input area                       🎤  │ ← Obvious control!
│                                      │
│  "Clear visual feedback"             │
└──────────────────────────────────────┘

              Floating indicator
              in corner (also updated)

Visible feature → High discoverability ✨
```

---

## Animation Details

### Hover Animation Sequence

```
Time: 0ms        200ms        250ms
State: Idle  →  Hover  →  Idle

Color:   #f0f0f0  #e0e0e0  #f0f0f0
Shadow:  subtle   elevated  subtle
Scale:   normal   (no scale, just shadow)
```

### Recording Pulsing (Optional Future Enhancement)

```
Time:   0ms    750ms   1500ms
Glow:   max → min → max (repeating)
Color:  #ff4444 with variable opacity
Shadow: 0 0 0px → 0 0 10px → 0 0 0px
```

---

## Z-Index Layering

```
Layer 5:  Tooltips/Notifications
          z-index: 9999+

Layer 4:  Floating indicator
          z-index: 10000

Layer 3:  Toggle button (focus)
          z-index: 1000

Layer 2:  Text input area
          z-index: default

Layer 1:  Chat background
          z-index: 0
```

---

## Styling Code Reference

### Complete Button Styling

```javascript
button.style.cssText = `
    position: absolute;              /* Above textarea, not floating */
    bottom: 12px;                    /* Distance from bottom */
    right: 48px;                     /* Distance from right */
    width: 36px;                     /* Small, compact */
    height: 36px;
    border-radius: 50%;              /* Circle shape */
    background: #f0f0f0;             /* Light gray inactive */
    border: 1px solid #999;          /* Medium gray border */
    cursor: pointer;                 /* Pointer on hover */
    display: flex;                   /* Center content */
    align-items: center;
    justify-content: center;
    font-size: 18px;                 /* Icon size */
    z-index: 1000;                   /* Above input */
    transition: all 0.2s ease;       /* Smooth animations */
    padding: 0;                      /* No padding */
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
`;
```

---

## Accessibility Features

### Focus Indicator

```
When tabbed to (keyboard navigation):
┌─────────────┐
│  🎤         │  ← Shows focus outline
└─────────────┘    (browser default or custom)
```

### Screen Reader Support

```
Aria attributes (future enhancement):
- aria-label: "Microphone toggle button"
- aria-pressed: "false" (when inactive)
- aria-pressed: "true" (when active)
- aria-describedby: "tooltip"
```

### Color Contrast

```
Inactive: #f0f0f0 background, #999 border (AA compliant)
Active:   #ff4444 background, #cc0000 border (AAA compliant)
Hover:    #e0e0e0 background (AA+ compliant)
```

---

## Real-World Screenshots (Text Representation)

### Example 1: Default ChatGPT Interface with Button

```
┌────────────────────────────────────────────────────┐
│  Chat History                                       │
│  ........................................           │
│                                                     │
│  User: Hello                                       │
│  Assistant: Hi! How can I help?                   │
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │  Message input area                      🎤   │  │
│  │                                              │  │
│  │  "Type something or click mic to speak"     │  │
│  │                                              │  │
│  └──────────────────────────────────────────────┘  │
│                            [Send]                   │
└────────────────────────────────────────────────────┘

Button position: Bottom-right of input container
Clearly visible above Send button area
```

### Example 2: While Recording

```
┌────────────────────────────────────────────────────┐
│  Chat History                                       │
│  ........................................           │
│                                                     │
│  ┌──────────────────────────────────────────────┐  │
│  │  Tell me about Python                    🔴  │  │
│  │                                          ← │  │
│  │  (live transcription as user speaks)       │  │
│  │                                              │  │
│  └──────────────────────────────────────────────┘  │
│                            [Send]                   │
└────────────────────────────────────────────────────┘

Button: Red with glow, indicating active recording
Text updates in real-time as user speaks
```

---

## Size Reference

```
Button dimensions:
┌──────┐
│  🎤   │  36px × 36px (compact, not intrusive)
│      │
└──────┘

Icon size: 18px (readable, not huge)

Positioning:
12px from container bottom
48px from container right edge

This ensures:
✓ Visible but not blocking text input
✓ Easy to click with mouse/touchscreen
✓ Doesn't cover Send button
✓ Clearly associated with text area
```

---

## Summary

**Button Position:** Inline with ChatGPT input (not floating)
**Button State:** 🎤 inactive, 🔴 active with glow
**Interactions:** Click to toggle, hover for feedback
**Keyboard Alternative:** Spacebar still works
**Visual Design:** Professional, polished, accessible
**Mobile Ready:** Responsive positioning
**Fully Functional:** Controls actual recording via `toggleRecording()`

---

This visual guide helps users understand exactly where the mic button is, how to use it, and what to expect at each state.
