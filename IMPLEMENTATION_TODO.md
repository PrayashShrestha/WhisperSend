# Implementation TODO - whisperSend

**Last updated**: February 4, 2026

This file consolidates all known issues and future enhancements into a single execution checklist. It references existing documentation where the detailed root cause analysis and copy-paste code are already provided.

**Primary references**
- `COMPLETE_ISSUE_INVENTORY.md` (line numbers, root cause, fix snippets)
- `COMPREHENSIVE_IMPROVEMENT_PLAN.md` (deep dives and expanded fixes)
- `CODE_ANALYSIS_AND_ENHANCEMENT_ROADMAP.md` (opportunity areas)
- `EXECUTIVE_SUMMARY.md` (business impact, risk, timeline, success criteria)

---

## Global Success Criteria

- Merge latency < 1ms (common case)
- Render latency < 2ms
- 55-60fps during active transcription
- Zero text duplication across partial + committed updates
- No data loss while editing mid-transcription
- Automatic recovery from transient network disconnects
- Visible feedback for connection and recording state

---

## Critical Path (48 hours)

1. [ ] P1.1 Fix merge algorithm O(n²) to O(n), add fast overlap detection. `src/content/handlers/chatgpt.js` lines ~572-630
2. [ ] P1.3 Cache prompt element to reduce DOM queries. `src/content/handlers/chatgpt.js` line ~653
3. [ ] E2.1 Replace edit-blocking with buffered merge. `src/content/handlers/chatgpt.js` line ~173
4. [ ] E2.2 Reduce edit debounce from 650ms to 350ms. `src/content/handlers/chatgpt.js` line ~182
5. [ ] Validate via testing checklist (see bottom)

---

## P0 Performance Fixes

- [ ] P1.1 Merge algorithm O(n²) optimization. `src/content/handlers/chatgpt.js` lines ~572-630
- [ ] P1.2 Merge result caching. `src/content/handlers/chatgpt.js` lines ~599-630
- [ ] P1.3 DOM query caching with TTL. `src/content/handlers/chatgpt.js` line ~653
- [ ] P1.4 Render throttling (60fps cap). `src/content/handlers/chatgpt.js` lines ~140-160
- [ ] P1.5 Trim caching to avoid repeated string ops. `src/content/handlers/chatgpt.js` lines ~605-606

---

## P0 Editing Fixes

- [ ] E2.1 Replace edit-blocking with buffered merge. `src/content/handlers/chatgpt.js` line ~173
- [ ] E2.2 Reduce edit debounce to 350ms. `src/content/handlers/chatgpt.js` line ~182
- [ ] E2.3 Preserve cursor selection on rebase. `src/content/handlers/chatgpt.js` lines ~187-197
- [ ] E2.4 Add edit range tracking for selective updates. `src/content/handlers/chatgpt.js` (architectural)

---

## P1 Speechmatics API Enhancements

- [x] S3.1 Preserve and emit confidence metadata. `src/content/handlers/transcription-handler.js` line ~640
- [ ] S3.2 Enable diarization (speaker separation). `src/content/handlers/transcription-handler.js` lines ~435-445
- [ ] S3.3 Add audio filtering configuration. `src/content/handlers/transcription-handler.js` lines ~435-445
- [ ] S3.4 Smart formatting (numbers, dates). `src/content/handlers/transcription-handler.js` lines ~435-445
- [ ] S3.5 Custom vocabulary support. `src/content/handlers/transcription-handler.js` lines ~435-445

---

## P1 Reliability Fixes

- [x] R4.1 Add WebSocket retry with exponential backoff. `src/content/handlers/transcription-handler.js` lines ~365-405
- [x] R4.2 Session checkpointing for recovery on disconnect. `src/content/handlers/chatgpt.js` (architectural)
- [x] R4.3 Validate incoming message payloads. `src/content/handlers/transcription-handler.js` lines ~600+

---

## P2 State & Architecture Fixes

- [ ] SM5.1 Consolidate 20+ state variables into a unified state object. `src/content/handlers/chatgpt.js` lines ~20-100
- [x] SM5.2 Replace multiple edit flags with a state machine. `src/content/handlers/chatgpt.js` lines ~70-75
- [ ] Migrate to modular architecture in `chatgpt-refactored.js` and `transcription-handler-refactored.js`

---

## P2 Missing Features

- [ ] MF6.1 Add performance metrics collection (merge, render, latency). (codebase-wide)
- [ ] MF6.2 Add keyboard shortcut customization. (codebase-wide)
- [ ] MF6.3 Add audio level visual indicator. (UI)

---

## 7 Major Improvement Opportunities

- [ ] Confidence-aware UI highlights with alternatives and correction workflow
- [ ] Full diarization UX (speaker labels + separation in transcript)
- [ ] Domain vocab presets (medical, legal, technical) with user override
- [ ] Advanced audio preprocessing (noise gate, VAD, AGC tuning)
- [ ] Metrics dashboard (p50/p95 latency, reconnect rate, drop rate)
- [ ] Session timeline playback (segment list with timestamps)
- [ ] Modular refactor: shared StateManager, EventEmitter, DOMUtils everywhere

---

## Priority Matrix (Condensed)

