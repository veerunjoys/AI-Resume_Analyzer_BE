const fs = require('fs');
const path = require('path');
const supabaseStorage = require('./supabaseStorage');

const SUPABASE_SCHEME = 'supabase://';

const localRootUploads = path.resolve(__dirname, '..', '..', 'uploads');
const dockerUploads = path.resolve(__dirname, '..', 'uploads');
const UPLOADS_DIR = process.env.UPLOADS_DIR || (
  fs.existsSync(localRootUploads) ? localRootUploads : dockerUploads
);

const TMP_DIR = path.join(UPLOADS_DIR, 'tmp');
const RESUMES_DIR = path.join(UPLOADS_DIR, 'resumes');

/**
 * Initializes the upload directories on disk.
 */
function initStorage() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
  if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
  }
  if (!fs.existsSync(RESUMES_DIR)) {
    fs.mkdirSync(RESUMES_DIR, { recursive: true });
  }
}

/**
 * Starts a new upload session by creating a temporary folder.
 * @param {string} sessionId
 */
function startUpload(sessionId) {
  const sessionPath = path.join(TMP_DIR, sessionId);
  if (!fs.existsSync(sessionPath)) {
    fs.mkdirSync(sessionPath, { recursive: true });
  }
}

/**
 * Writes a chunk buffer to the session directory.
 * @param {string} sessionId
 * @param {number} chunkIndex
 * @param {Buffer} buffer
 */
function writeChunk(sessionId, chunkIndex, buffer) {
  const chunkPath = path.join(TMP_DIR, sessionId, `chunk_${chunkIndex}`);
  fs.writeFileSync(chunkPath, buffer);
}

/**
 * Concatenates all chunks in order, writes the final file, and cleans up the temporary directory.
 * @param {string} sessionId
 * @param {number} totalChunks
 * @param {string} candidateId
 * @param {string} fileName
 * @returns {string} The final file path of the assembled file.
 */
async function completeUpload(sessionId, totalChunks, candidateId, fileName) {
  const sessionPath = path.join(TMP_DIR, sessionId);

  // Create sanitized filename to prevent directory traversal
  const sanitizedFileName = path.basename(fileName);
  const finalFileName = `${candidateId}_${sanitizedFileName}`;
  const finalFilePath = path.join(RESUMES_DIR, finalFileName);

  const writeStream = fs.createWriteStream(finalFilePath);

  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(sessionPath, `chunk_${i}`);
    if (!fs.existsSync(chunkPath)) {
      throw new Error(`Missing chunk ${i} for session ${sessionId}`);
    }
    const chunkBuffer = fs.readFileSync(chunkPath);
    writeStream.write(chunkBuffer);
  }

  // Wait for the file to be fully flushed to disk before proceeding —
  // downstream checksum/parsing steps need to read a complete file.
  await new Promise((resolve, reject) => {
    writeStream.on('finish', resolve);
    writeStream.on('error', reject);
    writeStream.end();
  });

  // Clean up chunk files and the session folder
  for (let i = 0; i < totalChunks; i++) {
    const chunkPath = path.join(sessionPath, `chunk_${i}`);
    if (fs.existsSync(chunkPath)) {
      fs.unlinkSync(chunkPath);
    }
  }
  if (fs.existsSync(sessionPath)) {
    fs.rmdirSync(sessionPath);
  }

  // If Supabase Storage is configured, upload there and use the local temp
  // copy only as the source — the local file is removed afterward so the
  // durable copy lives in Supabase. Falls back to local disk (unchanged
  // behavior) if Supabase isn't configured or the upload fails.
  if (supabaseStorage.isConfigured) {
    const storagePath = `${candidateId}/${finalFileName}`;
    try {
      await supabaseStorage.uploadFile(finalFilePath, storagePath);
      fs.unlinkSync(finalFilePath);
      return `${SUPABASE_SCHEME}${storagePath}`;
    } catch (err) {
      // Leave the local copy in place and fall back to disk storage for this upload.
      console.error('Supabase Storage upload failed, falling back to local disk:', err.message);
    }
  }

  // Return path relative to server root or absolute path
  return path.relative(path.join(__dirname, '..'), finalFilePath).replace(/\\/g, '/');
}

/**
 * Resolves a `resume_s3_key` value (local relative path OR "supabase://..."
 * path) into the file's raw bytes, regardless of which backend it lives in.
 * @param {string} resumeS3Key
 * @returns {Promise<Buffer>}
 */
async function resolveResumeBuffer(resumeS3Key) {
  if (resumeS3Key.startsWith(SUPABASE_SCHEME)) {
    return supabaseStorage.downloadFile(resumeS3Key.slice(SUPABASE_SCHEME.length));
  }
  const absolutePath = path.isAbsolute(resumeS3Key)
    ? resumeS3Key
    : path.resolve(__dirname, '..', resumeS3Key);
  return fs.promises.readFile(absolutePath);
}

/**
 * True if a `resume_s3_key` value points at Supabase Storage rather than local disk.
 * @param {string} resumeS3Key
 * @returns {boolean}
 */
function isSupabaseKey(resumeS3Key) {
  return typeof resumeS3Key === 'string' && resumeS3Key.startsWith(SUPABASE_SCHEME);
}

module.exports = {
  initStorage,
  startUpload,
  writeChunk,
  completeUpload,
  resolveResumeBuffer,
  isSupabaseKey,
};
