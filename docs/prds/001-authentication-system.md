# PRD: Authentication & Authorization System

## Problem Statement

The application currently has no way to identify or authenticate users. Every page and API endpoint is publicly accessible. We need a complete authentication system so that only registered, verified users can access the application. Users should be able to sign up, verify their email, log in, stay logged in across sessions (24 hours), reset forgotten passwords, and log out — all while following security best practices.

## Solution

Build a full authentication and authorization system spanning the frontend (Next.js), backend (Express), and a new PostgreSQL database. The system uses server-side sessions stored in the database with HTTP-only cookies for security. Email verification and password reset flows are handled via Resend. The entire application is gated behind authentication — unauthenticated users are redirected to the login page. The UI is built with Tailwind CSS and provides a clean, simple experience for login, registration, email verification, and password reset.

## User Stories

1. As a new user, I want to see a registration form with email and password fields, so that I can create an account.
2. As a new user, I want to receive clear validation errors if my email is invalid or my password doesn't meet requirements (min 8 characters, at least 1 number, at least 1 special character), so that I can correct my input before submitting.
3. As a new user, I want the registration form to validate my input on the frontend before sending it to the server, so that I get instant feedback.
4. As a new user, I want the server to also validate my email and password, so that security is enforced regardless of the client.
5. As a new user, I want to receive a verification email after registering, so that I can confirm my email address.
6. As a new user, I want to click a verification link in the email and be redirected to the login page with a success message, so that I know my account is ready.
7. As a new user, I want the verification link to expire after 24 hours, so that stale tokens cannot be abused.
8. As an unverified user, I want to be told that I need to verify my email if I try to log in before verifying, so that I understand why I can't access the app.
9. As an unverified user, I want to be able to request a new verification email if the original expired, so that I can still activate my account.
10. As a registered user, I want to see a login form with email and password fields, so that I can access my account.
11. As a registered user, I want to be logged in automatically after entering valid credentials, so that I can start using the application immediately.
12. As a registered user, I want my session to last 24 hours, so that I don't have to log in every time I visit.
13. As a registered user, I want to remain logged in when I refresh the page or close and reopen the browser, so that my session persists.
14. As a logged-in user, I want to be able to log in from multiple devices or browsers simultaneously, so that I'm not forced to use a single device.
15. As a logged-in user, I want to see a logout button, so that I can explicitly end my session.
16. As a logged-in user, I want logging out to invalidate my session on the server, so that the session cookie can no longer be used.
17. As a logged-in user, I want logging out on one device to not affect my sessions on other devices, so that I stay logged in where I choose.
18. As a user who forgot their password, I want to click a "Forgot password?" link on the login page, so that I can initiate a reset.
19. As a user who forgot their password, I want to enter my email and receive a password reset link, so that I can set a new password.
20. As a user who forgot their password, I want the reset link to expire after 1 hour, so that it can't be used indefinitely.
21. As a user who forgot their password, I want to enter a new password on the reset page (with the same validation rules), so that I can regain access.
22. As a user who reset their password, I want all my existing sessions to be invalidated, so that anyone with access to my old session is logged out.
23. As an unauthenticated user, I want to be redirected to the login page when I try to access any protected route, so that I know I need to sign in.
24. As an unauthenticated user, I want to be redirected back to my original destination after logging in, so that I don't lose context.
25. As a user, I want to see friendly error messages on wrong password or non-existent email (without revealing which one is wrong), so that the system doesn't leak information about registered accounts.
26. As a user, I want login attempts to be rate-limited, so that brute-force attacks are mitigated.
27. As a user, I want registration attempts to be rate-limited, so that spam accounts are mitigated.
28. As a user, I want password reset requests to be rate-limited, so that my inbox isn't flooded by abuse.
29. As a user, I want the login and registration pages to look clean and professional with Tailwind CSS styling, so that the experience feels polished.
30. As a user, I want to see a loading state while forms are submitting, so that I know the action is in progress.

## Implementation Decisions

### Database & ORM

- **PostgreSQL** running in a local Docker container via `docker-compose.yml` at the project root. The setup is designed so that the connection string can later be pointed at a remote PostgreSQL server with no code changes.
- **Prisma** as the ORM, installed in the `apps/server` package. Prisma provides auto-generated TypeScript types, declarative schema, and migration management.

### Database Schema

- **User table**: `id` (UUID), `email` (unique, lowercase), `passwordHash`, `emailVerified` (boolean, default false), `createdAt`, `updatedAt`.
- **Session table**: `id` (UUID), `userId` (FK → User), `expiresAt` (timestamp, 24 hours from creation), `createdAt`. One user can have many sessions (multi-device support).
- **VerificationToken table**: `id`, `userId`, `token` (unique, cryptographically random), `type` (enum: `EMAIL_VERIFICATION` | `PASSWORD_RESET`), `expiresAt`, `createdAt`. Used for both email verification and password reset flows.

### Password Security

- Passwords are hashed using **bcrypt** with a cost factor of 12.
- Passwords must be at least 8 characters, contain at least 1 number, and at least 1 special character.
- Validation is enforced on both the frontend (instant feedback) and the backend (authoritative check).
- On password reset, all existing sessions for that user are invalidated.

### Session Management

- Sessions are stored server-side in the PostgreSQL `Session` table.
- A session ID is sent to the client as an **HTTP-only, Secure, SameSite=Lax** cookie.
- Sessions expire after **24 hours**. Expired sessions are cleaned up periodically.
- Logging out deletes the session row from the database, making the cookie useless.
- Each device/browser gets its own independent session.

