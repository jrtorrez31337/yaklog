// CSP header middleware for /dashboard/* routes per PLAN-DASHBOARD-OPERATOR-DM
// v2 §2.9.2 + secops FLAG-1 absorbed canonical pre-Gate-3 substrate-discipline.
//
// Rationale: sessionStorage holds operator-bearer at Phase 1; any XSS on
// dashboard-tier code could exfiltrate the bearer. CSP `default-src 'self';
// script-src 'self'` blocks inline scripts + cross-origin script sources →
// shrinks the XSS attack surface to dashboard.js itself.
//
// Phase 2 hard-gate per PLAN §2.9.3: HttpOnly cookie transition before any
// read-pane or non-localhost browser deployment.

'use strict';

function dashboardCspMiddleware(req, res, next) {
  // Apply CSP only to dashboard surfaces (not API JSON or SSE).
  // path may be /dashboard, /dashboard/, /dashboard/login, etc.
  if (req.path === '/dashboard' || req.path.startsWith('/dashboard/')) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'"
    );
    // Defense-in-depth: prevent the dashboard from being framed (clickjacking)
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
  next();
}

module.exports = { dashboardCspMiddleware };
