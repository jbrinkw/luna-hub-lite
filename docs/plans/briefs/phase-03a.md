# Phase 03a: Auth Flow

> Previous: phase-02.md | Next: phase-03b.md

## Skills

test-driven-development, context7 (Supabase Auth, Ionic React), frontend-design

## Build

- `apps/web/src/pages/Login.tsx` — email/password form via Supabase Auth signInWithPassword
- `apps/web/src/pages/Signup.tsx` — email/password + display_name form via Supabase Auth signUp (display_name as user metadata)
- `apps/web/src/components/AuthGuard.tsx` — redirect unauthenticated to /login, render children when authed, loading state
- Logout flow — button in layout header, calls supabase.auth.signOut, clears session
- Wire auth into `apps/web/src/App.tsx` routes — public: /login, /signup; protected: everything else via AuthGuard

## Test (TDD)

### Unit: `apps/web/src/__tests__/unit/hub/AuthGuard.test.tsx`

- When authenticated -> renders children
- When not authenticated -> redirects to /login (via react-router navigate)
- When loading (session check in progress) -> renders loading indicator
- When session expires during render -> redirects to /login

### Unit: `apps/web/src/__tests__/unit/hub/LoginForm.test.tsx`

- Empty email -> shows validation error on submit
- Empty password -> shows validation error on submit
- Valid inputs -> calls supabase.auth.signInWithPassword with correct args
- Supabase returns error -> displays error message to user
- Supabase returns session -> calls navigate to /hub
- Submit button disabled while request in flight

### Unit: `apps/web/src/__tests__/unit/hub/SignupForm.test.tsx`

- Empty display_name -> shows validation error
- Empty email -> shows validation error
- Empty password -> shows validation error
- Valid inputs -> calls supabase.auth.signUp with correct args
- Display_name passed as user metadata
- Supabase returns error (duplicate email) -> shows error message
- Success -> navigates to /hub

### Integration: `apps/web/src/__tests__/integration/hub/auth-lifecycle.test.ts`

- Sign up with email/password -> profile auto-created with defaults (timezone='America/New_York', day_start_hour=6)
- Sign up -> display_name stored in profile from metadata
- Login with correct credentials -> returns valid session
- Login with wrong password -> returns error
- Logout -> session cleared, subsequent calls rejected
- Duplicate email signup -> returns error
- Session token refresh works
- Password reset: request reset -> verify reset email sent (via Supabase admin API or mock)
- Password reset: apply new password -> can login with new password

### Browser: `apps/web/e2e/hub/auth.spec.ts`

- Visit / -> redirected to /login (auth guard)
- Fill login form with valid credentials -> submit -> redirected to /hub
- Fill login form with invalid password -> error message shown, stays on /login
- Visit /signup -> fill form (display_name, email, password) -> submit -> redirected to /hub
- Signup with duplicate email -> error message shown
- Click logout button -> redirected to /login
- After logout, visit /hub -> redirected to /login (session cleared)
- Visit /coach without login -> redirected to /login
- Visit /chef without login -> redirected to /login

## Legacy Reference

- `legacy/chefbyte-vercel/apps/web/src/contexts/AuthContext.tsx` — useAuth() hook, Supabase session management
- `legacy/chefbyte-vercel/apps/web/src/pages/Login.tsx` — email/password form layout
- `legacy/chefbyte-vercel/apps/web/src/pages/Signup.tsx` — registration form layout
- `legacy/chefbyte-vercel/apps/web/src/components/ProtectedRoute.tsx` — redirect if not authed
- `legacy/luna-hub/hub_ui/src/context/AuthContext.jsx` — session validation pattern

## Commit

`feat: auth flow (login, signup, guard, logout)`

## Acceptance

- [ ] Can sign up with email/password -> redirected to /hub
- [ ] Profile auto-created with defaults (timezone='America/New_York', day_start_hour=6)
- [ ] Can log in -> sees Hub page
- [ ] Can log out -> redirected to /login
- [ ] Unauthenticated -> redirected to /login
- [ ] All unit tests pass: `pnpm --filter web test -- run src/__tests__/unit/hub/AuthGuard src/__tests__/unit/hub/LoginForm src/__tests__/unit/hub/SignupForm`
- [ ] Integration tests pass: `pnpm --filter web test -- -c vitest.integration.config.ts run src/__tests__/integration/hub/auth-lifecycle`
- [ ] Browser tests pass: `pnpm --filter web exec playwright test e2e/hub/auth.spec.ts`
- [ ] `pnpm typecheck` passes