| ID    | Area        | Severity | Priority | Est. Hours |
| ----- | ----------- | -------- | -------- | ---------- |
| P1.1  | Performance | Critical | P0       | 2          |
| P1.2  | Performance | High     | P0       | 1          |
| P1.3  | Performance | High     | P0       | 1.5        |
| P1.4  | Performance | High     | P0       | 1          |
| E2.1  | Editing     | Critical | P0       | 2          |
| E2.2  | Editing     | High     | P0       | 0.5        |
| E2.3  | Editing     | Medium   | P1       | 1          |
| E2.4  | Editing     | High     | P1       | 2          |
| S3.1  | API         | High     | P1       | 2          |
| R4.1  | Reliability | High     | P1       | 2          |
| R4.2  | Reliability | Medium   | P2       | 2          |
| SM5.1 | State       | Medium   | P2       | 3          |

---

## Timeline Tracking

| Phase | Window        | Scope                                    | Target Outcome |
| ----- | ------------- | ---------------------------------------- | -------------- |
| 1     | Days 1-2       | P0 performance + editing                 | Production safe |
| 2     | Days 3-4       | Reliability (retry, recovery, validation) | Stable sessions |
| 3     | Day 5          | API enhancements (confidence, diarization) | Rich metadata |
| 4     | Week 2         | UX polish + metrics + refactor           | Scalable architecture |

---

## Performance Improvements Table

| Metric                | Current    | Target    |
| --------------------- | ---------- | --------- |
| Merge latency         | 5-50ms     | <1ms      |
| Render latency        | 20-50ms    | <2ms      |
| Edit responsiveness   | 650ms      | 350ms     |
| Frame rate            | 20-40fps   | 55-60fps  |
| Data loss on edit     | Yes        | No        |
| Reconnect resilience  | None       | 5 retries |

---

## Critical Fixes (Copy-Paste Ready)

### 1) Merge optimization + cache (P1.1, P1.2)

```javascript
let lastMergeCommitted = "";
let lastMergePartial = "";
let cachedMergeResult = "";

function mergeCommittedAndPartial(committedText, partialText) {
  const committed = (committedText || "").trim();
  const partial = (partialText || "").trim();

  if (committed === lastMergeCommitted && partial === lastMergePartial) {
    return cachedMergeResult;
  }

  let result;
  if (!committed) result = partial;
  else if (!partial) result = committed;
  else if (partial.substring(0, committed.length) === committed) result = partial;
  else if (committed.startsWith(partial)) result = committed;
  else {
    const overlap = detectOverlapFast(committed, partial);
    result = overlap > 0 ? committed + " " + partial.slice(overlap) : committed + " " + partial;
  }

  lastMergeCommitted = committed;
  lastMergePartial = partial;
  cachedMergeResult = result;
  return result;
}

function detectOverlapFast(committed, partial) {
  const maxCheck = Math.min(committed.length, partial.length, 100);
  for (let len = maxCheck; len > 0; len--) {
    if (committed.slice(-len) === partial.slice(0, len)) return len;
  }
  return 0;
}
```

### 2) DOM element cache (P1.3)

```javascript
let cachedPromptEl = null;
let cachedPromptElTime = 0;
const PROMPT_CACHE_TTL_MS = 5000;

function getPromptElementCached() {
  const now = Date.now();
  if (cachedPromptEl && now - cachedPromptElTime < PROMPT_CACHE_TTL_MS) {
    if (cachedPromptEl.ownerDocument.contains(cachedPromptEl)) return cachedPromptEl;
  }
  cachedPromptEl = getPromptElement();
  cachedPromptElTime = now;
  return cachedPromptEl;
}
```

### 3) Editing buffer (E2.1)

```javascript
if (userEditingActive || isPartialUpdateInProgress) {
  editBufferedPartial = mergeCommittedAndPartial(editBufferedPartial, text);
  return;
}
```

### 4) Debounce reduction (E2.2)

```javascript
userEditDebounce = setTimeout(() => {
  // ... rebase logic ...
}, 350);
```

---

## Testing Checklist

- [ ] Normal speech, no duplication
- [ ] Edit during recording, no data loss
- [ ] Rapid partial updates, no flicker
- [ ] Long transcription (2+ minutes), stable UI
- [ ] Send button click while recording resets session cleanly
- [ ] Push-to-talk (Space) starts/stops reliably
- [ ] Cmd/Ctrl+M toggle works and preserves text
- [ ] Network disconnect triggers retry (when implemented)
- [ ] Confidence metadata displayed (when implemented)

---

## Quick Reference by Use Case

| Use Case | Issues to Implement |
| -------- | ------------------- |
| Performance + UI smoothness | P1.1, P1.2, P1.3, P1.4, P1.5 |
| Edit reliability | E2.1, E2.2, E2.3, E2.4 |
| Metadata + insights | S3.1, MF6.1 |
| Multi-speaker | S3.2 |
| Audio quality | S3.3, MF6.3 |
| Reliability | R4.1, R4.2, R4.3 |
| Maintainability | SM5.1, SM5.2, refactor |

---

## Search by Issue Type

| Type          | IDs |
| ------------- | --- |
| Performance   | P1.1, P1.2, P1.3, P1.4, P1.5 |
| Editing       | E2.1, E2.2, E2.3, E2.4 |
| API           | S3.1, S3.2, S3.3, S3.4, S3.5 |
| Reliability   | R4.1, R4.2, R4.3 |
| State         | SM5.1, SM5.2 |
| Missing feats | MF6.1, MF6.2, MF6.3 |

---

## Notes

For detailed root-cause analysis and full code snippets per issue, see `COMPLETE_ISSUE_INVENTORY.md`. The roadmap and opportunity deep dives live in `COMPREHENSIVE_IMPROVEMENT_PLAN.md` and `CODE_ANALYSIS_AND_ENHANCEMENT_ROADMAP.md`.
