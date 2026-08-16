// 初始演示数据。只在数据库还没有任何牛只时插入一次,所以本文件可以随
// 应用反复启动而不会重复写入或覆盖真实记录。
//
// 注意:drugs 表里的停药天数目前只有部分经过公开来源核对,其余为占位值,
// 必须在系统被当作能产出可信结果之前对照 MPI 的 ACVM register 逐一核实。
// 见 docs/schema.md 的 "Reference data status" 一节。

function seed(db) {
  const alreadySeeded = db.prepare('SELECT COUNT(*) AS count FROM cows').get().count > 0;
  if (alreadySeeded) {
    return false;
  }

  const insertAll = db.transaction(() => {
    db.exec(`
      INSERT INTO users (name, role) VALUES
        ('Farm Owner', 'owner'),
        ('Relief Milker', 'milker'),
        ('Farm Vet', 'vet')
    `);

    // verified_on 为空 = 未经核实。除 Cepravin 外,以下数值都是开发初期的占位值,
    // 单位一律按 'days' 迁移过来,但真实标签未必用天来表达。必须逐个对照 ACVM
    // 注册库与厂商标签核实后,连同 label_wording / source_reference / verified_on
    // 一起更新。核实之前,系统会把这些药标记为未核实。
    //
    // Cepravin 的数据来自 MSD 官方产品页的标签原文,已按标签的真实单位(挤奶次数)
    // 和最小干奶期录入,但仍留 verified_on 为空,等对照 ACVM 注册库确认后再签署。
    //
    // Penethaject 标记为剂量依赖:VCNZ 2023 年通告指出 procaine penicillin 类
    // 产品的标签剂量普遍偏低已被要求上调,而剂量提高则停药期必须相应延长。
    // 这类药不自动计算停药期,强制录入人按处方填写。
    db.exec(`
      INSERT INTO drugs
        (drug_name, active_ingredient, milk_withdrawal_value, milk_withdrawal_unit,
         meat_withdrawal_days, calculation_basis, minimum_dry_period_days,
         whp_depends_on_dose, label_wording, source_reference, verified_on)
      VALUES
        ('Orbenin L.A.', 'Cloxacillin', 4, 'days', 7, 'treatment_date',
         NULL, 0, NULL, NULL, NULL),

        ('Mastalone', 'Oxytetracycline', 4, 'days', 7, 'treatment_date',
         NULL, 0, NULL, NULL, NULL),

        ('Penethaject', 'Procaine penicillin', 3, 'days', 10, 'treatment_date',
         NULL, 1, NULL,
         'Dose-dependent: see VCNZ 2023 notice on penicillin withholding periods and the MPI penicillin product table',
         NULL),

        ('Cepravin Dry Cow', 'Cephalonium', 8, 'milkings', 28, 'calving_date',
         49, 0,
         'Treatment to be at least 49 days before calving. Milk from the first 8 milkings after calving must be discarded',
         'https://www.msd-animal-health.co.nz/products/cepravin-dry-cow/',
         NULL),

        ('Bovaclox DC Xtra', 'Cloxacillin / Ampicillin', 7, 'days', 28, 'calving_date',
         NULL, 0, NULL, NULL, NULL),

        ('Teatseal', 'Bismuth subnitrate', 0, 'days', 0, 'treatment_date',
         NULL, 0, NULL, NULL, NULL)
    `);

    db.exec(`
      INSERT INTO cows (tag_number, breed, lactation_number, status) VALUES
        ('212', 'Friesian', 3, 'lactating'),
        ('105', 'Jersey', 1, 'lactating'),
        ('308', 'Kiwicross', 5, 'dry'),
        ('417', 'Friesian', 2, 'lactating')
    `);

    db.exec(`
      INSERT INTO scc_records (cow_id, test_date, scc_value, source) VALUES
        ((SELECT id FROM cows WHERE tag_number='212'), '2026-06-18', 187000, 'herd_test'),
        ((SELECT id FROM cows WHERE tag_number='105'), '2026-06-18', 94000,  'herd_test'),
        ((SELECT id FROM cows WHERE tag_number='308'), '2026-06-18', 312000, 'herd_test'),
        ((SELECT id FROM cows WHERE tag_number='417'), '2026-06-18', 121000, 'herd_test')
    `);

    db.exec(`
      INSERT INTO health_events
        (cow_id, event_type, event_date, calving_date, calving_date_source, drug_id, diagnosis,
         withdrawal_days_applied, withdrawal_end_date, withdrawal_status, notes, created_by)
      VALUES
        ((SELECT id FROM cows WHERE tag_number='212'), 'treatment', '2026-07-18', NULL, NULL,
         (SELECT id FROM drugs WHERE drug_name='Orbenin L.A.'), 'clinical_mastitis',
         4, '2026-07-22', 'calculated',
         'Clinical mastitis, left front quarter', (SELECT id FROM users WHERE name='Farm Owner')),

        ((SELECT id FROM cows WHERE tag_number='105'), 'calving', '2026-07-10', '2026-07-10', 'actual',
         NULL, NULL, NULL, NULL, 'not_applicable',
         'Normal calving', (SELECT id FROM users WHERE name='Relief Milker')),

        -- 干奶用药时产犊日期只是预测值,标记为 predicted。牛真正产犊时,记录产犊
        -- 事件会把这条的解除日按实际日期重算。
        ((SELECT id FROM cows WHERE tag_number='308'), 'dry_off', '2026-07-05', '2026-09-15', 'predicted',
         (SELECT id FROM drugs WHERE drug_name='Cepravin Dry Cow'), NULL,
         4, '2026-09-19', 'calculated',
         'Dry cow therapy at drying off', (SELECT id FROM users WHERE name='Farm Vet')),

        ((SELECT id FROM cows WHERE tag_number='417'), 'calcium', '2026-07-22', NULL, NULL,
         NULL, NULL, NULL, NULL, 'not_applicable',
         'Preventive calcium after calving', (SELECT id FROM users WHERE name='Farm Owner'))
    `);

    db.exec(`
      INSERT INTO dry_off_decisions (cow_id, season, decision, justification, supporting_scc_id, decided_by) VALUES
        ((SELECT id FROM cows WHERE tag_number='308'), '2026-27', 'antibiotic_dct',
         'Herd test SCC 312,000 exceeds 150,000 threshold',
         (SELECT id FROM scc_records WHERE cow_id=(SELECT id FROM cows WHERE tag_number='308')),
         (SELECT id FROM users WHERE name='Farm Vet')),

        ((SELECT id FROM cows WHERE tag_number='105'), '2026-27', 'teat_seal_only',
         'Herd test SCC 94,000 below 125,000 threshold for first lactation',
         (SELECT id FROM scc_records WHERE cow_id=(SELECT id FROM cows WHERE tag_number='105')),
         (SELECT id FROM users WHERE name='Farm Vet'))
    `);
  });

  insertAll();
  return true;
}

module.exports = { seed };
