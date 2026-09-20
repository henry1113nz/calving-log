const fs = require('fs');
const crypto = require('crypto');
const { calculateWithdrawal, STATUS } = require('./withdrawalCalculator');

// 这一批数据逐份取自 2026-08-17 在 MPI ACVM register 中可下载的最新版
// Approved Label。版本号是导入审计键:标签将来变化时新增一批,不覆盖历史版本。
const REFERENCE_DATA_VERSION = 'mpi-acvm-2026-08-17';
const VERIFIED_BY = 'CalvingLog ACVM label review';
const VERIFIED_ON = '2026-08-17';

const PRODUCTS = [
  {
    drug_name: 'Orbenin L.A.',
    active_ingredient: 'Cloxacillin sodium',
    milk_withdrawal_value: 96,
    milk_withdrawal_unit: 'hours',
    meat_withdrawal_days: 3,
    calculation_basis: 'treatment_date',
    minimum_dry_period_days: null,
    whp_depends_on_dose: 0,
    requires_regimen: 1,
    acvm_registration_no: 'A003664',
    label_revision: 'A003664-23 - Approved Label - Jun 2026',
    label_wording:
      'For 3 x 48 or 5 x 48 hourly treatments: 7 milkings/approximately 84 hours ' +
      '(twice daily) or 3 milkings/approximately 72 hours (once daily). For 5 x 24 ' +
      'hourly treatments: 8 milkings/approximately 96 hours (twice daily) or 4 ' +
      'milkings/approximately 96 hours (once daily). Meat: 3 days.',
    source_reference:
      'https://eatsafe.nzfsa.govt.nz/web/public/acvm-register?' +
      'p_p_id=searchAcvm_WAR_aaol&p_p_lifecycle=0&p_p_state=exclusive&' +
      '_searchAcvm_WAR_aaol_action=document&_searchAcvm_WAR_aaol_documentId=72074',
    verified_on: VERIFIED_ON,
    verified_by: VERIFIED_BY,
    is_active: 1,
    rules: [
      {
        rule_code: 'three_or_five_48_hourly',
        rule_name: '3 or 5 treatments at 48-hour intervals',
        description: '7 milkings when milked twice daily; 3 milkings when milked once daily.',
        milkings_once_daily: 3,
        milkings_twice_daily: 7,
        is_default: 1
      },
      {
        rule_code: 'five_24_hourly',
        rule_name: '5 treatments at 24-hour intervals',
        description: '8 milkings when milked twice daily; 4 milkings when milked once daily.',
        milkings_once_daily: 4,
        milkings_twice_daily: 8,
        is_default: 0
      }
    ]
  },
  {
    drug_name: 'Mastalone',
    active_ingredient:
      'Oxytetracycline hydrochloride / oleandomycin / neomycin / prednisolone',
    milk_withdrawal_value: 8,
    milk_withdrawal_unit: 'milkings',
    meat_withdrawal_days: 30,
    calculation_basis: 'treatment_date',
    minimum_dry_period_days: null,
    whp_depends_on_dose: 0,
    requires_regimen: 0,
    acvm_registration_no: 'A000829',
    label_revision: 'A00829-23 - Approved Label - May 2022',
    label_wording:
      'Milk must be discarded during treatment and for not less than 8 milkings or ' +
      'approximately 96 hours following the last treatment. Meat: 30 days.',
    source_reference:
      'https://eatsafe.nzfsa.govt.nz/web/public/acvm-register?' +
      'p_p_id=searchAcvm_WAR_aaol&p_p_lifecycle=0&p_p_state=exclusive&' +
      '_searchAcvm_WAR_aaol_action=document&_searchAcvm_WAR_aaol_documentId=58168',
    verified_on: VERIFIED_ON,
    verified_by: VERIFIED_BY,
    is_active: 1,
    rules: []
  },
  {
    drug_name: 'Penethaject',
    active_ingredient: 'Penethamate hydriodide',
    milk_withdrawal_value: 48,
    milk_withdrawal_unit: 'hours',
    meat_withdrawal_days: 7,
    calculation_basis: 'treatment_date',
    minimum_dry_period_days: null,
    whp_depends_on_dose: 0,
    requires_regimen: 0,
    acvm_registration_no: 'A009423',
    label_revision: 'A009423-26 - Approved Label - Oct 2025',
    label_wording:
      'Milk must be discarded during treatment and for not less than 4 milkings ' +
      '(twice daily) or 2 milkings (once daily), approximately 48 hours following ' +
      'the last treatment. Meat: 7 days.',
    source_reference:
      'https://eatsafe.nzfsa.govt.nz/web/public/acvm-register?' +
      'p_p_id=searchAcvm_WAR_aaol&p_p_lifecycle=0&p_p_state=exclusive&' +
      '_searchAcvm_WAR_aaol_action=document&_searchAcvm_WAR_aaol_documentId=70218',
    verified_on: VERIFIED_ON,
    verified_by: VERIFIED_BY,
    is_active: 1,
    rules: []
  },
  {
    drug_name: 'Cepravin Dry Cow',
    active_ingredient: 'Cephalonium',
    milk_withdrawal_value: 8,
    milk_withdrawal_unit: 'milkings',
    meat_withdrawal_days: 30,
    calculation_basis: 'calving_date',
    minimum_dry_period_days: 49,
    whp_depends_on_dose: 0,
    requires_regimen: 0,
    acvm_registration_no: 'A003322',
    label_revision: 'A003322-29 - Approved Label - Jul 2025',
    label_wording:
      'If calving occurs 49 days or more after treatment, discard the first 8 ' +
      'milkings after calving. If calving occurs within 49 days, milk may be sold ' +
      'only after the full 49 days from treatment and a further 8 milkings. Meat: 30 days.',
    source_reference:
      'https://eatsafe.nzfsa.govt.nz/web/public/acvm-register?' +
      'p_p_id=searchAcvm_WAR_aaol&p_p_lifecycle=0&p_p_state=exclusive&' +
      '_searchAcvm_WAR_aaol_action=document&_searchAcvm_WAR_aaol_documentId=69456',
    verified_on: VERIFIED_ON,
    verified_by: VERIFIED_BY,
    is_active: 1,
    rules: []
  },
  {
    drug_name: 'Bovaclox DC Xtra',
    active_ingredient: 'Ampicillin / cloxacillin',
    milk_withdrawal_value: 8,
    milk_withdrawal_unit: 'milkings',
    meat_withdrawal_days: 30,
    calculation_basis: 'calving_date',
    minimum_dry_period_days: 49,
    whp_depends_on_dose: 0,
    requires_regimen: 0,
    acvm_registration_no: 'A009020',
    label_revision: null,
    label_wording: null,
    source_reference:
      'MPI 2023 Tranche 1 reassessment summary only; no current Approved Label was ' +
      'available in the ACVM register on 2026-08-17. Do not substitute A004495.',
    verified_on: null,
    verified_by: null,
    is_active: 0,
    rules: []
  },
  {
    drug_name: 'Teatseal',
    active_ingredient: 'Bismuth subnitrate',
    milk_withdrawal_value: 8,
    milk_withdrawal_unit: 'milkings',
    meat_withdrawal_days: 0,
    calculation_basis: 'calving_date',
    minimum_dry_period_days: null,
    whp_depends_on_dose: 0,
    requires_regimen: 0,
    acvm_registration_no: 'A007294',
    label_revision: 'A007294-34 - Approved Label - Oct 2025',
    label_wording:
      'Milk must be discarded for not less than 8 milkings or approximately 96 ' +
      'hours after calving. Meat: Nil.',
    source_reference:
      'https://eatsafe.nzfsa.govt.nz/web/public/acvm-register?' +
      'p_p_id=searchAcvm_WAR_aaol&p_p_lifecycle=0&p_p_state=exclusive&' +
      '_searchAcvm_WAR_aaol_action=document&_searchAcvm_WAR_aaol_documentId=70086',
    verified_on: VERIFIED_ON,
    verified_by: VERIFIED_BY,
    is_active: 1,
    rules: []
  }
];

