# Testing Strategy Document

This document summarizes the testing hierarchy, automated coverage, resilience verification scenarios, and known testing limitations of the Recruiter Workspace application.

---

## 1. Unit Test Coverage

We have implemented isolated unit tests checking individual modules and UI rendering calculations.

### Client Unit Tests
* **Virtualization Window Bounds**: Located in [CandidateList.test.jsx](file:///r:/Novelski/Recruiter%20Workspace/client/src/components/__tests__/CandidateList.test.jsx). Validates that only candidate rows within the visible boundaries (and buffer/overscan limits) are rendered in the DOM. Simulates scroll container offset adjustments (`scrollTop = 2000`) and asserts dynamic list updates.
* **Upload State Machine Transitions**: Located in [resumableUpload.test.js](file:///r:/Novelski/Recruiter%20Workspace/client/src/utils/__tests__/resumableUpload.test.js). Verifies the chunk uploader's state machine status flow (`idle`, `uploading`, `paused`, `completed`, `failed`, `cancelled`) under positive fetch loops, and simulates exponential backoff retries using Jest fake timers on mock network drops.
* **Offline IndexedDB Store**: Located in [offlineQueue.test.js](file:///r:/Novelski/Recruiter%20Workspace/client/src/utils/__tests__/offlineQueue.test.js). Verifies that enqueuing, removing, and listing candidate modifications functions correctly on the local database's in-memory fallback array.

### Server Unit Tests
* **Sync Conflict Resolution Engine**: Located in [syncReplay.test.js](file:///r:/Novelski/Recruiter%20Workspace/server/src/__tests__/syncReplay.test.js). Mocks database queries (normalizing newlines/spaces) to assert the three outcomes of `/api/sync/replay` replays:
  * **Applied**: The client's base version matches the current DB version.
  * **Merged**: Version mismatch exists, but modifications are on different columns. They are merged.
  * **Conflict**: Version mismatch exists, and client modified a column that was already changed on the server. Flags conflicts and returns current values.

---

## 2. Integration Test Coverage

We implemented API and lifecycle integration tests to assert end-to-end server features.

### Candidates API Query & Filtering
* **Location**: [candidatesIntegration.test.js](file:///r:/Novelski/Recruiter%20Workspace/server/src/__tests__/candidatesIntegration.test.js)
* **Scenarios Covered**:
  * Default lists and custom limit checks.
  * Correct parameter array mapping for filters (`status`, `skills`, `location`).
  * Keyset cursor pagination (decoding composite base64 cursor strings).
  * Full-text search (FTS) queries, sorting by rank, and rank-based keyset pagination.

### Resumable Upload Workflow
* **Location**: [uploadIntegration.test.js](file:///r:/Novelski/Recruiter%20Workspace/server/src/__tests__/uploadIntegration.test.js)
* **Scenarios Covered**:
  * Initializing sessions (`POST /api/uploads/start`).
  * Uploading raw binary chunk streams (`PUT /api/uploads/:sessionId/chunk/:chunkIndex`).
  * Fetching chunk status details (`GET /api/uploads/:sessionId/status`).
  * Completing sessions (`POST /api/uploads/:sessionId/complete`) to aggregate files and update candidate tables in a single transaction.

### WebSocket Gateway & Replay
* **Location**: [websocketIntegration.test.js](file:///r:/Novelski/Recruiter%20Workspace/server/src/__tests__/websocketIntegration.test.js)
* **Scenarios Covered**:
  * Establishing socket connections, client authentication, and ping-pong responses.
  * Verifying broadcasts are sent to active authenticated sockets.
  * Verifying the REST endpoint (`GET /api/events/since/:sequenceId`) correctly retrieves and returns missed events in sequential order.

---

## 3. Resilience Verification Scenarios

We verified the system's fault-tolerant behaviors under network disruption using both scripted automation and manual checklists.

Detailed step-by-step checklists are available in:
* [resilience_test_scenarios.md](file:///C:/Users/ganji/.gemini/antigravity-ide/brain/d52b8534-ff79-428b-a940-ba6278a252c5/resilience_test_scenarios.md)

### Interrupted Resumable Upload
* **Behavior Tested**: Client starts an upload, loses connection mid-upload, pauses gracefully, restores network, requests session status, and skips already uploaded chunks, sending only remaining parts.
* **Validation**: Verified chunk status maps are correctly logged in the database (`upload_sessions.chunks_received`) and the client skips Chunk 0 if it was marked as received.

### WebSocket Reconnect & Event Catch-up
* **Behavior Tested**: Client disconnects, updates occur on server, client reconnects, queries event stream, and catches up.
* **Validation**: Verified with [test_reconnect_replay.mjs](file:///C:/Users/ganji/.gemini/antigravity-ide/brain/d52b8534-ff79-428b-a940-ba6278a252c5/scratch/test_reconnect_replay.mjs). Buffered live events are sorted and processed in sequential order alongside missed historical events.

### Offline Edit Conflicts
* **Behavior Tested**: Client makes optimistic edits offline. Concurrent online edits occur on the database. Client reconnects, triggers replay, receives conflict metadata, and displays the comparative modal.
* **Validation**: Verified with [test_e2e_checkpoint.mjs](file:///C:/Users/ganji/.gemini/antigravity-ide/brain/d52b8534-ff79-428b-a940-ba6278a252c5/scratch/test_e2e_checkpoint.mjs). Verified that conflicts are correctly written to the local conflicts store in IndexedDB and that "Keep Mine", "Keep Theirs", and "Edit Manually" triggers resolve DB values.

---

## 4. Known Gaps & Limitations

Given the project's timeline, several testing gaps remain:

1. **IndexedDB Real Browser Mocking**:
   * *Gap*: Automated unit tests utilize the memory array fallback store for IndexedDB rather than running a full headless browser or a virtual JSDOM IndexedDB mock (like `fake-indexeddb`).
   * *Impact*: IndexedDB connection failures, storage quotas, or browser corruption scenarios are not fully verified in automated unit tests.
2. **WebSocket Gateway Node Scalability**:
   * *Gap*: The WebSocket gateway maintains client mapping solely in-memory (`clients` Map).
   * *Impact*: If the backend scales horizontally to multiple node instances, a client connected to Node A will not receive broadcasts generated on Node B. A publish/subscribe layer (e.g. Redis Pub/Sub) is required to coordinate broadcasts across instances.
3. **Chunk File Aggregation Disk Dependency**:
   * *Gap*: Upload completes trigger local disk storage chunk aggregation before pushing to S3.
   * *Impact*: High-volume simultaneous uploads could saturate server disk space. Future enhancements should upload parts directly to S3 as multipart segments, bypassing local disk storage.
