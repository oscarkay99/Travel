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
    return '**Refund eligibility:** You qualify only if your offer is not received within 3–6 months.\n\nFor the required evidence, refund steps and processing time, one of our authorised advisers will guide you personally.';
  }

  if (/\b(first payment|initial payment|€\s?3,?000|eur\s?3,?000)\b/.test(text)) {
    return '**First payment:** €3,000\n\nIt becomes due immediately after you submit your documents. Before making payment, please verify the official account details and payment reference directly with an authorised Rogernort adviser.';
  }

  if (/\b(total cost|full cost|complete cost|programme cost|program cost|€\s?6,?000|eur\s?6,?000)\b/.test(text) &&
      !/\b(include|includes|cover|breakdown)\b/.test(text)) {
    return '**Confirmed programme cost:** €6,000\n\nThis is the complete cost for the Czech Republic programme. An authorised adviser will provide the itemised breakdown and verified payment instructions before you pay.';
  }

  if (/\b(passport)\b/.test(text) && /\b(apply|application|before|without|need|required)\b/.test(text)) {
    return '**A valid passport is required before you apply.**\n\nThe application needs a passport number, so we cannot begin without one. For your safety, please don’t send the number or a copy of your passport in this chat.';
  }

  if (/\b(ban|banned|blacklist|blacklisted)\b/.test(text)) {
    return '**Applicants who are banned from Europe cannot apply for this programme.**\n\nIf you are unsure about your status, a Rogernort adviser can explain how it is verified before you proceed.';
  }

  if (/\b(dubai)\b/.test(text) && /\b(price|cost|per person|airport|depart|departure|accra)\b/.test(text)) {
    return '**Dubai package:** USD 1,200–2,000 per person\n\nDeparture is from Accra. Your final price and availability will depend on your preferred travel dates, so we’ll confirm those before booking.';
  }

  if (/\b(gcb)\b/.test(text) && /\b(belong|belongs|owned|owner|official)\b/.test(text) &&
      !/\b(account number|details|pay|payment instruction|send money)\b/.test(text)) {
    return '**Yes, the official GCB account belongs directly to Rogernort.**\n\nFor your security, please obtain and verify the exact account number and payment reference with an authorised adviser before sending money.';
  }

  if (/\b(country|countries|opportunity|programme|program)\b/.test(text) &&
      /\b(active|available|current|currently|only)\b/.test(text)) {
    return '**Yes. The Czech Republic is our only currently active country programme.**\n\nIt covers unskilled factory and warehouse roles. Would you like me to show you the requirements or help you arrange a free consultation?';
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
