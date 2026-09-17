'use strict';

const { providers, providerOrder } = require('./providers');

const providerState = new Map();

class AIProvidersExhaustedError extends Error {
  constructor(attempts) {
    super('All configured AI providers are unavailable or exhausted.');
    this.name = 'AIProvidersExhaustedError';
    this.code = 'AI_PROVIDERS_EXHAUSTED';
    this.attempts = attempts;
  }
}

function stateFor(providerName) {
  if (!providerState.has(providerName)) {
    providerState.set(providerName, { failures: 0, cooldownUntil: 0 });
  }
  return providerState.get(providerName);
}

function inCooldown(providerName) {
  return stateFor(providerName).cooldownUntil > Date.now();
}

function recordSuccess(providerName) {
  providerState.set(providerName, { failures: 0, cooldownUntil: 0 });
}

function recordFailure(provider) {
  const state = stateFor(provider.name);
  state.failures += 1;
  state.cooldownUntil = Date.now() + provider.cooldownMs;
}

function normaliseMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError('messages must be a non-empty array.');
  }

  return messages.map(({ role, content }) => {
    if (!['system', 'user', 'assistant'].includes(role) || typeof content !== 'string') {
      throw new TypeError('Each message requires a valid role and string content.');
    }
    return { role, content };
  });
}

async function requestJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const payload = await response.json().catch(() => ({}));

    if (!response.ok) {
      const error = new Error(payload.error?.message || `Provider returned HTTP ${response.status}.`);
      error.status = response.status;
      error.retryAfter = response.headers.get('retry-after');
      throw error;
    }

    return payload;
  } finally {
    clearTimeout(timer);
  }
}

function toGeminiRequest(messages, options) {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const contents = messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }]
    }));

  return {
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents,
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxTokens ?? 1_024
    }
  };
}

async function callGemini(provider, model, messages, options) {
  const encodedModel = encodeURIComponent(model);
  const url = `${provider.baseUrl}/models/${encodedModel}:generateContent`;
  const payload = await requestJson(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': provider.apiKey
    },
    body: JSON.stringify(toGeminiRequest(messages, options))
  }, provider.timeoutMs);

  const text = payload.candidates?.[0]?.content?.parts
    ?.map((part) => part.text || '')
    .join('')
    .trim();

  if (!text) throw new Error('Gemini returned no text response.');
  return { text, usage: payload.usageMetadata || null, raw: payload };
}

async function callOpenAICompatible(provider, model, messages, options) {
  const payload = await requestJson(`${provider.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
      ...(provider.extraHeaders || {})
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: options.temperature ?? 0.2,
      max_tokens: options.maxTokens ?? 1_024
    })
  }, provider.timeoutMs);

  const content = payload.choices?.[0]?.message?.content;
  const text = Array.isArray(content)
    ? content.map((part) => part.text || '').join('').trim()
    : content?.trim();

  if (!text) throw new Error(`${provider.name} returned no text response.`);
  return { text, usage: payload.usage || null, raw: payload };
}

async function callProvider(provider, model, messages, options) {
  return provider.type === 'gemini'
    ? callGemini(provider, model, messages, options)
    : callOpenAICompatible(provider, model, messages, options);
}

async function generate(messages, options = {}) {
  const safeMessages = normaliseMessages(messages);
  const attempts = [];

  for (const providerName of providerOrder) {
    const provider = providers[providerName];

    if (!provider.apiKey) {
      attempts.push({ provider: providerName, outcome: 'not_configured' });
      continue;
    }
    if (inCooldown(providerName)) {
      attempts.push({ provider: providerName, outcome: 'cooldown' });
      continue;
    }

    for (const model of provider.models) {
      try {
        const result = await callProvider(provider, model, safeMessages, options);
        recordSuccess(providerName);
        return { ...result, provider: providerName, model, attempts };
      } catch (error) {
        attempts.push({
          provider: providerName,
          model,
          outcome: error.name === 'AbortError' ? 'timeout' : 'failed',
          status: error.status || null,
          retryAfter: error.retryAfter || null
        });
      }
    }

    recordFailure(provider);
  }

  throw new AIProvidersExhaustedError(attempts);
}

function getProviderStatus() {
  return providerOrder.map((name, priority) => {
    const provider = providers[name];
    const state = stateFor(name);
    return {
      priority: priority + 1,
      provider: name,
      configured: Boolean(provider.apiKey),
      models: provider.models,
      available: Boolean(provider.apiKey) && state.cooldownUntil <= Date.now(),
      cooldownUntil: state.cooldownUntil || null
    };
  });
}

module.exports = { generate, getProviderStatus, AIProvidersExhaustedError };
