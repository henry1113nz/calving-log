const ALLOWED_INTENTS = new Set(['vat_exclusions_today', 'unsupported']);

function localIntent(question) {
  const text = String(question || '').trim().toLowerCase();
  if (!text) return 'unsupported';

  const englishMilkWords = /(vat|milk|withhold|withholding|hold|held|exclude|exclusion|safe)/;
  const englishCowWords = /(cow|cows|herd|animal|animals)/;
  const chineseMilkWords = /(奶罐|牛奶|禁奶|停奶|扣奶|安全|隔离|不能进)/;
  const chineseCowWords = /(牛|奶牛)/;

  if ((englishMilkWords.test(text) && englishCowWords.test(text)) ||
      (chineseMilkWords.test(text) && chineseCowWords.test(text))) {
    return 'vat_exclusions_today';
  }
  return 'unsupported';
}

function responseText(payload) {
  for (const item of payload?.output || []) {
    for (const content of item?.content || []) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        return content.text;
      }
    }
  }
  return '';
}

async function classifyIntent(question, options = {}) {
  const apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
  const model = options.model ?? process.env.OPENAI_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const fallbackIntent = localIntent(question);

  if (!apiKey || !model) {
    return {
      intent: fallbackIntent,
      mode: 'local',
      notice: 'External AI is not configured; the constrained local intent matcher was used.'
    };
  }

  try {
    const response = await fetchImpl('https://api.openai.com/v1/responses', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 80,
        instructions:
          'Classify the user request for a dairy farm record system. ' +
          'Choose vat_exclusions_today only when the user asks which cows must stay out of the milk vat today. ' +
          'Choose unsupported for every other request. Do not calculate, diagnose, or provide a milk-release decision.',
        input: String(question),
        text: {
          format: {
            type: 'json_schema',
            name: 'calving_log_intent',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                intent: { type: 'string', enum: ['vat_exclusions_today', 'unsupported'] }
              },
              required: ['intent'],
              additionalProperties: false
            }
          }
        }
      }),
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) throw new Error(`OpenAI request failed (${response.status})`);
    const payload = await response.json();
    const parsed = JSON.parse(responseText(payload));
    if (!ALLOWED_INTENTS.has(parsed.intent)) throw new Error('Unexpected intent');
    return { intent: parsed.intent, mode: 'openai', notice: null };
  } catch {
    return {
      intent: fallbackIntent,
      mode: 'local_fallback',
      notice: 'The external AI service was unavailable; the constrained local intent matcher was used.'
    };
  }
}

module.exports = { classifyIntent, localIntent, responseText };