function createBackup(db, backupPath) {
  if (!backupPath || fs.existsSync(backupPath)) {
    return null;
  }

  db.prepare('VACUUM INTO ?').run(backupPath);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(backupPath)).digest('hex');
  return { path: backupPath, sha256: digest };
}

function syncAcvmReferenceData(db, options = {}) {
  const imported = db.prepare(
    'SELECT version, imported_at FROM reference_data_imports WHERE version = ?'
  ).get(REFERENCE_DATA_VERSION);
  if (imported) {
    return { applied: false, version: REFERENCE_DATA_VERSION, imported_at: imported.imported_at };
  }

  const backup = createBackup(db, options.backupPath || null);
  const perDay = db.prepare(
    'SELECT milkings_per_day FROM farm_settings WHERE id = 1'
  ).get()?.milkings_per_day || 2;
  const schedule = db.prepare(`
    SELECT id, effective_from, milkings_per_day
    FROM milking_schedule
    ORDER BY effective_from
  `).all();

  const apply = db.transaction(() => {
    const revisionIds = new Map();
    const defaultRuleIds = new Map();

    for (const product of PRODUCTS) {
      const existing = db.prepare('SELECT id FROM drugs WHERE drug_name = ?').get(product.drug_name);
      if (!existing) {
        throw new Error(`Reference import cannot find drug row: ${product.drug_name}`);
      }

      db.prepare(`
        UPDATE drugs
        SET active_ingredient = ?, milk_withdrawal_value = ?, milk_withdrawal_unit = ?,
            meat_withdrawal_days = ?, calculation_basis = ?, minimum_dry_period_days = ?,
            whp_depends_on_dose = ?, label_wording = ?, source_reference = ?,
            verified_on = ?, is_active = ?, acvm_registration_no = ?, label_revision = ?,
            verified_by = ?, requires_regimen = ?, current_reference_revision_id = NULL
        WHERE id = ?
      `).run(
        product.active_ingredient,
        product.milk_withdrawal_value,
        product.milk_withdrawal_unit,
        product.meat_withdrawal_days,
        product.calculation_basis,
        product.minimum_dry_period_days,
        product.whp_depends_on_dose,
        product.label_wording,
        product.source_reference,
        product.verified_on,
        product.is_active,
        product.acvm_registration_no,
        product.label_revision,
        product.verified_by,
        product.requires_regimen,
        existing.id
      );

      if (!product.verified_on) {
        continue;
      }

      const revisionResult = db.prepare(`
        INSERT INTO drug_reference_revisions
          (drug_id, acvm_registration_no, label_revision, label_wording,
           source_reference, verified_on, verified_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        existing.id,
        product.acvm_registration_no,
        product.label_revision,
        product.label_wording,
        product.source_reference,
        product.verified_on,
        product.verified_by
      );
      const revisionId = Number(revisionResult.lastInsertRowid);
      revisionIds.set(existing.id, revisionId);

      db.prepare(
        'UPDATE drugs SET current_reference_revision_id = ? WHERE id = ?'
      ).run(revisionId, existing.id);

      for (const rule of product.rules) {
        const ruleResult = db.prepare(`
          INSERT INTO drug_withdrawal_rules
            (drug_id, reference_revision_id, rule_code, rule_name, description,
             milkings_once_daily, milkings_twice_daily, is_default)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          existing.id,
          revisionId,
          rule.rule_code,
          rule.rule_name,
          rule.description,
          rule.milkings_once_daily,
          rule.milkings_twice_daily,
          rule.is_default
        );
        if (rule.is_default) {
          defaultRuleIds.set(existing.id, Number(ruleResult.lastInsertRowid));
        }
      }
    }

    // 只纠正仍有效的事件。软删除记录是历史证据,继续保留旧快照。
    const events = db.prepare(`
      SELECT h.*, d.drug_name, d.milk_withdrawal_value, d.milk_withdrawal_unit,
             d.calculation_basis, d.minimum_dry_period_days, d.whp_depends_on_dose,
             d.requires_regimen, d.is_active
      FROM health_events h
      JOIN drugs d ON d.id = h.drug_id
      WHERE h.deleted_at IS NULL
      ORDER BY h.id
    `).all();

    for (const event of events) {
      const revisionId = revisionIds.get(event.drug_id) || null;
      let ruleId = event.drug_rule_id || null;
      let inferredEquivalentRegimen = false;

      // v4 没有疗程字段。只有在当前挤奶频率下所有批准疗程得到完全相同的
      // 天数时,才能在不改变安全结论的情况下关联默认规则;否则保持未解析。
      if (!ruleId && event.requires_regimen) {
        const availableRules = db.prepare(`
          SELECT * FROM drug_withdrawal_rules WHERE drug_id = ? ORDER BY is_default DESC, id
        `).all(event.drug_id);
        const possibleDays = availableRules.map(rule => {
          const milkings = perDay === 1
            ? rule.milkings_once_daily
            : (perDay === 2 ? rule.milkings_twice_daily : null);
          return milkings == null ? null : Math.ceil(milkings / perDay);
        });
        const distinctDays = [...new Set(possibleDays.filter(value => value !== null))];
        if (availableRules.length > 0 && distinctDays.length === 1 &&
            possibleDays.every(value => value === distinctDays[0])) {
          ruleId = defaultRuleIds.get(event.drug_id) || null;
          inferredEquivalentRegimen = Boolean(ruleId);
        }
      }
      let rule = null;
      if (ruleId) {
        rule = db.prepare('SELECT * FROM drug_withdrawal_rules WHERE id = ?').get(ruleId);
      }

      const result = !event.is_active || !revisionId
        ? {
            status: STATUS.REQUIRES_VET_ADVICE,
            days_applied: null,
            end_date: null,
            message: 'The product has no current verified ACVM label and cannot be auto-calculated.'
          }
        : calculateWithdrawal({
            drug: event,
            rule,
            event_date: event.event_date,
            calving_date: event.calving_date,
            calving_date_source: event.calving_date_source,
            milkings_per_day: perDay,
            milking_schedule: schedule
          });

      const usesMilkingSchedule = event.milk_withdrawal_unit === 'milkings' ||
        event.requires_regimen;
      const scheduleSnapshot = usesMilkingSchedule
        ? JSON.stringify(schedule)
        : null;

      db.prepare(`
        INSERT INTO withdrawal_corrections
          (health_event_id, previous_days, previous_end_date, previous_status,
           corrected_days, corrected_end_date, corrected_status, reason)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.withdrawal_days_applied,
        event.withdrawal_end_date,
        event.withdrawal_status,
        result.days_applied,
        result.end_date,
        result.status,
        inferredEquivalentRegimen
          ? `Applied ${REFERENCE_DATA_VERSION}; legacy regimen was not recorded, but all ` +
            `approved regimens resolve to ${result.days_applied} days at ${perDay} milkings/day`
          : `Applied verified reference data ${REFERENCE_DATA_VERSION}`
      );

      db.prepare(`
        UPDATE health_events
        SET withdrawal_days_applied = ?, withdrawal_end_date = ?, withdrawal_status = ?,
            drug_reference_revision_id = ?, drug_rule_id = ?,
            milkings_per_day_applied = ?, milking_schedule_snapshot = ?
        WHERE id = ?
      `).run(
        result.days_applied,
        result.end_date,
        result.status,
        revisionId,
        ruleId,
        usesMilkingSchedule ? perDay : null,
        scheduleSnapshot,
        event.id
      );
    }

    db.prepare(`
      INSERT INTO reference_data_imports (version, source_summary)
      VALUES (?, ?)
    `).run(
      REFERENCE_DATA_VERSION,
      'MPI ACVM Approved Labels reviewed 2026-08-17; A009020 deactivated pending a current label'
    );

    return { revised_events: events.length };
  });

  const result = apply();
  return {
    applied: true,
    version: REFERENCE_DATA_VERSION,
    backup,
    ...result
  };
}

module.exports = {
  PRODUCTS,
  REFERENCE_DATA_VERSION,
  syncAcvmReferenceData
};
