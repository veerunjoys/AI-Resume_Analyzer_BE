const { parseResume } = require('../resumeParser');

describe('Resume Parser Module Tests', () => {
  test('should extract all fields from fake resume text', () => {
    const fakeResumeText = `Rahul Sharma
Senior Software Engineer
rahul.sharma@gmail.com | +91 9876543210 | Pune, Maharashtra
linkedin.com/in/rahul-sharma | github.com/rahulsharma

Professional Summary
Experienced full-stack software engineer with 6 years of experience
building scalable web applications. Passionate about clean code,
system design, and delivering high-quality products.

Technical Skills
Languages: JavaScript, TypeScript, Python
Frontend: React, Next.js, HTML, CSS, Tailwind
Backend: Node.js, Express, NestJS
Databases: PostgreSQL, MongoDB, Redis
DevOps: Docker, AWS, GitHub Actions, Nginx
Tools: Git, Jira, Postman, Figma

Work Experience

Senior Software Engineer — TechCorp India Pvt Ltd
June 2021 — Present | Pune, Maharashtra
- Led development of a recruiter platform handling 100k+ candidates
- Built custom virtualization for large data lists
- Implemented WebSocket-based real-time collaboration

Software Engineer — StartupXYZ
July 2018 — May 2021 | Mumbai, Maharashtra
- Developed REST APIs using Node.js and Express
- Managed PostgreSQL databases with 10M+ records
- Deployed applications on AWS EC2 and S3

Education
B.Tech in Computer Science Engineering
IIT Bombay | 2014 — 2018 | CGPA: 8.7/10`;

    const parsed = parseResume(fakeResumeText);

    expect(parsed.name.value).toBe('Rahul Sharma');
    expect(parsed.email.value).toBe('rahul.sharma@gmail.com');
    expect(parsed.phone.value).toBe('+919876543210');
    expect(parsed.location.value).toBe('Pune, Maharashtra');
    expect(parsed.experience.value).toBe(6);
    expect(parsed.jobTitle.value).toBe('Senior Software Engineer');
    
    const skills = parsed.skills.value;
    expect(skills).toContain('React');
    expect(skills).toContain('Node.js');
    expect(skills).toContain('PostgreSQL');
    expect(skills).toContain('Docker');
    expect(skills).toContain('AWS');
    expect(skills).toContain('TypeScript');
    expect(skills).toContain('Python');
    expect(skills).toContain('MongoDB');
    expect(skills).toContain('Redis');

    expect(parsed.education.value).toBe('B.Tech in Computer Science Engineering');
    expect(parsed.education.institution).toBe('IIT Bombay');
    expect(parsed.linkedin.value).toBe('https://linkedin.com/in/rahul-sharma');
    expect(parsed.github.value).toBe('https://github.com/rahulsharma');
    expect(parsed.summary.value).toBe('Experienced full-stack software engineer with 6 years of experience\nbuilding scalable web applications. Passionate about clean code,\nsystem design, and delivering high-quality products.');
  });

  test('should return null for missing fields on minimal resume', () => {
    const minimalText = `Jane Doe\njane.doe@gmail.com`;
    const parsed = parseResume(minimalText);

    expect(parsed.name.value).toBe('Jane Doe');
    expect(parsed.email.value).toBe('jane.doe@gmail.com');
    expect(parsed.phone).toBeNull();
    expect(parsed.location).toBeNull();
    expect(parsed.experience).toBeNull();
    expect(parsed.jobTitle).toBeNull();
    expect(parsed.skills).toBeNull();
    expect(parsed.education).toBeNull();
    expect(parsed.linkedin).toBeNull();
    expect(parsed.github).toBeNull();
    expect(parsed.summary).toBeNull();
  });
});
