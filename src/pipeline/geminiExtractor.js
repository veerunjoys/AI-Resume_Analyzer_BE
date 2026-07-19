/**
 * pipeline/geminiExtractor.js
 *
 * LLM-based resume field extraction via the Gemini API.
 * Returns the same shape as resumeParser.parseResume() so it's a drop-in
 * replacement for the heuristic/NLP parser wherever parsed resume data is consumed.
 */

const config = require('../config');
const { callGeminiJSON } = require('./geminiClient');

const CONFIDENCE_ENUM = ['high', 'medium', 'low'];

// Category weights per the resume-scoring rubric — must sum to 1.
const CATEGORY_WEIGHTS = {
  skills: 0.30,
  experience: 0.25,
  projects: 0.15,
  education: 0.10,
  certifications: 0.05,
  structure: 0.05,
  communication: 0.05,
  achievements: 0.05,
};

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    name: { type: 'STRING', nullable: true },
    nameConfidence: { type: 'STRING', enum: CONFIDENCE_ENUM },
    email: { type: 'STRING', nullable: true },
    phone: { type: 'STRING', nullable: true },
    location: { type: 'STRING', nullable: true },
    locationConfidence: { type: 'STRING', enum: CONFIDENCE_ENUM },
    experienceYears: { type: 'NUMBER', nullable: true },
    experienceConfidence: { type: 'STRING', enum: CONFIDENCE_ENUM },
    jobTitle: { type: 'STRING', nullable: true },
    jobTitleConfidence: { type: 'STRING', enum: CONFIDENCE_ENUM },
    skills: { type: 'ARRAY', items: { type: 'STRING' } },
    education: { type: 'STRING', nullable: true },
    educationInstitution: { type: 'STRING', nullable: true },
    educationConfidence: { type: 'STRING', enum: CONFIDENCE_ENUM },
    linkedin: { type: 'STRING', nullable: true },
    github: { type: 'STRING', nullable: true },
    summary: { type: 'STRING', nullable: true },
    categoryScores: {
      type: 'OBJECT',
      properties: {
        skills: { type: 'NUMBER' },
        experience: { type: 'NUMBER' },
        projects: { type: 'NUMBER' },
        education: { type: 'NUMBER' },
        certifications: { type: 'NUMBER' },
        structure: { type: 'NUMBER' },
        communication: { type: 'NUMBER' },
        achievements: { type: 'NUMBER' },
      },
    },
    strengths: { type: 'ARRAY', items: { type: 'STRING' } },
    weaknesses: { type: 'ARRAY', items: { type: 'STRING' } },
    missingSkills: { type: 'ARRAY', items: { type: 'STRING' } },
    analysisSummary: { type: 'STRING', nullable: true },
    recommendation: { type: 'STRING', nullable: true },
  },
};

const PROMPT_TEMPLATE = `You are a resume-parsing engine. Extract structured fields from the resume text below.

Rules:
- name: the candidate's full name (2-5 words), properly capitalized.
- email: the candidate's primary email address, lowercase.
- phone: the candidate's phone number, digits with an optional leading "+".
- location: candidate's current city (and state/country if present).
- experienceYears: total years of professional experience as a number. Estimate from work history dates if not explicitly stated.
- jobTitle: candidate's most recent/current job title.
- skills: an array of technical skills/technologies mentioned (no duplicates, no soft skills).
- education: highest degree found (e.g. "B.Tech in Computer Science").
- educationInstitution: the school/university name for that degree, if present.
- linkedin: full LinkedIn profile URL if present.
- github: full GitHub profile URL if present.
- summary: a 1-3 sentence professional summary, taken from the resume's own summary/objective section if present, otherwise null.
- For every *Confidence field, rate how directly the value is stated in the text: "high" if explicitly stated, "medium" if inferred from clear context, "low" if guessed.
- Use null for any field that cannot be found. Use an empty array for skills if none found.

Also evaluate the resume's overall quality as a hiring signal, independent of any specific job:
- categoryScores: rate each category 0-100 based on how strong the resume is in that dimension —
  skills (breadth/relevance of technical skills), experience (depth and progression of work history),
  projects (quality/complexity of projects described), education (degree relevance and institution caliber),
  certifications (relevant certifications present), structure (resume organization/readability/completeness),
  communication (clarity of writing, quantified impact statements), achievements (measurable accomplishments, awards).
- strengths: 3-5 short bullet points on what makes this resume strong.
- weaknesses: 3-5 short bullet points on what's missing or weak.
- missingSkills: skills a candidate at this apparent role/seniority would typically be expected to have but that are absent from the resume.
- analysisSummary: a 2-3 sentence AI-generated overview of this candidate as a hiring prospect (distinct from "summary" above, which is only the resume's own stated summary).
- recommendation: one short sentence recommending whether to advance this candidate (e.g. "Strong candidate, recommend advancing to interview." or "Below bar for typical requirements; review carefully before advancing.").

Resume text:
"""
__RAW_TEXT__
"""`;

