# Project Instructions & Conventions

## Security First
- **Secrets & API Keys:** NEVER hardcode API keys, secrets, or sensitive configuration in source code. Always use environment variables (`import.meta.env` for Vite client-side, `process.env` or Cloud Secrets for server-side/functions).
- **Environment Variables:** When adding new configuration, always update `.env.example` with placeholders.
- **Data Validation:** Always validate user input on both the client and via Firestore Security Rules.
- **AI Safety:** Use clear delimiters and strict system instructions in AI service calls (e.g., Gemini API) to prevent prompt injection attacks.

## README.md
Create and maintain README.md file whenever there’s changes. This file is user friendly and tells how to use the app from the user point of view.

## DESIGN.md
Create and maintain a DESIGN.md file whenever there’s changes. This file explains the system design details of this code which can be reviewed by the senior engineer for a code review and system design interview.
