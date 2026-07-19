/**
 * supabaseStorage.js
 *
 * Thin wrapper around the Supabase Storage API for resume files.
 * All functions no-op/throw clearly when Supabase isn't configured so
 * callers (storage.js) can fall back to local disk.
 */

const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const config = require('./config');

const isConfigured = Boolean(config.supabase.url && config.supabase.serviceRoleKey);

let client = null;
function getClient() {
  if (!isConfigured) return null;
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

/**
 * Uploads a local file to the resumes bucket.
 * @param {string} localFilePath - Absolute path to the file on local disk.
 * @param {string} storagePath - Destination path within the bucket, e.g. "{candidateId}/{fileName}".
 * @returns {Promise<string>} The storage path (same as `storagePath`, for convenience chaining).
 */
async function uploadFile(localFilePath, storagePath) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase Storage is not configured');

  const fileBuffer = await fs.promises.readFile(localFilePath);
  const { error } = await supabase.storage
    .from(config.supabase.resumesBucket)
    .upload(storagePath, fileBuffer, { upsert: true });

  if (error) throw new Error(`Supabase Storage upload failed: ${error.message}`);
  return storagePath;
}

/**
 * Downloads a file from the resumes bucket into a Buffer.
 * @param {string} storagePath
 * @returns {Promise<Buffer>}
 */
async function downloadFile(storagePath) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase Storage is not configured');

  const { data, error } = await supabase.storage
    .from(config.supabase.resumesBucket)
    .download(storagePath);

  if (error) throw new Error(`Supabase Storage download failed: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

/**
 * Generates a time-limited signed URL for downloading a file.
 * @param {string} storagePath
 * @param {number} [expiresInSeconds=3600]
 * @returns {Promise<string>}
 */
async function getSignedUrl(storagePath, expiresInSeconds = 3600) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase Storage is not configured');

  const { data, error } = await supabase.storage
    .from(config.supabase.resumesBucket)
    .createSignedUrl(storagePath, expiresInSeconds);

  if (error) throw new Error(`Supabase Storage signed URL failed: ${error.message}`);
  return data.signedUrl;
}

module.exports = { isConfigured, uploadFile, downloadFile, getSignedUrl };
