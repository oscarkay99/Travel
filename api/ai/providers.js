'use strict';

const DEFAULT_TIMEOUT_MS = 25_000;
const GEMINI_BASE_URL = process.env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODELS =
  'gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite,gemini-3.1-flash-lite';

function csv(value, fallback) {
  return (value || fallback)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const shared = {
  type: 'gemini',
  baseUrl: GEMINI_BASE_URL,
  timeoutMs: positiveNumber(process.env.AI_REQUEST_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  cooldownMs: positiveNumber(process.env.AI_PROVIDER_COOLDOWN_MS, 60_000)
};

const providers = Object.fromEntries(
  Array.from({ length: 5 }, (_, index) => {
    const slot = index + 1;
    const name = `gemini_project_${slot}`;

    return [name, {
      name,
      slot,
      apiKey: process.env[`GEMINI_API_KEY_${slot}`],
      models: csv(process.env[`GEMINI_MODELS_${slot}`], process.env.GEMINI_MODELS || DEFAULT_MODELS),
      ...shared
    }];
  })
);

const defaultOrder = Object.keys(providers).join(',');
const requestedOrder = csv(process.env.AI_PROVIDER_ORDER, defaultOrder);
const providerOrder = [...new Set(requestedOrder)].filter((name) => providers[name]);

module.exports = { providers, providerOrder };
