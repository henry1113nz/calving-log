// 初始演示数据。只在数据库还没有任何牛只时插入一次,所以本文件可以随
// 应用反复启动而不会重复写入或覆盖真实记录。
//
// 药品行先按 v5 字段建立,db.js 随后用带版本号的 ACVM 数据包写入核验凭证、
// 规则版本并给演示事件关联快照。把监管数据导入和普通演示数据分开,以后标签
// 修订时可以新增一个版本,不会悄悄覆盖旧事件的依据。

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

    // 这里只放计算所需的基础形状,核验原文和来源由 acvmReferenceData.js 统一
    // 导入。Bovaclox DC Xtra 的现行批准标签无法在当前注册库取得,因此从一开始
    // 就停用;A004495 Bovaclox Dry Cow 是另一种产品,不能拿来替代。
    db.exec(`
      INSERT INTO drugs
        (drug_name, active_ingredient, milk_withdrawal_value, milk_withdrawal_unit,
         meat_withdrawal_days, calculation_basis, minimum_dry_period_days,
         whp_depends_on_dose, requires_regimen, acvm_registration_no, is_active)
      VALUES
        ('Orbenin L.A.', 'Cloxacillin sodium', 96, 'hours', 3, 'treatment_date',
         NULL, 0, 1, 'A003664', 1),

        ('Mastalone', 'Oxytetracycline hydrochloride / oleandomycin / neomycin / prednisolone',
         8, 'milkings', 30, 'treatment_date', NULL, 0, 0, 'A000829', 1),

        ('Penethaject', 'Penethamate hydriodide', 48, 'hours', 7, 'treatment_date',
         NULL, 0, 0, 'A009423', 1),

        ('Cepravin Dry Cow', 'Cephalonium', 8, 'milkings', 30, 'calving_date',
         49, 0, 0, 'A003322', 1),

        ('Bovaclox DC Xtra', 'Ampicillin / cloxacillin', 8, 'milkings', 30, 'calving_date',
         49, 0, 0, 'A009020', 0),

        ('Teatseal', 'Bismuth subnitrate', 8, 'milkings', 0, 'calving_date',
         NULL, 0, 0, 'A007294', 1)
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
