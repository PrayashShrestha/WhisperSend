# Editable Transcription System - Design & Implementation Plan

## Current Issue Analysis

### The Duplication Bug

When partial and final transcription results arrive, there's an overlap causing:

1. **Text Duplication**: When editing, the same text appears multiple times
2. **Duplication on Keystroke**: Each key press appends duplicated text multiple times
3. **Root Cause**: `mergeCommittedAndPartial()` function incorrectly handles the overlap between committed and partial text

### Current Flow

```
Speechmatics WebSocket
         ↓
   transcription-handler.js
   - AddPartialTranscript → currentPartial
   - AddTranscript → currentTranscript
         ↓
notifyPartialTranscription() / notifyCommittedTranscription()
         ↓
   chatgpt.js (via event bus)
   - handlePartialTranscription() → currentPartialText
   - handleAppendCommittedTranscript() → sessionCommittedText
         ↓
   renderSessionTextNow()
   - mergeCommittedAndPartial(sessionCommittedText, currentPartialText)
   - Problem: overlap detection is flawed
```

### Key Problems

1. **Overlap Detection is Flawed**
   - `overlapSuffixPrefix()` looks for suffix/prefix overlap
   - But Speechmatics partials often include full committed text as prefix
   - This causes incorrect merging

2. **Partial Text Includes Committed**
   - Speechmatics sends partials as complete phrase from start of utterance
   - Example:
     ```
     Final: "Hello world"
     Partial: "Hello world how" (includes the final)
     Partial: "Hello world how are" (includes previous)
     ```
   - Current code checks `partial.startsWith(committed)` but logic is incomplete

3. **User Edit Tracking**
   - No differentiation between transcribed and edited text
   - Edits trigger `userEditingActive` flag but don't create a persistent boundary
   - When rendering resumes, edited portions can be overwritten

4. **Missing Edit Persistence**
   - User edits a word → `sessionBaseText` is updated
   - But if transcription continues, new partials merge without respecting edit boundaries
   - No way to "lock" edited portions from being overwritten

## Proposed Solution

### Architecture

Create a three-layer text system:

```
┌─────────────────────────────────────────────────────┐
│ Layer 1: COMMITTED TEXT (locked, immutable)         │
│ - Finalized transcription from Speechmatics         │
│ - User edits to previous portions                   │
│ └─ sessionCommittedText + userEditedSegments       │
├─────────────────────────────────────────────────────┤
│ Layer 2: PARTIAL TEXT (live, replaceable)          │
│ - Current real-time hypothesis from Speechmatics   │
│ └─ currentPartialText (replaces entirely)          │
├─────────────────────────────────────────────────────┤
│ Layer 3: SESSION BASE (anchor)                      │
│ - Text that existed before transcription started   │
│ └─ sessionBaseText                                  │
└─────────────────────────────────────────────────────┘
```

### Key Changes

#### 1. Fix Partial/Final Merging

Replace `mergeCommittedAndPartial()` with smarter logic:

```javascript
function mergeCommittedAndPartial(committedText, partialText) {
  const committed = (committedText || "").trim();
  const partial = (partialText || "").trim();

  if (!committed) return partial;
  if (!partial) return committed;

  // Speechmatics partials typically include the full committed text
  // Check if partial starts with (or contains as prefix) the committed text
  if (partial.startsWith(committed)) {
    return partial; // Partial already includes committed
  }

  if (committed.startsWith(partial)) {
    return committed; // Partial is subset, keep committed
  }

  // No overlap detected - safely concatenate
  return committed + " " + partial;
}
```

#### 2. Implement Edit Boundaries

Track edited regions separately:

```javascript
// New state structure
let transcriptionSegments = [
  {
    id: 1,
    type: "transcribed", // or "edited"
    text: "Hello world",
    isEditable: true,
    isCommitted: true,
    startTime: 123.45, // Start time from Speechmatics
    endTime: 125.67, // End time from Speechmatics
  },
  {
    id: 2,
    type: "partial",
    text: "how are",
    isEditable: true,
    isCommitted: false,
  },
];
```

#### 3. Protect Committed Text During Edits

When user edits:

1. Mark edited region as "user_edited"
2. Lock that region from being replaced by new partials
3. Only allow new transcription to append after user edits

