/**
 * pipeline/resumeParser.js
 *
 * Dedicated Resume Parser Module.
 * Extracts structured fields from raw resume text using NLP (compromise) and heuristics.
 */

const nlp = require('compromise');
const WordTokenizer = require('natural/lib/natural/tokenizers/regexp_tokenizer').WordTokenizer;

function parseResume(rawText) {
  if (!rawText || typeof rawText !== 'string') {
    return {
      name: null,
      email: null,
      phone: null,
      location: null,
      experience: null,
      jobTitle: null,
      skills: null,
      education: null,
      linkedin: null,
      github: null,
      summary: null,
    };
  }

  // 1. Full Name
  let nameVal = null;
  let nameConfidence = 'low';
  let nameMethod = 'heuristic';

  try {
    const first200 = rawText.slice(0, 200);
    const doc = nlp(first200);
    const peopleList = doc.people().out('array');

    if (peopleList && peopleList.length > 0) {
      // Find the first non-empty person entity
      const foundName = peopleList[0].trim();
      if (foundName && foundName.split(/\s+/).length >= 2 && foundName.split(/\s+/).length <= 5) {
        nameVal = foundName;
        nameConfidence = 'high';
        nameMethod = 'compromise';
      }
    }
  } catch (err) {
    console.error('Compromise name parsing error:', err);
  }

  if (!nameVal) {
    // Fallback heuristic: check lines in the top portion
    const lines = rawText.split('\n').map(l => l.trim()).filter(Boolean);
    for (let i = 0; i < Math.min(lines.length, 5); i++) {
      const line = lines[i];
      const wordCount = line.split(/\s+/).length;
      
      const isEmail = line.includes('@');
      const isPhone = /[\d\-+()]{7,}/.test(line);
      const isUrl = /github\.com|linkedin\.com|http|www\./i.test(line);
      const isAllUpper = line === line.toUpperCase() && line.length > 3;
      const hasDigits = /\d/.test(line);

      if (wordCount >= 2 && wordCount <= 5 && !isEmail && !isPhone && !isUrl && !isAllUpper && !hasDigits) {
        nameVal = line;
        nameConfidence = 'medium';
        nameMethod = 'heuristic';
        break;
      }
    }
  }

  // Clean Name
  if (nameVal) {
    nameVal = nameVal.trim()
      .replace(/[^a-zA-Z\s.-]/g, '')
      .split(/\s+/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  // 2. Email Address
  let emailVal = null;
  const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  const emailMatches = rawText.match(emailRegex);
  if (emailMatches) {
    for (const match of emailMatches) {
      const clean = match.toLowerCase().trim();
      if (!clean.includes('example.com') && !clean.includes('test.com') && !clean.includes('placeholder')) {
        emailVal = clean;
        break;
      }
    }
  }

  // 3. Phone Number
  let phoneVal = null;
  const phonePatterns = [
    /(\+91[\s-]?)?[6-9]\d{9}/g,                                 // Indian mobile
    /\+\d{1,3}[\s-]?\d{6,12}/g,                                 // International
    /\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,                     // US format
    /\b\d{10}\b/g                                               // Generic 10-digit
  ];

  for (const pattern of phonePatterns) {
    const matches = rawText.match(pattern);
    if (matches && matches.length > 0) {
      const firstPhone = matches[0];
      const hasPlus = firstPhone.startsWith('+');
      const cleaned = firstPhone.replace(/[^\d]/g, '');
      phoneVal = (hasPlus ? '+' : '') + cleaned;
      break;
    }
  }

  // 4. Location
  let locVal = null;
  let locConfidence = 'low';

  const cities = [
    'Mumbai', 'Delhi', 'New Delhi', 'Bangalore', 'Bengaluru', 'Hyderabad', 'Chennai', 'Pune', 'Kolkata', 'Ahmedabad',
    'Jaipur', 'Surat', 'Lucknow', 'Kanpur', 'Nagpur', 'Indore', 'New York', 'San Francisco', 'Seattle', 'Austin',
    'Boston', 'Chicago', 'Los Angeles', 'London', 'Manchester', 'Berlin', 'Amsterdam', 'Paris', 'Dubai', 'Singapore',
    'Toronto', 'Sydney', 'Melbourne', 'Tokyo'
  ];

  let firstCityMatch = null;
  let firstCityIndex = Infinity;

  for (const city of cities) {
    const cityRegex = new RegExp(`\\b${city}\\b`, 'i');
    const idx = rawText.search(cityRegex);
    if (idx !== -1 && idx < firstCityIndex) {
      firstCityIndex = idx;
      firstCityMatch = city;
    }
  }

  if (firstCityMatch) {
    const city = firstCityMatch;
    const idx = firstCityIndex;
    // Look for state/country names after city on the same line (e.g. Pune, Maharashtra)
    const postText = rawText.slice(idx, idx + 100);
    const match = postText.match(new RegExp(`^${city}[\\s,]+([^\\n]{2,20})`, 'i'));
    if (match) {
      const cleanedSuffix = match[1].split(/[|,;\n]/)[0].trim();
      // check if suffix contains URL/email keyword
      if (!cleanedSuffix.includes('@') && !cleanedSuffix.includes('.') && !cleanedSuffix.includes('/')) {
        locVal = `${city}, ${cleanedSuffix}`;
      }
    }
    if (!locVal) {
      locVal = city;
    }
    locConfidence = idx < 300 ? 'high' : 'medium';
  }

  if (!locVal) {
    // Strategy B: compromise places in first 300 chars
    try {
      const first300 = rawText.slice(0, 300);
      const places = nlp(first300).places().out('array');
      if (places && places.length > 0) {
        locVal = places[0].trim();
        locConfidence = 'high';
      }
    } catch (err) {
      console.error('Compromise location parsing error:', err);
    }
  }

  // 5. Years of Experience
  let expVal = null;
  let expConfidence = 'low';
  let expMethod = 'roles';

  // Method A — Direct statement extraction
  const statementPatterns = [
    /(\d+)\+?\s*years?\s*(of\s*)?(experience|exp)/gi,
    /experience\s*:?\s*(\d+)\+?\s*years?/gi,
    /(\d+)\+?\s*years?\s*in\s*(software|development|engineering)/gi
  ];

  for (const pattern of statementPatterns) {
    const match = pattern.exec(rawText);
    if (match) {
      const num = parseInt(match[1], 10);
      if (num >= 0 && num <= 40) {
        expVal = num;
        expConfidence = 'high';
        expMethod = 'statement';
        break;
      }
    }
  }

  // Method B — Calculate from work history dates
  if (expVal === null) {
    const yearsMatches = rawText.match(/\b(19|20)\d{2}\b/g);
    if (yearsMatches && yearsMatches.length > 0) {
      const currentYear = new Date().getFullYear();
      const validYears = yearsMatches
        .map(y => parseInt(y, 10))
        .filter(y => y >= 1990 && y <= currentYear);
      if (validYears.length > 0) {
        const earliest = Math.min(...validYears);
        const span = currentYear - earliest;
        if (span >= 0 && span <= 40) {
          expVal = span;
          expConfidence = 'medium';
          expMethod = 'dates';
        }
      }
    }
  }

  // Method C — Count job positions
  if (expVal === null) {
    const roleKeywords = ['Engineer', 'Developer', 'Manager', 'Analyst', 'Designer', 'Lead', 'Senior', 'Junior', 'Intern'];
    let roleCount = 0;
    for (const kw of roleKeywords) {
      const regex = new RegExp(`\\b${kw}\\b`, 'gi');
      const matches = rawText.match(regex);
      if (matches) roleCount += matches.length;
    }
    if (roleCount > 0) {
      expVal = Math.min(roleCount * 2, 40);
      expConfidence = 'low';
      expMethod = 'roles';
    }
  }

  // 6. Current/Most Recent Job Title
  let titleVal = null;
  let titleConfidence = 'low';

  const commonTitles = [
    'Software Engineer', 'Senior Software Engineer', 'Full Stack Developer', 'Frontend Developer',
    'Backend Developer', 'DevOps Engineer', 'Data Engineer', 'Data Scientist', 'Product Manager',
    'UI/UX Designer', 'QA Engineer', 'Mobile Developer', 'React Developer', 'Node.js Developer',
    'Cloud Engineer', 'Solutions Architect', 'Engineering Manager', 'CTO', 'Tech Lead', 'Team Lead',
    'Intern', 'Associate Engineer'
  ];
  const sortedTitles = [...commonTitles].sort((a, b) => b.length - a.length);

  const first500 = rawText.slice(0, 500);

  // Check common titles list first
  for (const title of sortedTitles) {
    const titleRegex = new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    const idx = first500.search(titleRegex);
    if (idx !== -1) {
      titleVal = title;
      titleConfidence = idx < 200 ? 'high' : 'medium';
      break;
    }
  }

  // Custom regex pattern match if list match not found
  if (!titleVal) {
    const customPattern = /(senior|junior|lead|principal|staff)?\s*(software|frontend|backend|fullstack|full\.stack|mobile|cloud|devops|data)\s*(engineer|developer|architect|analyst|scientist)/gi;
    const match = customPattern.exec(first500);
    if (match) {
      titleVal = match[0].trim();
      titleConfidence = match.index < 200 ? 'high' : 'medium';
    }
  }

  // Clean Title
  if (titleVal) {
    titleVal = titleVal.replace(/\s+/g, ' ')
      .split(' ')
      .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
      .join(' ');
  }

  // 7. Skills
  const skillsConfig = {
    languages: ['JavaScript', 'TypeScript', 'Python', 'Java', 'C++', 'C#', 'Go', 'Rust', 'Ruby', 'PHP', 'Swift', 'Kotlin', 'Scala', 'R', 'MATLAB', 'Dart', 'Perl', 'Shell', 'Bash'],
    frontend: ['React', 'Vue', 'Angular', 'Next.js', 'Nuxt', 'Svelte', 'HTML', 'CSS', 'Sass', 'Tailwind', 'Bootstrap', 'jQuery', 'Redux', 'GraphQL', 'REST', 'WebSocket'],
    backend: ['Node.js', 'Express', 'Django', 'Flask', 'FastAPI', 'Spring', 'Laravel', 'Rails', 'ASP.NET', 'NestJS', 'Fastify'],
    databases: ['PostgreSQL', 'MySQL', 'MongoDB', 'Redis', 'Elasticsearch', 'Cassandra', 'DynamoDB', 'SQLite', 'Oracle', 'SQL Server', 'Firebase', 'Supabase'],
    devops: ['Docker', 'Kubernetes', 'AWS', 'GCP', 'Azure', 'Terraform', 'Jenkins', 'GitHub Actions', 'CircleCI', 'Ansible', 'Nginx', 'Linux', 'Git'],
    tools: ['Agile', 'Scrum', 'Jira', 'Figma', 'Postman', 'Swagger', 'Jest', 'Mocha', 'Cypress', 'Selenium', 'Webpack', 'Vite']
  };

  const allSkillsToCheck = [];
  Object.values(skillsConfig).forEach(arr => allSkillsToCheck.push(...arr));

  const foundSkills = new Set();
  for (const skill of allSkillsToCheck) {
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let regex;
    // Handle specific terms carefully
    if (['C++', 'C#', 'Next.js', 'Node.js', 'Nuxt.js', 'Vue.js', 'React.js', '.NET', 'Ph.D'].includes(skill)) {
      regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    } else if (skill === 'R') {
      regex = new RegExp(`\\b${escaped}\\b`); // case sensitive for 'R'
    } else if (skill === 'Go') {
      regex = new RegExp(`\\b${escaped}\\b`); // case sensitive for 'Go'
    } else {
      regex = new RegExp(`\\b${escaped}\\b`, 'gi');
    }

    if (regex.test(rawText)) {
      foundSkills.add(skill);
    }
  }

  // Deduplicate and filter aliases (e.g. if both "React" and "ReactJS" exist, keep "React")
  const skillsArray = Array.from(foundSkills);

  // 8. Education
  let eduVal = null;
  let eduInst = null;
  let eduConfidence = 'low';

  const degreeKeywords = ['B.Tech', 'B.E', 'B.Sc', 'Bachelor', 'M.Tech', 'M.E', 'M.Sc', 'Master', 'MBA', 'PhD', 'Ph.D', 'BCA', 'MCA', 'B.Com', 'Diploma'];
  const universities = ['IIT', 'NIT', 'BITS', 'VIT', 'SRM', 'Anna University', 'Mumbai University', 'Delhi University', 'MIT', 'Stanford', 'Harvard', 'Oxford', 'Cambridge'];

  for (const degree of degreeKeywords) {
    const escapedDegree = degree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const degreeRegex = new RegExp(`\\b${escapedDegree}\\b`, 'i');
    const idx = rawText.search(degreeRegex);
    if (idx !== -1) {
      // Extract up to 30 characters after degree to get field of study
      const slice = rawText.slice(idx, idx + 40);
      const match = slice.match(new RegExp(`^${escapedDegree}[ \\t]*(?:in|of)?[ \\t]*([a-zA-Z \\t]{2,30})`, 'i'));
      eduVal = match ? match[0].trim() : degree;
      eduConfidence = 'medium';

      // Look for well-known universities within 100 characters
      const nearText = rawText.slice(Math.max(0, idx - 100), Math.min(rawText.length, idx + 150));
      for (const uni of universities) {
        const uniRegex = new RegExp(`\\b(${uni})\\b(?:[ \\t]+([A-Z][a-zA-Z]+))?`, 'i');
        const uniMatch = nearText.match(uniRegex);
        if (uniMatch) {
          if (uniMatch[2]) {
            eduInst = `${uniMatch[1]} ${uniMatch[2]}`;
          } else {
            eduInst = uniMatch[1];
          }
          // Normalize case of IIT/MIT/NIT
          if (['iit', 'nit', 'bits', 'vit', 'srm', 'mit'].includes(uni.toLowerCase())) {
            const parts = eduInst.split(' ');
            parts[0] = parts[0].toUpperCase();
            if (parts[1]) {
              parts[1] = parts[1].charAt(0).toUpperCase() + parts[1].slice(1).toLowerCase();
            }
            eduInst = parts.join(' ');
          }
          eduConfidence = 'high';
          break;
        }
      }
      break;
    }
  }

  // 9. LinkedIn URL
  let linkedinVal = null;
  const linkedinRegex = /linkedin\.com\/in\/[a-zA-Z0-9_-]+/gi;
  const linkedinMatches = rawText.match(linkedinRegex);
  if (linkedinMatches) {
    linkedinVal = linkedinMatches[0].trim();
    if (!linkedinVal.startsWith('http')) {
      linkedinVal = 'https://' + linkedinVal;
    }
  }

  // 10. GitHub URL
  let githubVal = null;
  const githubRegex = /github\.com\/[a-zA-Z0-9_-]+/gi;
  const githubMatches = rawText.match(githubRegex);
  if (githubMatches) {
    for (const match of githubMatches) {
      const cleanUrl = match.trim();
      if (!cleanUrl.includes('/features') && !cleanUrl.includes('/about') && !cleanUrl.includes('/pricing')) {
        githubVal = cleanUrl;
        if (!githubVal.startsWith('http')) {
          githubVal = 'https://' + githubVal;
        }
        break;
      }
    }
  }

  // 11. Summary / About
  let summaryVal = null;
  const summaryHeaders = ['Summary', 'About', 'About Me', 'Profile', 'Objective', 'Career Objective', 'Professional Summary'];
  for (const header of summaryHeaders) {
    const headerRegex = new RegExp(`\\b${header}\\b`, 'i');
    const idx = rawText.search(headerRegex);
    if (idx !== -1) {
      const afterHeader = rawText.slice(idx + header.length).trim();
      const lines = afterHeader.split('\n');
      const summaryLines = [];
      let charCount = 0;

      for (const line of lines) {
        const trimmed = line.trim();
        // Stop if we hit another header or separator line
        const isNextHeader = trimmed === trimmed.toUpperCase() && trimmed.length > 4 && /^[a-zA-Z\s]+$/.test(trimmed);
        
        const commonHeaders = [
          'Technical Skills', 'Skills', 'Work Experience', 'Experience', 'Education',
          'Projects', 'Certifications', 'Languages', 'Employment History', 'Professional Experience'
        ];
        const isCommonHeader = commonHeaders.some(h => new RegExp(`^${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i').test(trimmed));

        const isSeparator = /^[=\-_*#\s]{3,}$/.test(trimmed);
        if (isNextHeader || isCommonHeader || isSeparator) {
          break;
        }
        summaryLines.push(line);
        charCount += line.length;
        if (charCount > 500) break;
      }

      summaryVal = summaryLines.join('\n').slice(0, 500).trim();
      break;
    }
  }

  return {
    name: nameVal ? { value: nameVal, confidence: nameConfidence, method: nameMethod } : null,
    email: emailVal ? { value: emailVal, confidence: 'high' } : null,
    phone: phoneVal ? { value: phoneVal, confidence: 'high' } : null,
    location: locVal ? { value: locVal, confidence: locConfidence } : null,
    experience: expVal !== null ? { value: expVal, unit: 'years', confidence: expConfidence, method: expMethod } : null,
    jobTitle: titleVal ? { value: titleVal, confidence: titleConfidence } : null,
    skills: skillsArray.length > 0 ? { value: skillsArray, confidence: 'high' } : null,
    education: eduVal ? { value: eduVal, institution: eduInst, confidence: eduConfidence } : null,
    linkedin: linkedinVal ? { value: linkedinVal, confidence: 'high' } : null,
    github: githubVal ? { value: githubVal, confidence: 'high' } : null,
    summary: summaryVal ? { value: summaryVal, confidence: 'high' } : null,
  };
}

module.exports = { parseResume };