### Authentication Flow

- **Register**: POST email + password → validate → hash password → create user → generate verification token → send email via Resend → return success.
- **Verify email**: GET with token → look up token → check expiry → set `emailVerified: true` → delete token → redirect to login.
- **Login**: POST email + password → look up user → check `emailVerified` → compare password hash → create session → set cookie → return success.
- **Logout**: POST → delete session from DB → clear cookie → return success.
- **Forgot password**: POST email → look up user → generate reset token → send email via Resend → return success (always, even if email not found, to prevent enumeration).
- **Reset password**: POST token + new password → validate token + expiry → hash new password → update user → delete all sessions for user → delete token → redirect to login.

### API Endpoints

- `POST /api/auth/register` — Create account
- `POST /api/auth/login` — Log in
- `POST /api/auth/logout` — Log out (authenticated)
- `GET /api/auth/verify-email?token=...` — Verify email
- `POST /api/auth/forgot-password` — Request password reset
- `POST /api/auth/reset-password` — Reset password with token
- `GET /api/auth/me` — Get current user (authenticated, used by frontend to check session)

### Rate Limiting

- Login: **5 attempts per 15 minutes** per IP.
- Registration: **3 attempts per 15 minutes** per IP.
- Forgot password: **3 attempts per 15 minutes** per IP.
- Implemented via `express-rate-limit` middleware.

### Email Service

- **Resend** (free tier — 3,000 emails/month). Used for email verification and password reset emails.
- Resend API key stored in environment variables (`.env`).
- Emails are plain and functional — verification link and reset link with expiry notice.

### Frontend (Next.js + Tailwind CSS)

- **Tailwind CSS** added to the `apps/web` package for all auth-related UI.
- **Pages**:
  - `/login` — Login form (email + password), links to register and forgot password.
  - `/register` — Registration form (email + password + confirm password), link to login.
  - `/verify-email` — Shown after registration ("Check your email"). Also handles the token verification redirect.
  - `/forgot-password` — Email input form to request a reset link.
  - `/reset-password` — New password form (accessed via reset link with token).
- **Auth guard**: A middleware or layout wrapper checks for a valid session (via `GET /api/auth/me`). If unauthenticated, redirect to `/login` with a `?redirect=` query parameter. After login, redirect back.
- **Client-side validation**: Email format and password rules are validated before form submission using standard form validation. Same rules enforced server-side.

### CSRF Protection

- Since the architecture uses HTTP-only cookies for session management, CSRF protection is implemented using the **double-submit cookie pattern** or a CSRF token attached to state-changing requests.

### Shared Types (packages/shared)

- Auth-related request/response types are added to `@ai-app/shared` so both frontend and backend use the same type definitions:
  - `LoginRequest`, `RegisterRequest`, `ResetPasswordRequest`
  - `AuthResponse`, `UserResponse`
  - Password validation utility (shared between frontend and backend)

### Docker Setup

- A `docker-compose.yml` at the project root runs PostgreSQL 16 with a named volume for data persistence.
- Environment variables (`DATABASE_URL`, `RESEND_API_KEY`, `SESSION_SECRET`) configured via `.env` file (git-ignored).
- A `.env.example` file documents required environment variables.

### Modules Overview

1. **Auth middleware** (Express) — Validates session cookie on every request. Attaches user to request object. Returns 401 for unauthenticated requests.
2. **Auth routes** (Express) — All `/api/auth/*` endpoints. Handles registration, login, logout, verification, password reset.
3. **Email service** (Express) — Wraps Resend SDK. Sends verification and reset emails. Isolated module — easy to swap providers later.
4. **Session service** (Express) — Creates, validates, deletes sessions. Handles expiry cleanup.
5. **Password service** (Express) — Hashing, comparison, validation rules. Pure functions, easily testable.
6. **Rate limiter** (Express) — Configurable rate limiting per endpoint group.
7. **Prisma schema & migrations** — Database schema, client generation, migration files.
8. **Auth pages** (Next.js) — Login, register, verify-email, forgot-password, reset-password pages.
9. **Auth guard** (Next.js) — Middleware/layout component that protects routes and handles redirects.
10. **Shared auth types** (packages/shared) — Request/response types and password validation logic.

## Out of Scope

- OAuth / social login (Google, GitHub, etc.) — can be added later.
- Two-factor authentication (2FA / MFA).
- User profile page or account settings.
- Admin panel or user management.
- Email templates with rich HTML — emails will be plain and functional.
- Session management UI (e.g., "view all active sessions" or "log out all devices").
- Account deletion.
- CI/CD pipeline.
- Production deployment or hosting configuration.
- HTTPS / TLS setup (assumed to be handled by the deployment environment).

## Further Notes

- The Docker PostgreSQL setup is intentionally portable. To move to a remote database, only the `DATABASE_URL` environment variable needs to change. No code modifications required.
- Resend's free tier (3,000 emails/month) is sufficient for development and early usage. If the app scales, upgrading is a plan change, not a code change.
- Password reset invalidates all sessions for security — if someone's account is compromised and they reset the password, the attacker is immediately logged out everywhere.
- The generic error message on login ("Invalid email or password") is intentional — it prevents attackers from discovering which emails are registered.
- Verification and reset tokens are cryptographically random (using `crypto.randomBytes`) and single-use (deleted after consumption).