```javascript
function handleUserEditInRegion(startPos, endPos, newText) {
  // Find which segments are affected
  let editedSegments = transcriptionSegments.filter(
    (s) => s.charPos <= endPos && s.charPos + s.length >= startPos,
  );

  // Mark as edited (lock from transcription updates)
  editedSegments.forEach((s) => (s.type = "edited"));

  // Prevent future transcriptions from overwriting
  s.locked = true;
}
```

#### 4. Separate Rendering Logic

Keep three separate sections in final output:

```javascript
function renderSessionTextNow() {
  const promptEl = getPromptElement();
  if (!promptEl) return;

  const parts = [];

  // Session base (before recording)
  if (sessionBaseText) {
    parts.push(ensurePrefix(sessionBaseText));
  }

  // Committed transcription (finalized from Speechmatics)
  if (sessionCommittedText) {
    parts.push(sessionCommittedText);
  }

  // User edits to committed (locked sections)
  userEditedSegments.forEach((segment) => {
    parts.push(segment.editedText);
  });

  // Partial (live, changes as user speaks)
  if (currentPartialText && !userEditingActive) {
    parts.push(currentPartialText);
  }

  const next = parts.filter(Boolean).join(" ");
  setPromptText(promptEl, next);
}
```

#### 5. Enhanced User Edit Detection

```javascript
function handleTrustedUserEdit() {
  if (!isRecordingSession) return;

  cancelQueuedRender();
  userEditingActive = true;

  const promptEl = getPromptElement();
  const currentFullText = getPromptText(promptEl);

  // Detect what the user actually edited
  const expectedText = buildExpectedText(); // reconstructed from segments

  if (currentFullText !== expectedText) {
    // User made changes - mark the edited region
    captureEditedRegions(expectedText, currentFullText);
  }

  // ... rest of debounced edit handling
}

function captureEditedRegions(original, edited) {
  // Diff original vs edited to find changed portions
  // Mark those portions as "user_edited" (locked)
  // Store the edits for later reference
  userEditedSegments = diffAndSegment(original, edited);
}
```

## Benefits of This Design

1. ✅ **Prevents Duplication**: Each segment has a unique identity
2. ✅ **Allows Editing**: User can edit any portion without it being replaced
3. ✅ **Maintains Transcription Flow**: New partials don't overwrite edits
4. ✅ **Clear Boundaries**: Committed vs Partial vs Edited are distinct
5. ✅ **Editable While Transcribing**: Can edit committed text while partials update
6. ✅ **Respects Speechmatics Data**: Uses timing info to anchor segments

## Implementation Phases

### Phase 1: Fix Immediate Bug (Duplication)

- Fix `mergeCommittedAndPartial()` logic
- Prevent partial from being processed multiple times
- Add deduplication check in event handlers

### Phase 2: Implement Segment Tracking

- Add `transcriptionSegments` array
- Track timing info from Speechmatics metadata
- Map segments to character positions

### Phase 3: Protect Edited Portions

- Detect and lock edited regions
- Prevent new transcription from replacing locked text
- Store edit history

### Phase 4: Enhanced Rendering

- Reconstruct text from segments instead of simple concatenation
- Ensure edited portions are never overwritten
- Handle insertion points correctly

## Testing Strategy

### Test Cases

1. **Partial Override Test**: Final text arrives after partial, partial should be replaced
2. **Edit During Transcription**: Edit word → continue speaking → word stays edited
3. **Duplicate Test**: Ensure no text appears twice
4. **Long Transcription**: 30-second speech with multiple edits at different points
5. **Rapid Editing**: Fast edits + continuous partial updates
6. **Session Boundaries**: Stop/start recording maintains edit state

### Manual Testing Checklist

- [ ] Start transcription → edit word → continue → word stays edited
- [ ] Verify no text duplication on any keystroke
- [ ] Test with ChatGPT text field
- [ ] Test with long utterances (60+ words)
- [ ] Verify partial preview updates don't erase user edits
- [ ] Check that old transcriptions can be edited without creating duplicates

## Code Files to Modify

1. **src/content/handlers/chatgpt.js**
   - `mergeCommittedAndPartial()` - Fix merge logic
   - `renderSessionTextNow()` - Implement segment-based rendering
   - `handleTrustedUserEdit()` - Enhance edit detection
   - Add segment tracking state

2. **src/content/handlers/transcription-handler.js**
   - No major changes needed
   - Already properly separates partial vs committed
   - Will work correctly with fixed merge logic

## Backward Compatibility

- All changes are internal to rendering logic
- No API changes to other modules
- Settings and preferences remain unchanged
- Existing features (auto-submit, append mode, etc.) continue to work