/**
 * Extracts structured candidate fields AND a general resume-quality analysis
 * (score breakdown, strengths/weaknesses, summary, recommendation) from resume
 * text using a single Gemini call.
 * @param {string} rawText - Full extracted resume text (from pdf-parse/mammoth).
 * @returns {Promise<{parsed: object, analysis: object}>}
 *   `parsed` matches resumeParser.parseResume()'s shape (drop-in compatible).
 *   `analysis` matches the ai_analysis table shape.
 * @throws if the API key is missing, the request fails, or the response is unusable.
 */
async function extractWithGemini(rawText) {
  const truncated = (rawText || '').slice(0, 15000);
  const prompt = PROMPT_TEMPLATE.replace('__RAW_TEXT__', truncated);

  const extracted = await callGeminiJSON(prompt, RESPONSE_SCHEMA);

  return {
    parsed: mapToParsedShape(extracted),
    analysis: mapToAnalysisShape(extracted),
  };
}

function mapToParsedShape(x) {
  const skills = Array.isArray(x.skills) ? x.skills.filter((s) => typeof s === 'string' && s.trim()) : [];
  const experienceValue =
    typeof x.experienceYears === 'number' && !Number.isNaN(x.experienceYears)
      ? Math.max(0, Math.min(40, Math.round(x.experienceYears * 10) / 10))
      : null;

  return {
    name: x.name
      ? { value: String(x.name).trim(), confidence: x.nameConfidence || 'medium', method: 'gemini' }
      : null,
    email: x.email ? { value: String(x.email).trim().toLowerCase(), confidence: 'high' } : null,
    phone: x.phone ? { value: String(x.phone).replace(/[^\d+]/g, ''), confidence: 'high' } : null,
    location: x.location
      ? { value: String(x.location).trim(), confidence: x.locationConfidence || 'medium' }
      : null,
    experience:
      experienceValue !== null
        ? { value: experienceValue, unit: 'years', confidence: x.experienceConfidence || 'medium', method: 'gemini' }
        : null,
    jobTitle: x.jobTitle
      ? { value: String(x.jobTitle).trim(), confidence: x.jobTitleConfidence || 'medium' }
      : null,
    skills: skills.length > 0 ? { value: skills, confidence: 'high' } : null,
    education: x.education
      ? {
          value: String(x.education).trim(),
          institution: x.educationInstitution ? String(x.educationInstitution).trim() : null,
          confidence: x.educationConfidence || 'medium',
        }
      : null,
    linkedin: x.linkedin ? { value: String(x.linkedin).trim(), confidence: 'high' } : null,
    github: x.github ? { value: String(x.github).trim(), confidence: 'high' } : null,
    summary: x.summary ? { value: String(x.summary).trim(), confidence: 'medium' } : null,
  };
}

function clampScore(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n * 10) / 10));
}

function mapToAnalysisShape(x) {
  const rawScores = x.categoryScores || {};
  const categoryScores = {};
  let overallScore = 0;

  for (const [category, weight] of Object.entries(CATEGORY_WEIGHTS)) {
    const score = clampScore(rawScores[category]);
    categoryScores[category] = score;
    overallScore += score * weight;
  }

  const strengths = Array.isArray(x.strengths) ? x.strengths.filter((s) => typeof s === 'string' && s.trim()) : [];
  const weaknesses = Array.isArray(x.weaknesses) ? x.weaknesses.filter((s) => typeof s === 'string' && s.trim()) : [];
  const missingSkills = Array.isArray(x.missingSkills) ? x.missingSkills.filter((s) => typeof s === 'string' && s.trim()) : [];

  return {
    overallScore: clampScore(overallScore),
    categoryScores,
    strengths,
    weaknesses,
    missingSkills,
    summary: x.analysisSummary ? String(x.analysisSummary).trim() : null,
    recommendation: x.recommendation ? String(x.recommendation).trim() : null,
    model: config.gemini.model,
  };
}

module.exports = { extractWithGemini, CATEGORY_WEIGHTS };
