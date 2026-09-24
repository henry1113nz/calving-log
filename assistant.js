// 助手只负责"这句话属于哪一类请求",不负责回答。停药期永远由 withdrawalCalculator
// 和数据库里的快照决定,模型连一个日期、一头牛、一种药都不准提供。
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

async function classifyIntent(question) {
  return {
    intent: localIntent(question),
    mode: 'local',
    notice: null
  };
}

module.exports = { classifyIntent, localIntent };
