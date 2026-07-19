/**
 * pipeline/jobMatcher.js
 *
 * LLM-based resume-to-job matching via Gemini. Given a candidate's resume text
 * and a job's requirements, produces a match score, matched/missing skills,
 * an experience-fit read, and a recommendation — used to rank applicants.
 */

const { callGeminiJSON } = require('./geminiClient');

const RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    matchScore: { type: 'NUMBER' },
    matchedSkills: { type: 'ARRAY', items: { type: 'STRING' } },
    missingSkills: { type: 'ARRAY', items: { type: 'STRING' } },
    experienceMatch: { type: 'STRING' },
    recommendation: { type: 'STRING' },
  },
};

const PROMPT_TEMPLATE = `You are evaluating how well a candidate's resume matches a specific job opening.

Job Title: __JOB_TITLE__
Required Skills: __REQUIRED_SKILLS__
Minimum Experience: __MIN_EXPERIENCE__ years
Job Description:
"""
__JOB_DESCRIPTION__
"""

Candidate Resume:
"""
__RAW_TEXT__
"""

Rules:
- matchScore: 0-100, how well this candidate fits this specific job (skills overlap, experience level, relevant background). Not the same as a general resume-quality score — judge fit against THIS job only.
- matchedSkills: required/relevant skills from the job that the candidate's resume demonstrates.
- missingSkills: required skills from the job that the candidate's resume does not demonstrate.
- experienceMatch: one short phrase describing fit (e.g. "Exceeds requirement (6 yrs vs 3 yrs required)", "Meets requirement", "Below requirement (1 yr vs 3 yrs required)").
- recommendation: one short sentence on whether to advance this candidate for this specific job.`;

/**
 * @param {string} rawText - Candidate's resume text.
 * @param {{title: string, description: string, requiredSkills: string[], minExperience: number|null}} job
 * @returns {Promise<object>} { matchScore, matchedSkills, missingSkills, experienceMatch, recommendation }
 * @throws if the API key is missing, the request fails, or the response is unusable.
 */
async function matchResumeToJob(rawText, job) {
  const prompt = PROMPT_TEMPLATE
    .replace('__JOB_TITLE__', job.title || 'Untitled role')
    .replace('__REQUIRED_SKILLS__', (job.requiredSkills || []).join(', ') || 'Not specified')
    .replace('__MIN_EXPERIENCE__', job.minExperience != null ? String(job.minExperience) : 'Not specified')
    .replace('__JOB_DESCRIPTION__', (job.description || '').slice(0, 5000))
    .replace('__RAW_TEXT__', (rawText || '').slice(0, 15000));

  const result = await callGeminiJSON(prompt, RESPONSE_SCHEMA);

  const matchScore = typeof result.matchScore === 'number' && !Number.isNaN(result.matchScore)
    ? Math.max(0, Math.min(100, Math.round(result.matchScore * 10) / 10))
    : 0;

  return {
    matchScore,
    matchedSkills: Array.isArray(result.matchedSkills) ? result.matchedSkills.filter((s) => typeof s === 'string' && s.trim()) : [],
    missingSkills: Array.isArray(result.missingSkills) ? result.missingSkills.filter((s) => typeof s === 'string' && s.trim()) : [],
    experienceMatch: result.experienceMatch ? String(result.experienceMatch).trim() : null,
    recommendation: result.recommendation ? String(result.recommendation).trim() : null,
  };
}

module.exports = { matchResumeToJob };
