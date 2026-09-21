// 助手只负责"这句话属于哪一类请求",不负责回答。停药期永远由 withdrawalCalculator
// 和数据库里的快照决定,模型连一个日期、一头牛、一种药都不准提供。
const ALLOWED_INTENTS = new Set([
  'vat_exclusions_today',
  'cow_status',
  'draft_event',
  'unsupported'
]);

// 问句和陈述句要分开:"哪些牛产犊了"是查询,"212 号今天产犊了"才是要录入的事实。
// 分不清就会把一句提问变成一条待确认的记录,让人以为系统要写库。
const QUESTION_OPENERS =
  /^(which|what|who|when|where|why|how|is|are|was|were|does|do|did|can|could|should|show|list|tell)\b/;
const CHINESE_QUESTION_OPENERS = /^(哪|什么|谁|何时|为什么|怎么|是否|有没有|多久)/;
const QUESTION_MARKS = /[?？]\s*$|吗\s*[?？]?\s*$/;

const CALVING_WORDS = /(calved|calving|gave birth|产犊|生了|下犊|生犊)/;
const TREATMENT_WORDS = /(treated|treatment|treating|antibiotic|mastitis|dry cow|打针|治疗|用药|乳房炎|干奶)/;
const EXPLAIN_WORDS =
  /(why|when|explain|reason|status|hold|held|holding|clear|cleared|eligible|withhold|withholding|out of|为什么|什么时候|多久|解除|状态|停奶|禁奶|能不能|可不可以)/;
const ANIMAL_NUMBER = /\d/;

const ENGLISH_MILK_WORDS = /(vat|milk|withhold|withholding|hold|held|exclude|exclusion|safe)/;
const ENGLISH_COW_WORDS = /(cow|cows|herd|animal|animals)/;
const CHINESE_MILK_WORDS = /(奶罐|牛奶|禁奶|停奶|扣奶|安全|隔离|不能进)/;
const CHINESE_COW_WORDS = /(牛|奶牛)/;

function localIntent(question) {
  const text = String(question || '').trim().toLowerCase();
  if (!text) return 'unsupported';

  const asksQuestion = QUESTION_OPENERS.test(text) ||
    CHINESE_QUESTION_OPENERS.test(text) ||
    QUESTION_MARKS.test(text);

  // 陈述一件已经发生的事 → 生成待确认草稿。草稿不会写库,所以这一步宁可多识别,
  // 也好过让人以为系统没听懂而放弃记录。
  if (!asksQuestion && (CALVING_WORDS.test(text) || TREATMENT_WORDS.test(text))) {
    return 'draft_event';
  }

  // 问某一头具体的牛 → 解释这头牛已经存下来的计算结果,而不是重算。
  if (ANIMAL_NUMBER.test(text) &&
      (EXPLAIN_WORDS.test(text) || ENGLISH_COW_WORDS.test(text) || CHINESE_COW_WORDS.test(text)) &&
      (EXPLAIN_WORDS.test(text) || ENGLISH_MILK_WORDS.test(text) || CHINESE_MILK_WORDS.test(text))) {
    return 'cow_status';
  }

  if ((ENGLISH_MILK_WORDS.test(text) && ENGLISH_COW_WORDS.test(text)) ||
      (CHINESE_MILK_WORDS.test(text) && CHINESE_COW_WORDS.test(text))) {
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
          'Classify the user request for a dairy farm record system. Return one intent only. ' +
          'vat_exclusions_today: the user asks which cows must stay out of the milk vat today. ' +
          'cow_status: the user asks about the recorded milk-withholding situation of one named or numbered cow. ' +
          'draft_event: the user states that something happened to a cow and wants it recorded. ' +
          'unsupported: every other request. ' +
          'Do not calculate a withholding period, choose a medicine or regimen, diagnose, ' +
          'or provide a milk-release decision. Return no data other than the intent.',
        input: String(question),
        text: {
          format: {
            type: 'json_schema',
            name: 'calving_log_intent',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                intent: {
                  type: 'string',
                  enum: ['vat_exclusions_today', 'cow_status', 'draft_event', 'unsupported']
                }
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

module.exports = { ALLOWED_INTENTS, classifyIntent, localIntent, responseText };
