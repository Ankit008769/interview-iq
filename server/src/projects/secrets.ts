// Secret scanning for uploaded projects (roadmap C4). Files that usually hold credentials are dropped whole;
// in every other file each secret value is replaced before the text is stored, indexed or sent to a model.
// Findings keep only the file, line and kind, never the value, so people can rotate what they uploaded.
export type SecretFinding = { path: string; line: number; kind: string };

// Matched against the file name (not the folder).
const SECRET_FILES = [/^\.env(\..*)?$/i, /\.(pem|key|p12|pfx|jks|keystore|ppk|asc|gpg)$/i, /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials|htpasswd)$/i, /^credentials(\.json)?$/i, /service[-_]?account.*\.json$/i, /^secrets?\.(json|ya?ml|toml)$/i,
  /^\.docker(cfg|config\.json)$/i, /^terraform\.tfstate(\.backup)?$/i];
export const isSecretFile = (name: string) => SECRET_FILES.some(p => p.test(name));

// `value` names the capture group that is the secret; without it the whole match is.
type Rule = { kind: string; pattern: RegExp; value?: number };
const RULES: Rule[] = [
  { kind: 'private key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g },
  { kind: 'AWS access key', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  { kind: 'AWS secret key', pattern: /\baws[_-]?(?:secret[_-]?(?:access[_-]?)?key|session[_-]?token)\b["']?\s*[:=]\s*["']?([A-Za-z0-9/+=]{40,})/gi, value: 1 },
  { kind: 'GitHub token', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g },
  { kind: 'GitLab token', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'Slack token', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { kind: 'Slack webhook', pattern: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]+/g },
  { kind: 'Google API key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'Stripe key', pattern: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{16,}\b/g },
  { kind: 'Anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'OpenAI key', pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'SendGrid key', pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { kind: 'Twilio key', pattern: /\bSK[0-9a-f]{32}\b/g },
  { kind: 'npm token', pattern: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { kind: 'Azure storage key', pattern: /\bAccountKey=([A-Za-z0-9+/=]{40,})/g, value: 1 },
  { kind: 'JSON web token', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  // Credentials inside a connection string: only the user:password part is removed.
  { kind: 'connection string password', pattern: /\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|mariadb|redis|rediss|amqps?|mssql|ftp|sftp|https?):\/\/([^\s:@/'"`]+:[^\s@/'"`]+)@/gi, value: 1 },
  // Quoted values assigned to names that sound secret, such as password = "hunter22" or "apiKey": "...".
  { kind: 'hard-coded secret', pattern: /\b(?:[A-Za-z0-9_]*(?:password|passwd|pwd|secret|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|private[_-]?key|signing[_-]?key|encryption[_-]?key))\b["']?\s*(?:[:=]|=>)\s*["'`]([^"'`\s]{8,})["'`]/gi, value: 1 },
];
// Values that are clearly placeholders or references, not secrets.
const PLACEHOLDER = /^(?:x+|\*+|\.+|<[^>]*>|\$\{?[A-Za-z_][\w.]*\}?|%[A-Za-z_]+%|\{\{[^}]*\}\}|(?:your|my|example|sample|dummy|test|fake|changeme|change[_-]?me|placeholder|replace|todo|secret|password)[\w-]*|process\.env\.\w+|os\.environ.*|env\(.*)$/i;

export function scanSecrets(path: string, text: string): { text: string; findings: SecretFinding[] } {
  const findings: SecretFinding[] = [];
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match: string, ...rest: unknown[]) => {
      const offset = rest.at(-2) as number;
      const whole = rest.at(-1) as string;
      const value = rule.value ? String(rest[rule.value - 1] ?? '') : match;
      if (!value || (rule.kind === 'hard-coded secret' && PLACEHOLDER.test(value))) return match;
      const start = offset + match.indexOf(value);
      findings.push({ path, line: whole.slice(0, start).split('\n').length, kind: rule.kind });
      const replacement = `[redacted ${rule.kind}]`;
      // A private key spans lines; keep the line count so line numbers elsewhere in the file stay right.
      const newlines = '\n'.repeat((value.match(/\n/g) ?? []).length);
      return match.replace(value, replacement + newlines);
    });
  }
  return { text: out, findings: findings.sort((a, b) => a.line - b.line) };
}
