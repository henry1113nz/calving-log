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

function milkingsPerDayOn(dateString, schedule, fallback) {
  if (!Array.isArray(schedule) || schedule.length === 0) {
    return fallback;
  }

  let selected = null;
  for (const entry of schedule) {
    if (entry.effective_from <= dateString &&
        (!selected || entry.effective_from > selected.effective_from)) {
      selected = entry;
    }
  }
  return selected ? selected.milkings_per_day : fallback;
}

// Count actual scheduled milkings rather than converting the whole period with one
// permanent farm setting. This matters around seasonal TAD -> OAD changes.
function daysForMilkings(startDate, requiredMilkings, schedule, fallback) {
  let remaining = requiredMilkings;
  let days = 0;
  const frequencies = [];

  while (remaining > 0 && days < 366) {
    days += 1;
    const date = addDays(startDate, days);
    const frequency = milkingsPerDayOn(date, schedule, fallback);
    if (![1, 2, 3].includes(frequency)) {
      throw new Error(`Invalid milking frequency for ${date}`);
    }
    if (frequencies[frequencies.length - 1] !== frequency) {
      frequencies.push(frequency);
    }
    remaining -= frequency;
  }

  if (remaining > 0) {
    throw new Error('Milking schedule did not resolve the withholding period');
  }

  return { days, frequencies };
}

function frequencyDescription(frequencies) {
  if (!frequencies || frequencies.length === 0) return '';
  if (frequencies.length === 1) return `${frequencies[0]} milking(s) per day`;
  return `a dated schedule (${frequencies.join(' -> ')} milkings per day)`;
}

/**
 * @param {object} input
 * @param {object|null} input.drug            药物记录,没有用药则为 null
 * @param {object|null} input.rule            需要选择疗程时采用的规则
 * @param {string}      input.event_date      用药日期 YYYY-MM-DD
 * @param {string|null} input.calving_date    产犊日期,干奶药需要
 * @param {string|null} input.calving_date_source  'predicted' | 'actual'
 * @param {number}      input.milkings_per_day     农场一天挤奶次数,默认 2
 * @param {Array<object>} input.milking_schedule    effective-dated frequency changes
 * @returns {{status: string, days_applied: number|null, end_date: string|null, message: string}}
 */
