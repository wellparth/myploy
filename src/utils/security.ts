/**
 * Security and sanitization utilities to prevent command injection,
 * path traversal, and configuration poisoning.
 */

export function escapeShellArg(arg: string): string {
  // Wrap in single quotes and replace single quotes with '\''
  return `'${String(arg).replace(/'/g, "'\\''")}'`;
}

export function sanitizeDomain(domain: string): string {
  const trimmed = domain.trim().toLowerCase();
  // Validates standard FQDN (e.g. app.example.com, localhost)
  const domainRegex = /^(localhost|([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,})$/i;
  if (!domainRegex.test(trimmed)) {
    throw new Error(`Security validation failed: Invalid domain name "${domain}".`);
  }
  return trimmed;
}

export function sanitizeAppName(name: string): string {
  const sanitized = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/^-+|-+$/g, '');
  if (!sanitized || sanitized.length > 63) {
    throw new Error(`Security validation failed: Invalid application name "${name}". Must be 1-63 alphanumeric characters.`);
  }
  return sanitized;
}

export function sanitizePath(uriPath: string): string {
  const trimmed = uriPath.trim();
  if (!trimmed.startsWith('/')) {
    return `/${trimmed}`;
  }
  // Strip control characters, quotes, and shell metacharacters
  return trimmed.replace(/[^\w\d_.\-/?=&%+]/g, '');
}

export function sanitizeGitRef(ref: string): string {
  const trimmed = ref.trim();
  // Disallow options starting with dash (prevent git argument injection)
  if (trimmed.startsWith('-')) {
    throw new Error(`Security validation failed: Git ref cannot start with a dash ("${ref}").`);
  }
  // Enforce valid git branch/tag character set
  const refRegex = /^[a-zA-Z0-9_.\-\/]+$/;
  if (!refRegex.test(trimmed)) {
    throw new Error(`Security validation failed: Invalid characters in git ref "${ref}".`);
  }
  return trimmed;
}

export function sanitizeInteger(val: string | number, defaultVal = 0): number {
  const parsed = typeof val === 'number' ? val : parseInt(String(val), 10);
  if (isNaN(parsed) || parsed < 0) {
    return defaultVal;
  }
  return parsed;
}
