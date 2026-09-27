// Additional dairy-medicine references verified against the current MPI ACVM
// register. This import is separate from the 2026-08-17 baseline so an existing
// Railway volume receives the new products without rewriting historical events.
const REFERENCE_DATA_VERSION = 'mpi-acvm-additions-2026-09-28';
const VERIFIED_ON = '2026-09-28';
const VERIFIED_BY = 'CalvingLog ACVM label review';

const PRODUCTS = [
  {
    drug_name: 'Albiotic',
    active_ingredient: 'Lincomycin hydrochloride / neomycin sulphate',
    milk_withdrawal_value: 5,
    milk_withdrawal_unit: 'milkings',
    meat_withdrawal_days: 10,
    calculation_basis: 'treatment_date',
    minimum_dry_period_days: null,
    whp_depends_on_dose: 0,
    requires_regimen: 1,
    acvm_registration_no: 'A007712',
    label_revision: 'A007712-24 - Approved Label - Feb 2024',
    label_wording:
      'For twice daily milking: 5 milkings (60 hours). For once daily milking: ' +
      '4 milkings (96 hours). Meat: 10 days.',
    source_reference:
      'https://eatsafe.nzfsa.govt.nz/web/public/acvm-register?' +
      'p_p_id=searchAcvm_WAR_aaol&p_p_lifecycle=0&p_p_state=exclusive&' +
      '_searchAcvm_WAR_aaol_action=document&_searchAcvm_WAR_aaol_documentId=64025',
    rules: [
      {
        rule_code: 'label_course_by_frequency',
        rule_name: 'Label course for the current milking frequency',
        description: '5 milkings for TAD; 4 milkings for OAD, counted after the last treatment.',
        milkings_once_daily: 4,
        milkings_twice_daily: 5,
        is_default: 1
      }
    ]
  },
  {
    drug_name: 'Mastiplan',
    active_ingredient: 'Cephapirin sodium / prednisolone',
    milk_withdrawal_value: 10,
    milk_withdrawal_unit: 'milkings',
    meat_withdrawal_days: 3,
    calculation_basis: 'treatment_date',
    minimum_dry_period_days: null,
    whp_depends_on_dose: 0,
    requires_regimen: 1,
    acvm_registration_no: 'A011329',
    label_revision: 'A011329-10 - Approved Label - Jul 2026',
    label_wording:
      'For cows milked and treated twice a day: 10 milkings (120 hours). For cows ' +
      'milked and treated once a day: 7 milkings (168 hours). Meat: 3 days.',
    source_reference:
      'https://eatsafe.nzfsa.govt.nz/web/public/acvm-register?' +
      'p_p_id=searchAcvm_WAR_aaol&p_p_lifecycle=0&p_p_state=exclusive&' +
      '_searchAcvm_WAR_aaol_action=document&_searchAcvm_WAR_aaol_documentId=72380',
    rules: [
      {
        rule_code: 'label_course_by_frequency',
        rule_name: 'Label course for the current milking frequency',
        description: '10 milkings for TAD; 7 milkings for OAD, counted after the last treatment.',
        milkings_once_daily: 7,
        milkings_twice_daily: 10,
        is_default: 1
      }
    ]
  },
  {
    drug_name: 'Noroclox DC 600',
    active_ingredient: 'Cloxacillin (as benzathine salt)',
    milk_withdrawal_value: 8,
    milk_withdrawal_unit: 'milkings',
    meat_withdrawal_days: 28,
    calculation_basis: 'calving_date',
    minimum_dry_period_days: 35,
    whp_depends_on_dose: 0,
    requires_regimen: 0,
    acvm_registration_no: 'A009281',
    label_revision: 'A009281-20 - Approved Label - Sep 2026',
    label_wording:
      'Milk for human consumption must not be taken from the first 8 milkings after ' +
      'calving. If calving occurs before 35 days after the last treatment, milk may ' +
      'only be taken after the full 35 days from treatment and a further 8 milkings. ' +
      'Meat: 28 days.',
    source_reference:
      'https://eatsafe.nzfsa.govt.nz/web/public/acvm-register?' +
      'p_p_id=searchAcvm_WAR_aaol&p_p_lifecycle=0&p_p_state=exclusive&' +
      '_searchAcvm_WAR_aaol_action=document&_searchAcvm_WAR_aaol_documentId=72762',
    rules: []
  }
];

