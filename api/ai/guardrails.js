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

function confirmedBusinessAnswer(message) {
  const text = message.toLowerCase();

  if (/\b(refund|refundable|money back)\b/.test(text) &&
      !/\b(procedure|process|evidence|proof|how long|processing time)\b/.test(text)) {
    return 'A refund qualifies only if the client’s offer is not received within 3–6 months. The refund procedure and processing time must be confirmed with an authorised Rogernort adviser.';
  }

  if (/\b(first payment|initial payment|€\s?3,?000|eur\s?3,?000)\b/.test(text)) {
    return 'The first payment is €3,000 and is due immediately after the applicant submits their documents. Confirm the official payment details directly with an authorised Rogernort adviser before paying.';
  }

  if (/\b(total cost|full cost|complete cost|programme cost|program cost|€\s?6,?000|eur\s?6,?000)\b/.test(text) &&
      !/\b(include|includes|cover|breakdown)\b/.test(text)) {
    return 'The confirmed complete Czech Republic programme cost is €6,000. A Rogernort adviser must confirm the itemised cost breakdown and official payment instructions.';
  }

  if (/\b(passport)\b/.test(text) && /\b(apply|application|before|without|need|required)\b/.test(text)) {
    return 'No. A valid passport is required before applying because the passport number is needed for the application. Do not send your passport number or passport document in this chat.';
  }

  if (/\b(ban|banned|blacklist|blacklisted)\b/.test(text)) {
    return 'An applicant who is banned from Europe cannot apply for the programme. A Rogernort adviser must confirm how that status is checked.';
  }

  if (/\b(dubai)\b/.test(text) && /\b(price|cost|per person|airport|depart|departure|accra)\b/.test(text)) {
    return 'The indicative Dubai package price is USD 1,200–2,000 per person, departing from Accra. Final pricing and availability must be confirmed for the requested travel dates.';
  }

  if (/\b(gcb)\b/.test(text) && /\b(belong|belongs|owned|owner|official)\b/.test(text) &&
      !/\b(account number|details|pay|payment instruction|send money)\b/.test(text)) {
    return 'Yes. Rogernort has confirmed that the GCB account belongs directly to Rogernort. For security, obtain and verify the exact account details and payment reference with an authorised adviser before paying.';
  }

  if (/\b(country|countries|opportunity|programme|program)\b/.test(text) &&
      /\b(active|available|current|currently|only)\b/.test(text)) {
    return 'Yes. The Czech Republic is the only currently active country programme. It covers unskilled factory and warehouse roles; confirm current vacancy availability with a Rogernort adviser.';
  }

  return null;
}

function requiresHumanConfirmation(message) {
  const text = message.toLowerCase();
  const rules = [
    /\b(refund|refundable)\b.{0,30}\b(procedure|process|evidence|proof|how long|processing time)\b/,
    /\b(bank account|account number|payment instruction|send money|pay now)\b/,
    /\bgcb\b.{0,30}\b(account|details|pay|payment)\b/,
    /\b(€\s?6,?000|eur\s?6,?000|programme cost|program cost)\b.{0,30}\b(include|includes|cover|breakdown)\b/,
    /\b(job|vacancy|position|recruitment)\b.{0,30}\b(available|open|active|current|now)\b/,
    /\b(available|open|active|current)\b.{0,30}\b(job|vacancy|position|recruitment)\b/
  ];
  return rules.some((rule) => rule.test(text));
}

function safeFallback() {
  return 'This detail requires confirmation from a Rogernort adviser. Would you like to book a free consultation?';
}

module.exports = { confirmedBusinessAnswer, redactSensitiveData, requiresHumanConfirmation, safeFallback };
