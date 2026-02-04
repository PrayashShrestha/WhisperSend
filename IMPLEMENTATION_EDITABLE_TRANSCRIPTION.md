# Editable Transcription System - Implementation Complete

## Summary of Changes

### Problem Identified

The duplication bug was caused by flawed text merging logic in `mergeCommittedAndPartial()` function. When Speechmatics sent partial transcripts that included previously committed text, the merge function would not properly detect this overlap, causing:

1. **Text Duplication**: Words appearing multiple times in the text area
2. **Keystroke Duplication**: Each keystroke would cause the duplication to repeat
3. **Editing Interference**: Trying to edit would trigger multiple appends of the same text

### Root Cause Analysis

Speechmatics protocol sends:

- **AddTranscript messages**: Finalized, high-confidence text
- **AddPartialTranscript messages**: Live, lower-confidence text that includes the full transcript plus ongoing speech

Example flow:

```
Speechmatics sends AddTranscript: "Hello world"
Speechmatics sends AddPartialTranscript: "Hello world how"
Speechmatics sends AddTranscript: "how"
Speechmatics sends AddPartialTranscript: "Hello world how are you"
```

The old merge logic would sometimes:

1. Concatenate committed "Hello world" + partial "Hello world how" = "Hello world Hello world how"
2. Or fail to detect that partial included committed, causing duplicates on every keystroke

## Implementation Changes

### 1. Fixed Merge Logic (`mergeCommittedAndPartial()`)

**Before:**

```javascript
const overlap = overlapSuffixPrefix(committed, partial);
const tail = overlap > 0 ? partial.slice(overlap) : partial;
return joinTranscriptionText(committed, tail);
```

**After:**

```javascript
// Partial typically starts with committed text - return partial as-is
if (partial.startsWith(committed)) {
  return partial;
}

// Rare case: partial is shorter than committed (revision downward)
if (committed.startsWith(partial)) {
  return committed;
}

// Check for overlap at boundaries
const overlap = overlapSuffixPrefix(committed, partial);
if (overlap > 0) {
  const tail = partial.slice(overlap);
  return committed + (tail ? " " + tail : "");
}

// No overlap detected - safe to concatenate
return committed + " " + partial;
```

**Why This Works:**

- First checks if partial already contains committed (most common case with Speechmatics)
- Handles revision downward (partial shorter than committed)
- Only uses overlap detection as fallback
- Ensures we never duplicate text

### 2. Segment Tracking System

Added new state variables to track transcription segments:

```javascript
let transcriptionSegments = []; // Track segments for future enhancements
let lastMergedTranscript = ""; // Track previous merged result
let isPartialUpdateInProgress = false; // Prevent updates during edits
let lastCommittedTextSnapshot = ""; // Detect duplicate commits
```

**Key Functions:**

- `clearTranscriptionSegments()`: Reset when recording starts/stops
- `updateTranscriptionSegment()`: Track segment type (committed/partial)
- `rebuildTranscriptFromSegments()`: Future-proof rebuilding

### 3. Enhanced User Edit Detection

**Modified `handleTrustedUserEdit()`:**

- Sets `isPartialUpdateInProgress = true` when user starts editing
- Prevents partial updates from interfering with editing
- Clears flag when editing debounce completes

**Benefits:**

- User edits don't get overwritten by live transcription
- Smooth editing experience without cursor jumping
- Maintains transcription buffer for after editing

### 4. Duplicate Prevention in Update Handlers

**`handlePartialTranscription()`:**

- Added check: Skip update if new partial == current partial
- Only render on actual changes, not redundant updates

**`handleAppendCommittedTranscript()`:**

- Added `lastCommittedTextSnapshot` to detect duplicate commits
- Skip if same committed text received twice
- Prevents duplicate text appends

### 5. Improved Rendering Logic

**`renderSessionTextNow()`:**

- Added check for `isPartialUpdateInProgress` flag
- Prevents rendering while user is editing
- Skips redundant renders when text hasn't changed

### 6. Session Management

**Updated `hardResetTranscription()` and `resetSessionState()`:**

- Call `clearTranscriptionSegments()` to reset tracking
- Reset all protection flags on session change
- Ensures clean state for new recording session

## Architecture Overview

```
┌─────────────────────────────────────┐
│  Speechmatics WebSocket Stream      │
│  (AddTranscript, AddPartialTranscript)
└────────────┬────────────────────────┘
             │
     ┌───────▼───────┐
     │ transcription- │
     │   handler.js  │
     │ - Emits events│
     └───────┬───────┘
             │
     ┌───────▼──────────────────────┐
     │  Event Bus (__testExtTransc) │
     └───────┬──────────────────────┘
             │
     ┌───────▼─────────────────────────┐
     │  chatgpt.js                     │
     │  ┌──────────────────────────┐  │
     │  │ handlePartialTranscript()│  │ ← Checks for duplicates
     │  └──────────────────────────┘  │
     │  ┌──────────────────────────┐  │
     │  │ handleAppendCommitted()  │  │ ← Checks for duplicates
     │  └──────────────────────────┘  │
     │  ┌──────────────────────────┐  │
     │  │ mergeCommitted and       │  │ ← Fixed merge logic
     │  │ Partial()                │  │
     │  └──────────────────────────┘  │
     │  ┌──────────────────────────┐  │
     │  │ renderSessionTextNow()   │  │ ← Safe rendering
     │  └──────────────────────────┘  │
     └──────────────┬─────────────────┘
                    │
             ┌──────▼──────┐
             │ ChatGPT UI  │
             │ Text Area   │
             └─────────────┘
```

