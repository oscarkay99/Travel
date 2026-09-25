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

On the first request, models are attempted from left to right within each
project. Later requests try the last successful project and model first,
avoiding repeated discovery of a working route. Failed models are skipped for
`AI_PROVIDER_COOLDOWN_MS` (60 seconds by default), then become eligible again.
This routing state is held in memory per API process and resets on restart;
customer answers are not cached.

If all compatible models fail, that project enters the same cooldown and the
router moves to the next configured project. Authentication failures and
timeouts move directly to the next project without trying its remaining models.
The overall AI request budget remains 22 seconds, including retries, with a
default limit of 7 seconds per model attempt. These changes avoid repeat failure
delays; they do not guarantee a particular live response time or stream text.
If all five are unavailable,
`AIProvidersExhaustedError` is raised so the application can serve verified FAQ
content or transfer the conversation to a human adviser.

Use `GEMINI_MODELS` to set the shared model order. Use `GEMINI_MODELS_1` through
`GEMINI_MODELS_5` when a project needs its own model list. Model identifiers are
configuration because Google changes availability over time.
