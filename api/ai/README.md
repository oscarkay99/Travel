# Rogernort Gemini project pool

The gateway provides five Gemini credential slots. Each credential must belong
to a separately authorized Google Cloud project:

1. `GEMINI_API_KEY_1`
2. `GEMINI_API_KEY_2`
3. `GEMINI_API_KEY_3`
4. `GEMINI_API_KEY_4`
5. `GEMINI_API_KEY_5`

Add keys through the deployment host's secret manager. Never commit real keys.

```js
const { generate } = require('./ai/router');

const answer = await generate([
  { role: 'system', content: 'Answer only from approved Rogernort knowledge.' },
  { role: 'user', content: 'What documents do I need?' }
]);

console.log(answer.text, answer.provider, answer.model);
```

Models are attempted from left to right within each project. If all compatible
models fail, that project enters a configurable cooldown and the router moves
to the next configured project. If all five are unavailable,
`AIProvidersExhaustedError` is raised so the application can serve verified FAQ
content or transfer the conversation to a human adviser.

Use `GEMINI_MODELS` to set the shared model order. Use `GEMINI_MODELS_1` through
`GEMINI_MODELS_5` when a project needs its own model list. Model identifiers are
configuration because Google changes availability over time.
