'use strict';

const REDACTION_RULES = [
  { label: 'Ghana Card number', pattern: /\bGHA[- ]?\d{9}[- ]?\d\b/gi },
  { label: 'email address', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi },
  { label: 'phone number', pattern: /(?<!\d)(?:\+?233|0)[ -]?(?:\d[ -]?){9}(?!\d)/g },
  { label: 'payment card number', pattern: /\b(?:\d[ -]*?){13,19}\b/g },
  {
    label: 'passport number',
    pattern: /\b(passport(?:\s+(?:number|no\.?))?\s*[:#-]?\s*)[A-Z0-9]{6,12}\b/gi,
    preservePrefix: true
  }
];

function redactSensitiveData(value) {
  let text = String(value || '');
  const redactions = [];

  for (const rule of REDACTION_RULES) {
    text = text.replace(rule.pattern, (match, prefix) => {
      redactions.push(rule.label);
      return rule.preservePrefix && prefix
        ? `${prefix}[REDACTED ${rule.label}]`
        : `[REDACTED ${rule.label}]`;
    });
  }

  return { text, redactions: [...new Set(redactions)] };
}

function requiresHumanConfirmation(message) {
  const text = message.toLowerCase();
  const rules = [
    /\b(refund|refundable|money back|cancellation fee)\b/,
    /\b(bank account|account number|gcb|payment instruction|send money|pay now)\b/,
    /\b(total cost|full cost|€\s?6000|eur\s?6000|first payment|deposit)\b/,
    /\b(job|vacancy|position|recruitment)\b.{0,30}\b(available|open|active|current|now)\b/,
    /\b(available|open|active|current)\b.{0,30}\b(job|vacancy|position|recruitment)\b/
  ];
  return rules.some((rule) => rule.test(text));
}

function safeFallback() {
  return 'This detail requires confirmation from a Rogernort adviser. Would you like to book a free consultation?';
}

module.exports = { redactSensitiveData, requiresHumanConfirmation, safeFallback };
