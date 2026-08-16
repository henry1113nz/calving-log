// 牛奶停药期计算。
//
// 纯逻辑:不碰数据库、不碰 HTTP。输入一条事件和它用的药,输出停药期结论。
//
// 这个模块承载了整个系统里最容易算错的一条规则。停药期不是"用药日期加几天"
// 那么简单,标签上的表达方式至少有三种不同的结构,见下面各分支的注释。

// 计算不出结果时,原因必须跟着结论一起返回。对挤奶工来说,"在等产犊日期"
// 和"这头牛不能按常规处理"是完全不同的两件事,都留空就分不出来了。
const STATUS = {
  NOT_APPLICABLE: 'not_applicable',
  CALCULATED: 'calculated',
  AWAITING_CALVING_DATE: 'awaiting_calving_date',
  REQUIRES_VET_ADVICE: 'requires_vet_advice',
  MINIMUM_DRY_PERIOD_BREACHED: 'minimum_dry_period_breached'
};

function addDays(dateString, days) {
  // 用 UTC 构造,避免本地时区在夏令时切换那天把日期算偏一天。
  const [year, month, day] = dateString.split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + days));
  return result.toISOString().split('T')[0];
}

function daysBetween(earlier, later) {
  const [y1, m1, d1] = earlier.split('-').map(Number);
  const [y2, m2, d2] = later.split('-').map(Number);
  return Math.round(
    (Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000
  );
}

// 标签上的停药期单位不统一,要先归一化成天数。
//
//   hours    —— 注射剂和泌乳期乳内注入常用。Orbenin L.A. 是 96 小时。
//   milkings —— 干奶药用,因为停药期是从产犊后重新开始挤奶算起的。
//               换算依赖农场一天挤几次:8 milkings 在一天两次的农场是 4 天,
//               在一天一次的农场是 8 天。同一个标签,结果差一倍。
//   days     —— 标签本来就写天数的情况。
//
// 一律向上取整。取整方向在这里不是风格问题:向下取整会让牛提前解禁。
function toDays(value, unit, milkingsPerDay) {
  switch (unit) {
    case 'days':
      return value;
    case 'hours':
      return Math.ceil(value / 24);
    case 'milkings':
      return Math.ceil(value / milkingsPerDay);
    default:
      throw new Error(`Unknown withdrawal unit: ${unit}`);
  }
}

/**
 * @param {object} input
 * @param {object|null} input.drug            药物记录,没有用药则为 null
 * @param {string}      input.event_date      用药日期 YYYY-MM-DD
 * @param {string|null} input.calving_date    产犊日期,干奶药需要
 * @param {string|null} input.calving_date_source  'predicted' | 'actual'
 * @param {number}      input.milkings_per_day     农场一天挤奶次数,默认 2
 * @returns {{status: string, days_applied: number|null, end_date: string|null, message: string}}
 */
function calculateWithdrawal(input) {
  const drug = input.drug;
  const milkingsPerDay = input.milkings_per_day || 2;

  if (!drug) {
    return {
      status: STATUS.NOT_APPLICABLE,
      days_applied: null,
      end_date: null,
      message: 'No drug was administered, so no withholding period applies.'
    };
  }

  // 剂量依赖的药不自动计算。VCNZ 2023 年的通告说明 procaine penicillin 类
  // 产品的停药期随剂量变化,MPI 为此单独出了一张 69 个产品的对照表。用一个
  // 固定数字去算,得到的会是一个看起来很合理的错误答案——这正是本系统最该
  // 避免的东西。宁可要求人工填写。
  if (drug.whp_depends_on_dose) {
    return {
      status: STATUS.REQUIRES_VET_ADVICE,
      days_applied: null,
      end_date: null,
      message:
        `The withholding period for ${drug.drug_name} depends on the dose given. ` +
        'Enter the period from the prescription or the veterinarian\'s advice; ' +
        'it cannot be derived from the drug alone.'
    };
  }

  const withdrawalDays = toDays(
    drug.milk_withdrawal_value,
    drug.milk_withdrawal_unit,
    milkingsPerDay
  );

  // 泌乳期用药:牛正在产奶,停药期从用药当天起算。
  if (drug.calculation_basis === 'treatment_date') {
    return {
      status: STATUS.CALCULATED,
      days_applied: withdrawalDays,
      end_date: addDays(input.event_date, withdrawalDays),
      message: `Counted from the treatment date.`
    };
  }

  // 干奶期用药:用药时牛不产奶,停药期要等她产犊、重新泌乳之后才开始走。
  // 从用药日期起算会让干奶药提前几个月解禁,这是本系统存在的核心理由之一。
  if (!input.calving_date) {
    return {
      status: STATUS.AWAITING_CALVING_DATE,
      days_applied: null,
      end_date: null,
      message:
        `${drug.drug_name} is counted from the calving date, which is not yet known. ` +
        'No clear date is recorded until she calves.'
    };
  }

  // 最小干奶期是标签上的用药前提条件,不是时长。Cepravin 写的是
  // "Treatment to be at least 49 days before calving"。牛提前产犊、间隔不足时,
  // 标签条件没有被满足,常规停药期就不再适用——不能照常算一个日期出来。
  //
  // 只在产犊日期已经是事实的时候判定。还是预测值的时候提前宣告违规没有意义,
  // 牛可能根本不会那天产。
  if (drug.minimum_dry_period_days !== null && drug.minimum_dry_period_days !== undefined
      && input.calving_date_source === 'actual') {
    const actualDryPeriod = daysBetween(input.event_date, input.calving_date);

    if (actualDryPeriod < drug.minimum_dry_period_days) {
      return {
        status: STATUS.MINIMUM_DRY_PERIOD_BREACHED,
        days_applied: null,
        end_date: null,
        message:
          `${drug.drug_name} requires at least ${drug.minimum_dry_period_days} days between ` +
          `treatment and calving, but this cow calved after ${actualDryPeriod} days. ` +
          'The label condition was not met, so the standard withholding period does not apply. ' +
          'Seek veterinary advice before this cow\'s milk goes in the vat.'
      };
    }
  }

  const basis = input.calving_date_source === 'actual' ? 'actual' : 'expected';
  return {
    status: STATUS.CALCULATED,
    days_applied: withdrawalDays,
    end_date: addDays(input.calving_date, withdrawalDays),
    message:
      `Counted from the ${basis} calving date` +
      (drug.milk_withdrawal_unit === 'milkings'
        ? ` (${drug.milk_withdrawal_value} milkings at ${milkingsPerDay} per day).`
        : '.')
  };
}

module.exports = { calculateWithdrawal, toDays, addDays, daysBetween, STATUS };
