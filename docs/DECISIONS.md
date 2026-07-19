# Technical Decision Log

This document records the architectural rationale and specific "why" behind the major technical choices made during the development of the Recruiter Workspace application.

---

## 1. Keyset Pagination over Offset Pagination

### Choice
We implemented keyset (cursor-based) pagination sorted by candidate name (`name ASC, id ASC`) and rank (`rank DESC, id ASC` for search) instead of standard offset pagination (`LIMIT / OFFSET`).

### Rationale
* **Performance at Scale**: With our seeded database scaled up to **100,000+ candidates**, offset pagination performs poorly. For a query like `LIMIT 50 OFFSET 90000`, PostgreSQL must scan, parse, and sort the first 90,050 records before throwing away the first 90,000, resulting in $O(N)$ query times. Keyset pagination jumps directly to the target rows in $O(1)$ time by querying boundary conditions (e.g. `(name > $1 OR (name = $1 AND id > $2))`), fully utilizing composite indices.
* **Consistency**: Offset pagination is prone to duplicate or skipped items if candidate records are added or deleted while a user is navigating between pages. Keyset pagination provides stable page boundaries because cursors anchor the query to a specific, immutable row coordinate.

---

## 2. Fixed Row Height for List Virtualization

### Choice
We virtualized the candidate list using a fixed row height of `56px` (`rowHeight = 56` in [CandidateList.jsx](file:///r:/Novelski/Recruiter%20Workspace/client/src/components/CandidateList.jsx)) rather than dynamic heights.

### Rationale
* **Computation Simplicity**: Dynamic heights require measuring DOM elements dynamically, caching row measurements, or rendering off-screen items to calculate layouts. This incurs substantial layout reflow overhead.
* **Smooth 60fps Scrolling**: Fixed heights allow simple, instant arithmetic calculations for the visible range:
  ```javascript
  const startRow = Math.floor(scrollTop / rowHeight);
  const endRow = startRow + Math.ceil(containerHeight / rowHeight);
  ```
  This is executed on scroll offsets in a micro-second, allowing us to scroll smoothly through 100,000 records without causing browser layout thrashing or stutter.

---

## 3. React `useReducer` over External State Library

### Choice
We leveraged React's built-in `useReducer` hook to manage the candidate list's state ([CandidateList.jsx](file:///r:/Novelski/Recruiter%20Workspace/client/src/components/CandidateList.jsx)) instead of importing external state managers like Redux or Zustand.

### Rationale
* **Zero-Dependency overhead**: It keeps the codebase lean and free of bundle bloat, ensuring fast initial page loads.
* **Component-Level Encapsulation**: Reducers are scoped directly to the directory list, managing pagination states, scroll offsets, highlighted IDs, and optimistic updates cleanly.
* **Reference Identity Safeguards**: We optimized the reducer actions (e.g., `SET_SCROLL`) to return the exact prior state reference if the payload matches the current state. This directly prevents React from running redundant reconciliation passes, matching the performance of external state libraries.

---

## 4. Bounded Concurrency Pool for Resumable Uploads

### Choice
We limited the maximum concurrent chunk uploads to exactly `4` simultaneous requests ([resumableUpload.js](file:///r:/Novelski/Recruiter%20Workspace/client/src/utils/resumableUpload.js)):
```javascript
while (activeUploadsCount < 4 && pendingIndices.length > 0) { ... }
```

### Rationale
* **Network Stability**: If a user uploads a large resume (e.g., 80MB split into ten 8MB chunks), triggering ten simultaneous `PUT` requests would saturate the client's network upload bandwidth.
* **Browser Limitations**: Modern browsers limit the number of simultaneous active TCP connections to the same host (typically 6 connections). Flooding the connection pool leads to socket queuing, latency spikes, and chunk upload timeouts. Staging the queue with a maximum concurrency of `4` leaves room for standard API calls and WebSocket heartbeats while maximizing chunk upload throughput.

---

## 5. S3 Multipart-Style Local Chunk Storage

### Choice
We designed the resumable upload API (`start` -> `chunk` -> `status` -> `complete`) to mirror the AWS S3 Multipart Upload architecture, writing chunk binaries locally to `uploads/tmp/:sessionId/chunk_:index` before assembling them in [storage.js](file:///r:/Novelski/Recruiter%20Workspace/server/src/storage.js).

### Rationale
* **Zero Client Rewrite for Cloud Migrations**: By using S3-style semantics (sessions acting as Upload IDs, chunk indices acting as Part Numbers, and database tables logging `chunks_received`), the client remains entirely decoupled from the underlying storage technology.
* **S3 Integration Ready**: If we shift storage to cloud buckets, we can swap out the filesystem writes inside [storage.js](file:///r:/Novelski/Recruiter%20Workspace/server/src/storage.js) with AWS SDK calls (`UploadPartCommand`, `CompleteMultipartUploadCommand`) without changing a single line of client code or API endpoint path contracts.

---

## 6. Version-Based Optimistic Concurrency Control (OCC)

### Choice
We introduced a `version` column to the `candidates` table (default `1`, incremented on every update) to act as a version lock during offline updates.

### Rationale
* **Preventing Silent Overwrites**: In a collaborative recruiting environment, two recruiters might edit the same candidate. If recruiter A goes offline, edits a candidate's notes (staged at version 1), and recruiter B (online) changes their status to "Interviewing" (bumping DB to version 2), recruiter A's subsequent reconnect sync must not blindly overwrite the DB.
* **Explicit Mismatch Detection**: By requiring the client to submit the `base_version` expected during editing, `/api/sync/replay` instantly recognizes concurrency issues when `base_version !== db_version`, routing the action to our conflict-detection engine.

---

## 7. Field-Level Merge with Last-Write-Wins (LWW) Fallback

### Choice
We implemented field-level merge for conflicts inside `/api/sync/replay` (comparing the client's edits with server events since the client's `base_version`). If different columns were touched, they are merged. If the same column was modified, a conflict is flagged for manual resolution.

### Rationale
* **Disjoint Update Merges**: Pure Last-Write-Wins (LWW) is highly destructive because it throws away entire edits. For example, if Recruiter A edits the *notes* offline, and Recruiter B edits the *status* online, pure LWW would overwrite B's status changes when A syncs. 
* **Granular Isolation**: Field-level merge detects that Recruiter A only modified `notes` and Recruiter B only modified `status`. The changes are merged automatically, ensuring zero data loss. The system only triggers the **Conflict Resolution Modal** when there is a direct overlap on the *same column* (e.g. status set to "Offer" offline vs "Rejected" online).

---

## 8. IndexedDB over `localStorage` for Offline Queues

### Choice
We built the offline queue ([offlineQueue.js](file:///r:/Novelski/Recruiter%20Workspace/client/src/utils/offlineQueue.js)) using the browser's IndexedDB API, wrapping it in an in-memory array fallback for Node.js testing.

### Rationale
* **Thread-Safe Asynchrony**: `localStorage` operations are synchronous and run on the browser's main thread. Parsing and saving large queues (containing JSON payloads and binary structures) causes UI freezing and frames dropping. IndexedDB is asynchronous and executes without blocking the UI.
* **Storage Limits & Structured Data**: `localStorage` is restricted to a strict 5MB quota and only supports string values. IndexedDB has large limits (often hundreds of megabytes) and natively stores complex objects. This allows us to maintain separate object stores (e.g., `'queue'` for sync operations, and `'conflicts'` for storing detailed side-by-side comparative server diffs) with ease.
