# Plan: Authentication & Authorization System

> Source PRD: `docs/prds/001-authentication-system.md`

## Architectural decisions

Durable decisions that apply across all phases:

- **Database**: PostgreSQL 16 via `docker-compose.yml` at project root, Prisma ORM in `apps/server`
- **Schema**:
  - `User`: `id` (UUID), `email` (unique, lowercase), `passwordHash`, `emailVerified` (boolean, default false), `createdAt`, `updatedAt`
  - `Session`: `id` (UUID), `userId` (FK -> User), `expiresAt` (24h), `createdAt`
  - `VerificationToken`: `id`, `userId`, `token` (unique, crypto random), `type` (enum: `EMAIL_VERIFICATION` | `PASSWORD_RESET`), `expiresAt`, `createdAt`
- **Routes**:
  - `POST /api/auth/register`
  - `POST /api/auth/login`
  - `POST /api/auth/logout`
  - `GET /api/auth/verify-email?token=...`
  - `POST /api/auth/forgot-password`
  - `POST /api/auth/reset-password`
  - `GET /api/auth/me`
- **Sessions**: Server-side in PostgreSQL, session ID in HTTP-only / Secure / SameSite=Lax cookie, 24h expiry
- **Passwords**: bcrypt with cost factor 12, min 8 chars + 1 number + 1 special character
- **Email**: Resend SDK, API key via `RESEND_API_KEY` env var
- **Frontend pages**: `/login`, `/register`, `/verify-email`, `/forgot-password`, `/reset-password`
- **Shared types**: Auth request/response types and password validation in `packages/shared`
- **UI**: Tailwind CSS in `apps/web`

---

## Phase 1: User Registration

**User stories**: 1, 2, 3, 4, 29, 30

### What to build

Set up the persistence layer and build the registration flow end-to-end. Add PostgreSQL via Docker Compose, initialize Prisma with the User table, and create the `POST /api/auth/register` endpoint that validates input, hashes the password, and stores the user. On the frontend, add Tailwind CSS and build the `/register` page with email, password, and confirm password fields that validate client-side before submitting. Add shared auth types and a password validation utility to `packages/shared` so both sides enforce the same rules. Create `.env.example` documenting required environment variables.

### Acceptance criteria

- [ ] `docker-compose.yml` at project root starts PostgreSQL 16 with a named volume
- [ ] `.env.example` documents `DATABASE_URL`, `RESEND_API_KEY`, `SESSION_SECRET`
- [ ] Prisma is initialized in `apps/server` with a User model matching the schema
- [ ] `POST /api/auth/register` validates input, hashes password (bcrypt, cost 12), creates user, returns success
- [ ] Server rejects invalid email, weak password, and duplicate email with appropriate error responses
- [ ] `packages/shared` exports password validation logic and auth-related types
- [ ] `/register` page renders with Tailwind CSS styling — email, password, confirm password fields
- [ ] Client-side validation shows errors for invalid email, weak password, and mismatched passwords before submission
- [ ] Form shows a loading state while submitting
- [ ] Successful registration redirects to `/verify-email` (placeholder page for now)

---

## Phase 2: Login & Sessions

**User stories**: 10, 11, 12, 13, 14, 25

### What to build

Add the Session table to the Prisma schema and build the login flow. Create `POST /api/auth/login` which validates credentials, checks the user exists, compares the password hash, creates a session row, and sets an HTTP-only cookie. Create `GET /api/auth/me` which reads the session cookie, looks up the session, and returns the current user. Build an auth middleware for Express that validates the session on protected routes. On the frontend, build the `/login` page with email and password fields, a link to register, and a link to forgot password. Login errors use a generic "Invalid email or password" message.

### Acceptance criteria

- [ ] Session model added to Prisma schema with migration
- [ ] `POST /api/auth/login` authenticates user, creates session, sets HTTP-only / Secure / SameSite=Lax cookie
- [ ] Login rejects unverified users with a message to check their email (wired up fully in Phase 4, but the check is present)
- [ ] `GET /api/auth/me` returns the current user from the session cookie, or 401
- [ ] Auth middleware validates session and attaches user to the request object
- [ ] Sessions last 24 hours; expired sessions return 401
- [ ] Multiple concurrent sessions are supported (multi-device)
- [ ] `/login` page renders with Tailwind CSS — email + password fields, links to register and forgot password
- [ ] Login errors display "Invalid email or password" without revealing which field is wrong
- [ ] Form shows a loading state while submitting
- [ ] Successful login redirects to the home page