function calculateWithdrawal(input) {
  const drug = input.drug;
  const milkingsPerDay = input.milkings_per_day || 2;
  const milkingSchedule = Array.isArray(input.milking_schedule)
    ? input.milking_schedule
    : [];

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

  // 少数标签不能压成药品上的一个固定数字。Orbenin L.A. 的批准标签按实际
  // 疗程和每天挤奶次数给出不同的 milkings 数;事件必须保存所选疗程规则。
  if (drug.requires_regimen) {
    const rule = input.rule;
    if (!rule) {
      return {
        status: STATUS.REQUIRES_VET_ADVICE,
        days_applied: null,
        end_date: null,
        message:
          `${drug.drug_name} has more than one approved treatment regimen. ` +
          'Select the regimen that was actually used before calculating a clear date.'
      };
    }

    const regimenFrequency = milkingsPerDayOn(
      input.event_date,
      milkingSchedule,
      milkingsPerDay
    );
    const milkings = regimenFrequency === 1
      ? rule.milkings_once_daily
      : (regimenFrequency === 2 ? rule.milkings_twice_daily : null);

    if (milkings === null || milkings === undefined) {
      return {
        status: STATUS.REQUIRES_VET_ADVICE,
        days_applied: null,
        end_date: null,
        message:
          `${drug.drug_name} label rule ${rule.rule_name} does not provide a period ` +
          `for ${regimenFrequency} milkings per day. Seek veterinary advice.`
      };
    }

    const regimenConversion = daysForMilkings(
      input.event_date,
      milkings,
      milkingSchedule,
      regimenFrequency
    );
    return {
      status: STATUS.CALCULATED,
      days_applied: regimenConversion.days,
      end_date: addDays(input.event_date, regimenConversion.days),
      message:
        `${rule.rule_name}: ${milkings} milkings using ` +
        `${frequencyDescription(regimenConversion.frequencies)}, ` +
        'counted from the last treatment date.'
    };
  }

  // 泌乳期用药:牛正在产奶,停药期从用药当天起算。
  if (drug.calculation_basis === 'treatment_date') {
    const treatmentConversion = drug.milk_withdrawal_unit === 'milkings'
      ? daysForMilkings(
          input.event_date,
          drug.milk_withdrawal_value,
          milkingSchedule,
          milkingsPerDay
        )
      : {
          days: toDays(
            drug.milk_withdrawal_value,
            drug.milk_withdrawal_unit,
            milkingsPerDay
          ),
          frequencies: []
        };
    return {
      status: STATUS.CALCULATED,
      days_applied: treatmentConversion.days,
      end_date: addDays(input.event_date, treatmentConversion.days),
      message: drug.milk_withdrawal_unit === 'milkings'
        ? `Counted from the last treatment date using ${frequencyDescription(treatmentConversion.frequencies)}.`
        : 'Counted from the last treatment date.'
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

  const calvingConversion = drug.milk_withdrawal_unit === 'milkings'
    ? daysForMilkings(
        input.calving_date,
        drug.milk_withdrawal_value,
        milkingSchedule,
        milkingsPerDay
      )
    : {
        days: toDays(
          drug.milk_withdrawal_value,
          drug.milk_withdrawal_unit,
          milkingsPerDay
        ),
        frequencies: []
      };

  // Cepravin 一类干奶药的标签同时写了正常产犊和提前产犊两条规则。提前产犊
  // 不是“无答案”:批准标签要求从治疗日起走满最小天数,再加产犊后的 milkings。
  // 预测日期也先按这一条较晚的日期展示,实际产犊记录进来后会再次对账。
  if (drug.minimum_dry_period_days !== null && drug.minimum_dry_period_days !== undefined) {
    const dryPeriod = daysBetween(input.event_date, input.calving_date);
    if (dryPeriod < drug.minimum_dry_period_days) {
      const fullDryPeriodDate = addDays(input.event_date, drug.minimum_dry_period_days);
      const postDryPeriodConversion = drug.milk_withdrawal_unit === 'milkings'
        ? daysForMilkings(
            fullDryPeriodDate,
            drug.milk_withdrawal_value,
            milkingSchedule,
            milkingsPerDay
          )
        : calvingConversion;
      const totalDays = drug.minimum_dry_period_days + postDryPeriodConversion.days;
      const basis = input.calving_date_source === 'actual' ? 'actual' : 'expected';
      return {
        status: STATUS.CALCULATED,
        days_applied: totalDays,
        end_date: addDays(input.event_date, totalDays),
        message:
          `${drug.drug_name}: the ${basis} calving is only ${dryPeriod} days after treatment. ` +
          `The early-calving label rule applies: ${drug.minimum_dry_period_days} days from ` +
          `treatment plus ${drug.milk_withdrawal_value} milkings ` +
          `(${postDryPeriodConversion.days} days using ` +
          `${frequencyDescription(postDryPeriodConversion.frequencies)}).`
      };
    }
  }

  const basis = input.calving_date_source === 'actual' ? 'actual' : 'expected';
  return {
    status: STATUS.CALCULATED,
    days_applied: calvingConversion.days,
    end_date: addDays(input.calving_date, calvingConversion.days),
    message:
      `Counted from the ${basis} calving date` +
      (drug.milk_withdrawal_unit === 'milkings'
        ? ` (${drug.milk_withdrawal_value} milkings using ` +
          `${frequencyDescription(calvingConversion.frequencies)}).`
        : '.')
  };
}

module.exports = {
  calculateWithdrawal,
  toDays,
  addDays,
  daysBetween,
  milkingsPerDayOn,
  daysForMilkings,
  STATUS
};
