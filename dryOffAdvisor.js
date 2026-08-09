// 干奶期用药选择建议。
//
// 从 2027 年 1 月 1 日起,新西兰兽医委员会要求每一头接受干奶期抗生素的牛都要
// 有个体化的正当理由,而不再是整群一刀切。本模块把业内已发表的选择标准编码
// 下来,并且——这是关键——同时输出"是哪一条标准被触发的",因为这条记录本身
// 就是那份正当理由。只给结论不给依据的建议,对合规没有任何用处。
//
// 本模块是纯逻辑:不碰数据库、不碰 HTTP,输入什么就判什么,便于单独验证。

// 成母牛与初产牛的阈值不同:初产牛还没经历过完整泌乳期,同样的体细胞数
// 意味着更值得警惕的感染,所以阈值定得更低。
const MATURE_COW_SCC_THRESHOLD = 150000;
const FIRST_LACTATION_SCC_THRESHOLD = 125000;

const ANTIBIOTIC_DCT = 'antibiotic_dct';
const TEAT_SEAL_ONLY = 'teat_seal_only';

/**
 * @param {object} input
 * @param {number|null} input.lactation_number  胎次,1 为初产牛
 * @param {Array<{test_date: string, scc_value: number, source: string}>} input.scc_records
 *        本产季的体细胞数记录,顺序不限
 * @param {Array<{event_date: string, notes: string|null}>} input.mastitis_events
 *        本泌乳期内的临床乳房炎治疗事件
 * @returns {{recommendation: string|null, criteria_met: string[], evidence: object, sufficient_evidence: boolean}}
 */
function recommendDryOffTreatment(input) {
  const lactationNumber = input.lactation_number;
  const sccRecords = input.scc_records || [];
  const mastitisEvents = input.mastitis_events || [];

  const isFirstLactation = lactationNumber === 1;
  const threshold = isFirstLactation
    ? FIRST_LACTATION_SCC_THRESHOLD
    : MATURE_COW_SCC_THRESHOLD;

  // 用本产季的最高值,不用最近值或平均值:一次超标就说明这头牛在该泌乳期内
  // 有过感染,后续一次正常读数并不能证明感染已经清除。
  const highestScc = sccRecords.reduce(
    (highest, record) => (highest === null || record.scc_value > highest.scc_value) ? record : highest,
    null
  );

  const criteriaMet = [];

  if (highestScc && highestScc.scc_value > threshold) {
    criteriaMet.push(
      `Highest recorded SCC this season was ${highestScc.scc_value.toLocaleString('en-NZ')} ` +
      `on ${highestScc.test_date} (${highestScc.source}), above the ` +
      `${threshold.toLocaleString('en-NZ')} threshold for ` +
      `${isFirstLactation ? 'a first-lactation cow' : 'a mature cow'}`
    );
  }

  if (mastitisEvents.length > 0) {
    const dates = mastitisEvents.map(e => e.event_date).join(', ');
    criteriaMet.push(
      `${mastitisEvents.length} clinical mastitis treatment` +
      `${mastitisEvents.length === 1 ? '' : 's'} recorded this lactation (${dates})`
    );
  }

  // 没有任何检测数据时不能给"仅用封闭剂"的建议——那等于把"没有证据"当成
  // "证据表明没问题"。食品安全场景下这两者必须区分开,所以这里返回 null,
  // 由调用方提示先补检测数据。
  const hasEvidence = sccRecords.length > 0 || mastitisEvents.length > 0;

  if (!hasEvidence) {
    return {
      recommendation: null,
      criteria_met: [],
      sufficient_evidence: false,
      evidence: {
        lactation_number: lactationNumber,
        threshold_applied: threshold,
        highest_scc: null,
        scc_record_count: 0,
        mastitis_event_count: 0,
        note: 'No SCC results or mastitis history recorded for this cow. ' +
              'A teat-seal-only recommendation cannot be justified without individual data.'
      }
    };
  }

  return {
    recommendation: criteriaMet.length > 0 ? ANTIBIOTIC_DCT : TEAT_SEAL_ONLY,
    criteria_met: criteriaMet,
    sufficient_evidence: true,
    evidence: {
      lactation_number: lactationNumber,
      threshold_applied: threshold,
      highest_scc: highestScc,
      scc_record_count: sccRecords.length,
      mastitis_event_count: mastitisEvents.length,
      note: criteriaMet.length > 0
        ? 'Antibiotic dry cow therapy indicated by the criteria listed above.'
        : `No criterion met: highest SCC stayed at or below ${threshold.toLocaleString('en-NZ')} ` +
          `and no clinical mastitis was recorded this lactation.`
    }
  };
}

module.exports = {
  recommendDryOffTreatment,
  MATURE_COW_SCC_THRESHOLD,
  FIRST_LACTATION_SCC_THRESHOLD
};
