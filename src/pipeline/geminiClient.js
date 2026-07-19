/**
 * pipeline/geminiClient.js
 *
 * Low-level Gemini API caller shared by geminiExtractor.js (resume parsing +
 * scoring) and jobMatcher.js (resume-to-job matching) — one place for the
 * request/timeout/error handling, structured-JSON-output plumbing.
 */

const config = require('../config');

function buildUrl() {
  return `https://generativelanguage.googleapis.com/v1beta/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
}

/**
 * Calls Gemini with a prompt and a structured-output JSON schema, returning
 * the parsed JSON response.
 * @param {string} prompt
 * @param {object} responseSchema - Gemini structured-output schema (OBJECT/STRING/NUMBER/ARRAY/enum).
 * @param {number} [timeoutMs=30000]
 * @returns {Promise<object>} Parsed JSON matching responseSchema.
 * @throws if the API key is missing, the request fails/times out, or the response is unusable.
 */
async function callGeminiJSON(prompt, responseSchema, timeoutMs = 30000) {
  if (!config.gemini.apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(buildUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema,
          temperature: 0.1,
        },
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errBody = await response.text().catch(() => '');
    throw new Error(`Gemini API error ${response.status}: ${errBody.slice(0, 300)}`);
  }

  const data = await response.json();
  const textPart = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textPart) {
    throw new Error('Gemini API returned no extractable content');
  }

  try {
    return JSON.parse(textPart);
  } catch (e) {
    throw new Error('Gemini API returned invalid JSON');
  }
}

module.exports = { callGeminiJSON };