function syncAdditionalAcvmReferenceData(db) {
  const imported = db.prepare(
    'SELECT version, imported_at FROM reference_data_imports WHERE version = ?'
  ).get(REFERENCE_DATA_VERSION);
  if (imported) {
    return { applied: false, version: REFERENCE_DATA_VERSION, imported_at: imported.imported_at };
  }

  const apply = db.transaction(() => {
    for (const product of PRODUCTS) {
      const byName = db.prepare('SELECT * FROM drugs WHERE drug_name = ?').get(product.drug_name);
      const byRegistration = db.prepare(
        'SELECT * FROM drugs WHERE acvm_registration_no = ?'
      ).get(product.acvm_registration_no);
      if (byName && byRegistration && byName.id !== byRegistration.id) {
        throw new Error(
          `Reference import conflict for ${product.drug_name} / ${product.acvm_registration_no}`
        );
      }

      let drugId = byName?.id || byRegistration?.id || null;
      if (!drugId) {
        const inserted = db.prepare(`
          INSERT INTO drugs
            (drug_name, active_ingredient, milk_withdrawal_value, milk_withdrawal_unit,
             meat_withdrawal_days, calculation_basis, minimum_dry_period_days,
             whp_depends_on_dose, label_wording, source_reference, verified_on,
             is_active, acvm_registration_no, label_revision, verified_by,
             requires_regimen, current_reference_revision_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NULL)
        `).run(
          product.drug_name, product.active_ingredient, product.milk_withdrawal_value,
          product.milk_withdrawal_unit, product.meat_withdrawal_days,
          product.calculation_basis, product.minimum_dry_period_days,
          product.whp_depends_on_dose, product.label_wording, product.source_reference,
          VERIFIED_ON, product.acvm_registration_no, product.label_revision,
          VERIFIED_BY, product.requires_regimen
        );
        drugId = Number(inserted.lastInsertRowid);
      }

      db.prepare(`
        UPDATE drugs
        SET drug_name = ?, active_ingredient = ?, milk_withdrawal_value = ?,
            milk_withdrawal_unit = ?, meat_withdrawal_days = ?, calculation_basis = ?,
            minimum_dry_period_days = ?, whp_depends_on_dose = ?, label_wording = ?,
            source_reference = ?, verified_on = ?, is_active = 0,
            acvm_registration_no = ?, label_revision = ?, verified_by = ?,
            requires_regimen = ?, current_reference_revision_id = NULL
        WHERE id = ?
      `).run(
        product.drug_name, product.active_ingredient, product.milk_withdrawal_value,
        product.milk_withdrawal_unit, product.meat_withdrawal_days,
        product.calculation_basis, product.minimum_dry_period_days,
        product.whp_depends_on_dose, product.label_wording, product.source_reference,
        VERIFIED_ON, product.acvm_registration_no, product.label_revision,
        VERIFIED_BY, product.requires_regimen, drugId
      );

      let revision = db.prepare(`
        SELECT id FROM drug_reference_revisions
        WHERE drug_id = ? AND label_revision = ?
      `).get(drugId, product.label_revision);
      if (!revision) {
        const inserted = db.prepare(`
          INSERT INTO drug_reference_revisions
            (drug_id, acvm_registration_no, label_revision, label_wording,
             source_reference, verified_on, verified_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          drugId, product.acvm_registration_no, product.label_revision,
          product.label_wording, product.source_reference, VERIFIED_ON, VERIFIED_BY
        );
        revision = { id: Number(inserted.lastInsertRowid) };
      }

      for (const rule of product.rules) {
        const existingRule = db.prepare(`
          SELECT id, reference_revision_id FROM drug_withdrawal_rules
          WHERE drug_id = ? AND rule_code = ?
        `).get(drugId, rule.rule_code);
        if (existingRule && existingRule.reference_revision_id !== revision.id) {
          throw new Error(
            `Stored rule ${product.drug_name}/${rule.rule_code} belongs to another label revision`
          );
        }
        if (!existingRule) {
          db.prepare(`
            INSERT INTO drug_withdrawal_rules
              (drug_id, reference_revision_id, rule_code, rule_name, description,
               milkings_once_daily, milkings_twice_daily, is_default)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            drugId, revision.id, rule.rule_code, rule.rule_name, rule.description,
            rule.milkings_once_daily, rule.milkings_twice_daily, rule.is_default
          );
        }
      }

      const ruleCount = db.prepare(`
        SELECT COUNT(*) AS count FROM drug_withdrawal_rules
        WHERE drug_id = ? AND reference_revision_id = ?
      `).get(drugId, revision.id).count;
      if (product.requires_regimen && ruleCount === 0) {
        throw new Error(`${product.drug_name} cannot activate without a current label rule`);
      }

      db.prepare(`
        UPDATE drugs SET current_reference_revision_id = ?, is_active = 1 WHERE id = ?
      `).run(revision.id, drugId);
    }

    db.prepare(`
      INSERT INTO reference_data_imports (version, source_summary)
      VALUES (?, ?)
    `).run(
      REFERENCE_DATA_VERSION,
      'MPI ACVM Approved Labels: A007712-24, A011329-10 and A009281-20; reviewed 2026-09-28'
    );
  });

  apply();
  return { applied: true, version: REFERENCE_DATA_VERSION, products_added: PRODUCTS.length };
}

module.exports = {
  PRODUCTS,
  REFERENCE_DATA_VERSION,
  syncAdditionalAcvmReferenceData
};