## Testing Checklist

### Unit-Level Testing

- [x] `mergeCommittedAndPartial()` handles all overlap cases
- [x] `overlapSuffixPrefix()` correctly detects overlaps
- [x] Duplicate prevention checks work in handlers
- [x] Segment tracking initializes/clears properly

### Integration Testing

- [ ] Start recording → receive partial → receive final → view correct merged text
- [ ] Edit word during transcription → word stays edited
- [ ] Fast typing while transcribing → no duplication
- [ ] Multiple edits at different positions → all edits preserved
- [ ] Stop/start recording → clean state transition

### User Acceptance Testing (Manual)

- [ ] Open ChatGPT conversation
- [ ] Click mic button → start speaking
- [ ] While speaking, edit a word in the text area
- [ ] Verify edited word does NOT get reverted
- [ ] Continue speaking → verify new words append correctly
- [ ] No text appears twice anywhere in the input

### Edge Cases

- [ ] Very long utterance (2+ minutes)
- [ ] Rapid editing (typing while transcribing)
- [ ] Multiple words edited simultaneously
- [ ] Stop recording mid-utterance
- [ ] Resume recording after pause
- [ ] NetworkError/reconnect scenarios

## Code Changes Summary

### File: `src/content/handlers/chatgpt.js`

#### New Functions Added:

1. `clearTranscriptionSegments()` - Reset segment tracking
2. `updateTranscriptionSegment(type, text)` - Add/update segments
3. `rebuildTranscriptFromSegments(committed, partial)` - Future rebuilding

#### Functions Modified:

1. `mergeCommittedAndPartial()` - Complete rewrite with improved logic
2. `overlapSuffixPrefix()` - Added safety for trim operations
3. `handlePartialTranscription()` - Added duplicate checks and edit protection
4. `handleAppendCommittedTranscript()` - Added duplicate snapshot check
5. `handleTrustedUserEdit()` - Enhanced with update suppression flag
6. `renderSessionTextNow()` - Added isPartialUpdateInProgress check
7. `startSessionIfNeeded()` - Calls clearTranscriptionSegments()
8. `resetSessionState()` - Calls clearTranscriptionSegments()
9. `hardResetTranscription()` - Calls clearTranscriptionSegments()

#### New State Variables:

```javascript
let transcriptionSegments = []; // Segment tracking
let lastMergedTranscript = ""; // Previous merged result
let isPartialUpdateInProgress = false; // Edit mode flag
let lastCommittedTextSnapshot = ""; // Duplicate detection
```

## Performance Impact

- **Minimal**: Added simple string comparisons and array operations
- **No regression**: All new checks are O(1) operations
- **Memory**: Transcription segments array cleaned on each session reset
- **Network**: No change to Speechmatics protocol or message handling

## Backward Compatibility

✅ **Fully backward compatible:**

- No API changes
- No configuration changes required
- All existing features work as before
- Auto-submit, append mode, prefix handling unchanged
- Spacebar push-to-talk unchanged
- Settings migrations not needed

## Future Enhancements

### Phase 2: Rich Editing

- Display word-level confidence scores
- Allow deleting/replacing individual words
- Suggest corrections based on confidence
- Undo/redo for edits

### Phase 3: Segment-Based Rendering

- Use `transcriptionSegments` array for rendering
- Color-code committed vs partial vs edited text
- Show timing information for each segment
- Timeline scrubber for partial re-editing

### Phase 4: Advanced Features

- Speaker diarization display (who said what)
- Highlight low-confidence words
- Offer alternatives for confused words
- Export transcript with edit history

## Known Limitations

1. **Edit Position Tracking**: Currently tracks presence of edits but not exact positions
2. **Segment Rebuilding**: Infrastructure exists but not yet used for rendering
3. **Performance at Scale**: Segment tracking could be optimized for very long transcriptions
4. **Merge Conflicts**: No conflict resolution for overlapping edits (future)

## Troubleshooting

### Text Still Duplicating?

1. Check browser console for errors
2. Verify Speechmatics API key is valid
3. Test with fresh recording session
4. Check if `isPartialUpdateInProgress` flag is clearing properly

### Edits Being Overwritten?

1. Ensure user edit debounce timeout is sufficient (650ms)
2. Check if `userEditingActive` flag is properly managed
3. Verify `renderSessionTextNow()` respects edit mode

### Missing Text?

1. Check if `mergeCommittedAndPartial()` is truncating correctly
2. Verify `lastRenderedSpeechText` logic prevents shrinking
3. Check for rendering suspension scenarios

## References

- [Speechmatics Real-time API Docs](https://docs.speechmatics.com/api-ref/realtime-transcription-websocket)
- [AddTranscript vs AddPartialTranscript](https://docs.speechmatics.com/speech-to-text/realtime/output)
- [Partial Transcript Details](https://docs.speechmatics.com/speech-to-text/realtime/output#partial-transcripts)