---

## Phase 3: Logout & Auth Guard

**User stories**: 15, 16, 17, 23, 24

### What to build

Add the logout endpoint and protect the application behind authentication. `POST /api/auth/logout` deletes the current session from the database and clears the cookie. On the frontend, add a logout button to protected pages. Build an auth guard (Next.js middleware or layout wrapper) that checks `GET /api/auth/me` — if unauthenticated, redirect to `/login?redirect=<original_path>`. After successful login, redirect back to the original destination.

### Acceptance criteria

- [ ] `POST /api/auth/logout` deletes the session row and clears the cookie
- [ ] Logging out on one device does not affect sessions on other devices
- [ ] A logout button is visible on protected pages and triggers the logout flow
- [ ] Unauthenticated users are redirected to `/login` when accessing any protected route
- [ ] The redirect URL is preserved via `?redirect=` query parameter
- [ ] After login, the user is redirected back to their original destination
- [ ] Auth pages (`/login`, `/register`, etc.) remain accessible without authentication

---

## Phase 4: Email Verification

**User stories**: 5, 6, 7, 8, 9

### What to build

Add the VerificationToken table and integrate Resend to send verification emails. When a user registers (Phase 1 endpoint), generate a cryptographically random token, store it with a 24-hour expiry, and send a verification email via Resend. `GET /api/auth/verify-email?token=...` looks up the token, checks expiry, sets `emailVerified: true`, deletes the token, and redirects to `/login` with a success message. Update the `/verify-email` page to show "Check your email" after registration and handle the token verification redirect. Allow unverified users to request a new verification email.

### Acceptance criteria

- [ ] VerificationToken model added to Prisma schema with migration
- [ ] Email service module wraps Resend SDK for sending verification and reset emails
- [ ] Registration generates a verification token (crypto.randomBytes) with 24h expiry and sends email
- [ ] `GET /api/auth/verify-email?token=...` verifies the token, marks user as verified, deletes the token
- [ ] Expired tokens return an error with an option to resend
- [ ] Verified users are redirected to `/login` with a success message
- [ ] `/verify-email` page shows "Check your email" after registration
- [ ] Unverified users who try to log in see a message to verify their email, with a resend option
- [ ] Tokens are single-use — deleted after consumption

---

## Phase 5: Password Reset

**User stories**: 18, 19, 20, 21, 22

### What to build

Build the forgot-password and reset-password flows using the VerificationToken table (with `PASSWORD_RESET` type). `POST /api/auth/forgot-password` generates a reset token with 1-hour expiry and sends an email — always returns success regardless of whether the email exists. `POST /api/auth/reset-password` validates the token, hashes the new password, updates the user, deletes all sessions for that user, and deletes the token. On the frontend, build `/forgot-password` (email input) and `/reset-password` (new password input, accessed via token link). Add a "Forgot password?" link on the login page.

### Acceptance criteria

- [ ] `POST /api/auth/forgot-password` generates a reset token (1h expiry), sends email, always returns success
- [ ] `POST /api/auth/reset-password` validates token + expiry, updates password, deletes all user sessions, deletes token
- [ ] Password validation rules are enforced on the reset form (client and server)
- [ ] `/forgot-password` page accepts an email and shows a confirmation message
- [ ] `/reset-password` page accepts a new password (with validation) and redirects to `/login` on success
- [ ] Expired or invalid tokens show an error with guidance
- [ ] All existing sessions are invalidated after a password reset
- [ ] "Forgot password?" link is present on the login page

---

## Phase 6: Rate Limiting & CSRF Protection

**User stories**: 26, 27, 28

### What to build

Add security hardening across the auth endpoints. Install `express-rate-limit` and configure per-endpoint rate limits: login (5 attempts / 15 min per IP), registration (3 / 15 min), forgot-password (3 / 15 min). Implement CSRF protection using the double-submit cookie pattern for all state-changing auth requests. Add a periodic cleanup mechanism for expired sessions and tokens.

### Acceptance criteria

- [ ] `express-rate-limit` is configured with per-route limits: login 5/15min, register 3/15min, forgot-password 3/15min
- [ ] Rate-limited requests receive a 429 response with a clear message
- [ ] CSRF protection is implemented via double-submit cookie pattern on all POST auth endpoints
- [ ] Frontend includes the CSRF token in state-changing requests
- [ ] Expired sessions are cleaned up periodically
- [ ] Expired verification/reset tokens are cleaned up periodically
