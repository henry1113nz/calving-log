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

    db.exec(`
      INSERT INTO drugs (drug_name, active_ingredient, milk_withdrawal_days, meat_withdrawal_days, calculation_basis) VALUES
        ('Orbenin L.A.', 'Cloxacillin', 4, 7, 'treatment_date'),
        ('Mastalone', 'Oxytetracycline', 4, 7, 'treatment_date'),
        ('Penethaject', 'Procaine penicillin', 3, 10, 'treatment_date'),
        ('Cepravin Dry Cow', 'Cephalonium', 4, 28, 'calving_date'),
        ('Bovaclox DC Xtra', 'Cloxacillin / Ampicillin', 7, 28, 'calving_date'),
        ('Teatseal', 'Bismuth subnitrate', 0, 0, 'treatment_date')
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
        (cow_id, event_type, event_date, calving_date, drug_id, withdrawal_days_applied, withdrawal_end_date, notes, created_by)
      VALUES
        ((SELECT id FROM cows WHERE tag_number='212'), 'treatment', '2026-07-18', NULL,
         (SELECT id FROM drugs WHERE drug_name='Orbenin L.A.'), 4, '2026-07-22',
         'Clinical mastitis, left front quarter', (SELECT id FROM users WHERE name='Farm Owner')),

        ((SELECT id FROM cows WHERE tag_number='105'), 'calving', '2026-07-10', NULL,
         NULL, NULL, NULL, 'Normal calving', (SELECT id FROM users WHERE name='Relief Milker')),

        ((SELECT id FROM cows WHERE tag_number='308'), 'dry_off', '2026-07-05', '2026-09-15',
         (SELECT id FROM drugs WHERE drug_name='Cepravin Dry Cow'), 4, '2026-09-19',
         'Dry cow therapy at drying off', (SELECT id FROM users WHERE name='Farm Vet')),

        ((SELECT id FROM cows WHERE tag_number='417'), 'calcium', '2026-07-22', NULL,
         NULL, NULL, NULL, 'Preventive calcium after calving', (SELECT id FROM users WHERE name='Farm Owner'))
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
