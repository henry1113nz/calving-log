const express = require('express');
const db = require('./db');
const { calculateWithdrawal, toDays } = require('./withdrawalCalculator');
const { recommendDryOffTreatment } = require('./dryOffAdvisor');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

// 外键最终由数据库强制,但那会抛异常变成 500。引用了不存在的记录属于请求
// 有问题而不是服务器有问题,所以在这里先查一次,好返回 400 和一句人话。
function findOrNull(table, id) {
  if (id === undefined || id === null || id === '') {
    return null;
  }
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

// 干奶药的停药期按产犊后的挤奶次数算,换成天数要看农场一天挤几次。
function milkingsPerDay() {
  const settings = db.prepare('SELECT milkings_per_day FROM farm_settings WHERE id = 1').get();
  return settings ? settings.milkings_per_day : 2;
}

// 把一条事件交给计算器,返回可以直接写库的三个字段。
function withdrawalFor(event, drug) {
  const result = calculateWithdrawal({
    drug: drug,
    event_date: event.event_date,
    calving_date: event.calving_date || null,
    calving_date_source: event.calving_date_source || null,
    milkings_per_day: milkingsPerDay()
  });
  return {
    withdrawal_days_applied: result.days_applied,
    withdrawal_end_date: result.end_date,
    withdrawal_status: result.status,
    message: result.message
  };
}

// 产犊对账。
//
// 干奶用药时填的产犊日期是预测值,系统却拿它算出了一个解除日并当作事实展示。
// 牛提前产犊时没有任何机制回头修正,记录会一直显示一个已经不成立的日期——
// 这正是行业里"干奶牛提前产犊、奶被挤进大罐"这类事故的成因。
//
// 关键区分:快照冻结的是当时适用的**规则**(停药天数),不是当时手上的**输入**。
// 产犊日期从预测变成事实,是输入变了,解除日必须重算;天数不变。
function reconcilePredictedCalving(cowId, actualCalvingDate) {
  const pending = db.prepare(`
    SELECT health_events.*, drugs.*, health_events.id AS event_id
    FROM health_events
    JOIN drugs ON health_events.drug_id = drugs.id
    WHERE health_events.cow_id = ?
      AND health_events.deleted_at IS NULL
      AND health_events.calving_date_source = 'predicted'
      AND drugs.calculation_basis = 'calving_date'
  `).all(cowId);

  const update = db.prepare(`
    UPDATE health_events
    SET calving_date = ?, calving_date_source = 'actual',
        withdrawal_days_applied = ?, withdrawal_end_date = ?, withdrawal_status = ?
    WHERE id = ?
  `);

  const reconciled = [];

  for (const row of pending) {
    const recalculated = withdrawalFor(
      {
        event_date: row.event_date,
        calving_date: actualCalvingDate,
        calving_date_source: 'actual'
      },
      row
    );

    update.run(
      actualCalvingDate,
      recalculated.withdrawal_days_applied,
      recalculated.withdrawal_end_date,
      recalculated.withdrawal_status,
      row.event_id
    );

    reconciled.push({
      event_id: row.event_id,
      drug_name: row.drug_name,
      previous_calving_date: row.calving_date,
      actual_calving_date: actualCalvingDate,
      previous_end_date: row.withdrawal_end_date,
      new_end_date: recalculated.withdrawal_end_date,
      status: recalculated.withdrawal_status,
      message: recalculated.message
    });
  }

  return reconciled;
}

// ---------- cows ----------

app.get('/api/cows', (req, res) => {
  const cows = db.prepare('SELECT * FROM cows ORDER BY tag_number').all();
  res.json(cows);
});

app.post('/api/cows', (req, res) => {
  const { tag_number, breed, birth_date, lactation_number, status } = req.body;

  if (!tag_number) {
    return res.status(400).json({ error: 'tag_number is required' });
  }

  const stmt = db.prepare(`
    INSERT INTO cows (tag_number, breed, birth_date, lactation_number, status)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    tag_number,
    breed || null,
    birth_date || null,
    lactation_number || null,
    status || 'lactating'
  );

  const newCow = db.prepare('SELECT * FROM cows WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(newCow);
});

// 更新牛只信息。只覆盖请求里明确给出的字段,没给的保持原值,这样前端可以
// 只提交改动的部分而不必回传整条记录。
app.put('/api/cows/:id', (req, res) => {
  const existing = findOrNull('cows', req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Cow not found' });
  }

  const updated = {
    tag_number: req.body.tag_number ?? existing.tag_number,
    breed: req.body.breed ?? existing.breed,
    birth_date: req.body.birth_date ?? existing.birth_date,
    lactation_number: req.body.lactation_number ?? existing.lactation_number,
    status: req.body.status ?? existing.status
  };

  if (!updated.tag_number) {
    return res.status(400).json({ error: 'tag_number cannot be empty' });
  }

  const clash = db.prepare('SELECT id FROM cows WHERE tag_number = ? AND id != ?')
    .get(updated.tag_number, req.params.id);
  if (clash) {
    return res.status(400).json({ error: `tag_number ${updated.tag_number} is already used by another cow` });
  }

  db.prepare(`
    UPDATE cows
    SET tag_number = ?, breed = ?, birth_date = ?, lactation_number = ?, status = ?
    WHERE id = ?
  `).run(
    updated.tag_number,
    updated.breed,
    updated.birth_date,
    updated.lactation_number,
    updated.status,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM cows WHERE id = ?').get(req.params.id));
});

// ---------- drugs ----------

app.get('/api/drugs', (req, res) => {
  const drugs = db.prepare('SELECT * FROM drugs WHERE is_active = 1 ORDER BY drug_name').all();
  const perDay = milkingsPerDay();

  // 未核实的药必须在接口层就标出来。一个没有出处的停药天数看起来和核实过的
  // 一模一样,不主动区分,用的人就无从分辨。
  res.json(drugs.map(drug => ({
    ...drug,
    is_verified: drug.verified_on !== null,
    withdrawal_summary: drug.whp_depends_on_dose
      ? 'Depends on dose — must be entered manually'
      : `${drug.milk_withdrawal_value} ${drug.milk_withdrawal_unit}` +
        (drug.milk_withdrawal_unit === 'milkings' ? ` (${toDays(drug.milk_withdrawal_value, 'milkings', perDay)} days at ${perDay} milkings/day)` : '') +
        ` from the ${drug.calculation_basis === 'calving_date' ? 'calving date' : 'treatment date'}`
  })));
});

// 录入核实过的停药期数据。
//
// 核实的意思是"查过官方来源",不是"填过数字"。所以标记 verified_on 的同时
// 必须给出标签原文和出处——没有凭证的核实声明本身就是不可信的,拦在这里比
// 事后追查便宜得多。
app.put('/api/drugs/:id', (req, res) => {
  const existing = findOrNull('drugs', req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Drug not found' });
  }

  const updated = {
    milk_withdrawal_value: req.body.milk_withdrawal_value ?? existing.milk_withdrawal_value,
    milk_withdrawal_unit: req.body.milk_withdrawal_unit ?? existing.milk_withdrawal_unit,
    meat_withdrawal_days: req.body.meat_withdrawal_days ?? existing.meat_withdrawal_days,
    calculation_basis: req.body.calculation_basis ?? existing.calculation_basis,
    minimum_dry_period_days: req.body.minimum_dry_period_days ?? existing.minimum_dry_period_days,
    whp_depends_on_dose: req.body.whp_depends_on_dose ?? existing.whp_depends_on_dose,
    label_wording: req.body.label_wording ?? existing.label_wording,
    source_reference: req.body.source_reference ?? existing.source_reference,
    verified_on: req.body.verified_on ?? existing.verified_on
  };

  if (!['hours', 'days', 'milkings'].includes(updated.milk_withdrawal_unit)) {
    return res.status(400).json({ error: "milk_withdrawal_unit must be 'hours', 'days' or 'milkings'" });
  }

  if (updated.verified_on && !(updated.label_wording && updated.source_reference)) {
    return res.status(400).json({
      error: 'A drug cannot be marked as verified without both label_wording and ' +
             'source_reference recording where the figure came from'
    });
  }

  if (updated.minimum_dry_period_days !== null && updated.calculation_basis !== 'calving_date') {
    return res.status(400).json({
      error: 'minimum_dry_period_days only applies to drugs counted from the calving date'
    });
  }

  db.prepare(`
    UPDATE drugs
    SET milk_withdrawal_value = ?, milk_withdrawal_unit = ?, meat_withdrawal_days = ?,
        calculation_basis = ?, minimum_dry_period_days = ?, whp_depends_on_dose = ?,
        label_wording = ?, source_reference = ?, verified_on = ?
    WHERE id = ?
  `).run(
    updated.milk_withdrawal_value,
    updated.milk_withdrawal_unit,
    updated.meat_withdrawal_days,
    updated.calculation_basis,
    updated.minimum_dry_period_days,
    updated.whp_depends_on_dose ? 1 : 0,
    updated.label_wording,
    updated.source_reference,
    updated.verified_on,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM drugs WHERE id = ?').get(req.params.id));
});

// 还没核实的药。核实工作本身需要一份清单,这就是那份清单。
app.get('/api/drugs/unverified', (req, res) => {
  const pending = db.prepare(`
    SELECT id, drug_name, active_ingredient, milk_withdrawal_value, milk_withdrawal_unit,
           calculation_basis, whp_depends_on_dose
    FROM drugs
    WHERE is_active = 1 AND verified_on IS NULL
    ORDER BY drug_name
  `).all();

  res.json({
    count: pending.length,
    note: pending.length
      ? 'These withholding periods have not been checked against the ACVM register. ' +
        'Any output derived from them should not be treated as authoritative.'
      : 'All active drugs have been verified.',
    drugs: pending
  });
});

// ---------- farm settings ----------

app.get('/api/settings', (req, res) => {
  res.json(db.prepare('SELECT * FROM farm_settings WHERE id = 1').get());
});

// 挤奶次数改变会改变所有按 milkings 计算的停药期结果,所以这里只改设置,
// 不追溯重算已有记录——那些是快照,记录的是当时适用的规则。
app.put('/api/settings', (req, res) => {
  const { milkings_per_day } = req.body;

  if (![1, 2, 3].includes(milkings_per_day)) {
    return res.status(400).json({ error: 'milkings_per_day must be 1, 2 or 3' });
  }

  db.prepare(`
    UPDATE farm_settings SET milkings_per_day = ?, updated_at = datetime('now') WHERE id = 1
  `).run(milkings_per_day);

  res.json(db.prepare('SELECT * FROM farm_settings WHERE id = 1').get());
});

// ---------- health events ----------

app.get('/api/events', (req, res) => {
  const events = db.prepare(`
    SELECT
      health_events.*,
      cows.tag_number,
      drugs.drug_name,
      drugs.calculation_basis,
      users.name AS created_by_name
    FROM health_events
    JOIN cows ON health_events.cow_id = cows.id
    LEFT JOIN drugs ON health_events.drug_id = drugs.id
    LEFT JOIN users ON health_events.created_by = users.id
    WHERE health_events.deleted_at IS NULL
    ORDER BY health_events.event_date DESC
  `).all();

  res.json(events);
});

app.post('/api/events', (req, res) => {
  const { cow_id, event_type, event_date, calving_date, drug_id, notes, created_by, diagnosis } = req.body;

  if (!cow_id || !event_type || !event_date) {
    return res.status(400).json({ error: 'cow_id, event_type and event_date are required' });
  }

  const cow = db.prepare('SELECT * FROM cows WHERE id = ?').get(cow_id);
  if (!cow) {
    return res.status(400).json({ error: 'cow_id does not match any known cow' });
  }

  let drug = null;
  if (drug_id) {
    drug = db.prepare('SELECT * FROM drugs WHERE id = ?').get(drug_id);
    if (!drug) {
      return res.status(400).json({ error: 'drug_id does not match any known drug' });
    }
  }

  if (created_by && !findOrNull('users', created_by)) {
    return res.status(400).json({ error: 'created_by does not match any known user' });
  }

  // 产犊事件本身就是产犊日期的事实来源。其它事件填的产犊日期是预测值,
  // 除非调用方明确说明这是实际日期。
  const calvingDateSource = event_type === 'calving'
    ? 'actual'
    : (calving_date ? (req.body.calving_date_source || 'predicted') : null);

  const effectiveCalvingDate = event_type === 'calving'
    ? (calving_date || event_date)
    : (calving_date || null);

  // 计算停药期,并把结果连同当时适用的天数一起作为快照存下来
  const withdrawal = withdrawalFor(
    { event_date, calving_date: effectiveCalvingDate, calving_date_source: calvingDateSource },
    drug
  );

  const stmt = db.prepare(`
    INSERT INTO health_events
      (cow_id, event_type, event_date, calving_date, calving_date_source, drug_id,
       withdrawal_days_applied, withdrawal_end_date, withdrawal_status,
       notes, created_by, diagnosis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    cow_id,
    event_type,
    event_date,
    effectiveCalvingDate,
    calvingDateSource,
    drug_id || null,
    withdrawal.withdrawal_days_applied,
    withdrawal.withdrawal_end_date,
    withdrawal.withdrawal_status,
    notes || null,
    created_by || null,
    diagnosis || null
  );

  // 记录产犊,就是这头牛的产犊日期从预测变成事实的时刻。此前按预测日期算出的
  // 干奶期解除日必须在这一刻重算,否则牛提前产犊时记录会一直停在旧日期上。
  const reconciled = event_type === 'calving'
    ? reconcilePredictedCalving(cow_id, effectiveCalvingDate)
    : [];

  const newEvent = db.prepare('SELECT * FROM health_events WHERE id = ?').get(result.lastInsertRowid);

  res.status(201).json({
    ...newEvent,
    withdrawal_message: withdrawal.message,
    reconciled_dry_off_events: reconciled
  });
});

// 更正已有事件。改了药或改了日期,停药期快照必须跟着重算——留着旧的解除日
// 比没有解除日更危险,因为它看起来是可信的。
//
// 重算用的是药物表当前的天数,而不是原记录当时的天数:这是一次更正,意思是
// "本来就该是这样",不是在回放历史。真正需要冻结历史的是没被更正过的记录,
// 那些记录的快照本来就不会被动。
app.put('/api/events/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM health_events WHERE id = ?').get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Event not found' });
  }
  if (existing.deleted_at) {
    return res.status(404).json({ error: 'Event has been deleted and cannot be updated' });
  }

  const updated = {
    cow_id: req.body.cow_id ?? existing.cow_id,
    event_type: req.body.event_type ?? existing.event_type,
    event_date: req.body.event_date ?? existing.event_date,
    calving_date: req.body.calving_date ?? existing.calving_date,
    drug_id: req.body.drug_id ?? existing.drug_id,
    notes: req.body.notes ?? existing.notes,
    created_by: req.body.created_by ?? existing.created_by,
    diagnosis: req.body.diagnosis ?? existing.diagnosis,
    calving_date_source: req.body.calving_date_source ?? existing.calving_date_source
  };

  if (!findOrNull('cows', updated.cow_id)) {
    return res.status(400).json({ error: 'cow_id does not match any known cow' });
  }

  let drug = null;
  if (updated.drug_id) {
    drug = findOrNull('drugs', updated.drug_id);
    if (!drug) {
      return res.status(400).json({ error: 'drug_id does not match any known drug' });
    }
  }

  if (updated.created_by && !findOrNull('users', updated.created_by)) {
    return res.status(400).json({ error: 'created_by does not match any known user' });
  }

  // 更正后的产犊日期如果没有明说来源,而记录里原本也没有,就仍当预测值处理。
  if (updated.calving_date && !updated.calving_date_source) {
    updated.calving_date_source = 'predicted';
  }

  const withdrawal = withdrawalFor(updated, drug);

  db.prepare(`
    UPDATE health_events
    SET cow_id = ?, event_type = ?, event_date = ?, calving_date = ?, calving_date_source = ?,
        drug_id = ?, withdrawal_days_applied = ?, withdrawal_end_date = ?, withdrawal_status = ?,
        notes = ?, created_by = ?, diagnosis = ?
    WHERE id = ?
  `).run(
    updated.cow_id,
    updated.event_type,
    updated.event_date,
    updated.calving_date,
    updated.calving_date_source,
    updated.drug_id,
    withdrawal.withdrawal_days_applied,
    withdrawal.withdrawal_end_date,
    withdrawal.withdrawal_status,
    updated.notes,
    updated.created_by,
    updated.diagnosis,
    req.params.id
  );

  res.json({
    ...db.prepare('SELECT * FROM health_events WHERE id = ?').get(req.params.id),
    withdrawal_message: withdrawal.message
  });
});

// 软删除:只标记 deleted_at,不真正移除记录
app.delete('/api/events/:id', (req, res) => {
  const { id } = req.params;

  const stmt = db.prepare(`
    UPDATE health_events
    SET deleted_at = datetime('now')
    WHERE id = ? AND deleted_at IS NULL
  `);
  const result = stmt.run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Event not found' });
  }

  res.status(204).send();
});

// ---------- vat exclusions (today's "don't milk these into the vat" list) ----------

app.get('/api/vat-exclusions', (req, res) => {
  const today = new Date().toISOString().split('T')[0];

  const exclusions = db.prepare(`
    SELECT
      health_events.id,
      cows.tag_number,
      health_events.event_type,
      health_events.event_date,
      drugs.drug_name,
      drugs.verified_on AS drug_verified_on,
      health_events.withdrawal_end_date,
      health_events.calving_date,
      health_events.calving_date_source
    FROM health_events
    JOIN cows ON health_events.cow_id = cows.id
    LEFT JOIN drugs ON health_events.drug_id = drugs.id
    WHERE health_events.deleted_at IS NULL
      AND health_events.withdrawal_end_date IS NOT NULL
      AND health_events.withdrawal_end_date >= ?
    ORDER BY health_events.withdrawal_end_date ASC
  `).all(today);

  const withDaysRemaining = exclusions.map(row => {
    // 解除日建立在预测产犊日期上时,它只是个估计:牛提前产犊,这个日期就不成立。
    // 挤奶工必须看得出哪些日期是确定的、哪些不是,否则他们会一视同仁地相信。
    const warnings = [];
    if (row.calving_date_source === 'predicted') {
      warnings.push(
        `Clear date is based on an expected calving date of ${row.calving_date}. ` +
        'It will be recalculated when the actual calving is recorded.'
      );
    }
    if (row.drug_name && !row.drug_verified_on) {
      warnings.push(
        `The withholding period recorded for ${row.drug_name} has not been verified ` +
        'against the ACVM register.'
      );
    }

    return {
      ...row,
      days_remaining: Math.ceil((new Date(row.withdrawal_end_date) - new Date(today)) / (1000 * 60 * 60 * 24)),
      is_estimate: row.calving_date_source === 'predicted',
      warnings
    };
  });

  // 算不出解除日的用药事件同样必须上清单,而且优先级更高。
  //
  // 这类记录的 withdrawal_end_date 是 NULL,按日期条件筛选会把它们整个漏掉——
  // 于是"因为算不出来所以最危险"的牛,反而成了清单上看不见的牛。剂量依赖尚未
  // 填写、以及最小干奶期被打破,都属于这一类:在有人处理之前,这些牛的奶一律
  // 不能进大罐。
  const unresolved = db.prepare(`
    SELECT
      health_events.id,
      cows.tag_number,
      health_events.event_type,
      health_events.event_date,
      drugs.drug_name,
      health_events.withdrawal_status
    FROM health_events
    JOIN cows ON health_events.cow_id = cows.id
    LEFT JOIN drugs ON health_events.drug_id = drugs.id
    WHERE health_events.deleted_at IS NULL
      AND health_events.withdrawal_status IN ('requires_vet_advice', 'minimum_dry_period_breached')
    ORDER BY health_events.event_date DESC
  `).all().map(row => ({
    ...row,
    withdrawal_end_date: null,
    days_remaining: null,
    is_estimate: false,
    requires_attention: true,
    warnings: [
      row.withdrawal_status === 'minimum_dry_period_breached'
        ? 'This cow calved sooner than the label allows after dry cow treatment. ' +
          'The standard withholding period does not apply. Seek veterinary advice ' +
          'before her milk goes in the vat.'
        : `The withholding period for ${row.drug_name} depends on the dose given and has ` +
          'not been entered. Keep this cow out of the vat until it is recorded.'
    ]
  }));

  // 需要处理的排在前面:没有解除日的牛比"还有三天"的牛更需要有人去看一眼。
  res.json([...unresolved, ...withDaysRemaining]);
});

// ---------- users ----------

app.get('/api/users', (req, res) => {
  const users = db.prepare('SELECT * FROM users ORDER BY name').all();
  res.json(users);
});

app.post('/api/users', (req, res) => {
  const { name, role } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'name is required' });
  }

  const stmt = db.prepare('INSERT INTO users (name, role) VALUES (?, ?)');
  const result = stmt.run(name, role || 'milker');

  const newUser = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(newUser);
});

// ---------- scc records ----------

app.get('/api/scc', (req, res) => {
  const records = db.prepare(`
    SELECT scc_records.*, cows.tag_number
    FROM scc_records
    JOIN cows ON scc_records.cow_id = cows.id
    ORDER BY scc_records.test_date DESC
  `).all();
  res.json(records);
});

app.post('/api/scc', (req, res) => {
  const { cow_id, test_date, scc_value, source } = req.body;

  if (!cow_id || !test_date || scc_value == null) {
    return res.status(400).json({ error: 'cow_id, test_date and scc_value are required' });
  }

  const cow = db.prepare('SELECT * FROM cows WHERE id = ?').get(cow_id);
  if (!cow) {
    return res.status(400).json({ error: 'cow_id does not match any known cow' });
  }

  const stmt = db.prepare(`
    INSERT INTO scc_records (cow_id, test_date, scc_value, source)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(cow_id, test_date, scc_value, source || 'herd_test');

  const newRecord = db.prepare('SELECT * FROM scc_records WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(newRecord);
});

// ---------- dry off recommendation ----------

// 新西兰的产季跨年,'2026-27' 指 2026 年 6 月 1 日到 2027 年 5 月 31 日。
// 判定要看的是"本泌乳期"的数据,不是这头牛一辈子的数据,所以要把范围框出来。
function seasonDateRange(season) {
  const startYear = Number(season.slice(0, 4));
  return { start: `${startYear}-06-01`, end: `${startYear + 1}-05-31` };
}

app.get('/api/cows/:id/dry-off-recommendation', (req, res) => {
  const cow = findOrNull('cows', req.params.id);
  if (!cow) {
    return res.status(404).json({ error: 'Cow not found' });
  }

  const season = req.query.season;
  if (season && !/^\d{4}-\d{2}$/.test(season)) {
    return res.status(400).json({ error: "season must look like '2026-27'" });
  }
  const range = season ? seasonDateRange(season) : null;

  const sccRecords = range
    ? db.prepare(`SELECT test_date, scc_value, source FROM scc_records
                  WHERE cow_id = ? AND test_date BETWEEN ? AND ?
                  ORDER BY test_date`).all(cow.id, range.start, range.end)
    : db.prepare(`SELECT test_date, scc_value, source FROM scc_records
                  WHERE cow_id = ? ORDER BY test_date`).all(cow.id);

  const mastitisEvents = range
    ? db.prepare(`SELECT event_date, notes FROM health_events
                  WHERE cow_id = ? AND diagnosis = 'clinical_mastitis'
                    AND deleted_at IS NULL AND event_date BETWEEN ? AND ?
                  ORDER BY event_date`).all(cow.id, range.start, range.end)
    : db.prepare(`SELECT event_date, notes FROM health_events
                  WHERE cow_id = ? AND diagnosis = 'clinical_mastitis'
                    AND deleted_at IS NULL ORDER BY event_date`).all(cow.id);

  const advice = recommendDryOffTreatment({
    lactation_number: cow.lactation_number,
    scc_records: sccRecords,
    mastitis_events: mastitisEvents
  });

  res.json({
    cow: { id: cow.id, tag_number: cow.tag_number, lactation_number: cow.lactation_number },
    season: season || 'all records',
    ...advice
  });
});

// ---------- dry off decisions ----------

app.get('/api/decisions', (req, res) => {
  const decisions = db.prepare(`
    SELECT
      dry_off_decisions.*,
      cows.tag_number,
      scc_records.scc_value AS supporting_scc_value,
      scc_records.test_date AS supporting_scc_date,
      users.name AS decided_by_name
    FROM dry_off_decisions
    JOIN cows ON dry_off_decisions.cow_id = cows.id
    LEFT JOIN scc_records ON dry_off_decisions.supporting_scc_id = scc_records.id
    LEFT JOIN users ON dry_off_decisions.decided_by = users.id
    ORDER BY dry_off_decisions.decided_at DESC
  `).all();
  res.json(decisions);
});

app.post('/api/decisions', (req, res) => {
  const { cow_id, season, decision, justification, supporting_scc_id, decided_by } = req.body;

  if (!cow_id || !season || !decision) {
    return res.status(400).json({ error: 'cow_id, season and decision are required' });
  }

  const cow = db.prepare('SELECT * FROM cows WHERE id = ?').get(cow_id);
  if (!cow) {
    return res.status(400).json({ error: 'cow_id does not match any known cow' });
  }

  if (supporting_scc_id && !findOrNull('scc_records', supporting_scc_id)) {
    return res.status(400).json({ error: 'supporting_scc_id does not match any known SCC record' });
  }

  if (decided_by && !findOrNull('users', decided_by)) {
    return res.status(400).json({ error: 'decided_by does not match any known user' });
  }

  const alreadyDecided = db.prepare(
    'SELECT id FROM dry_off_decisions WHERE cow_id = ? AND season = ?'
  ).get(cow_id, season);
  if (alreadyDecided) {
    return res.status(400).json({
      error: `Cow ${cow.tag_number} already has a dry-off decision recorded for season ${season}`
    });
  }

  const stmt = db.prepare(`
    INSERT INTO dry_off_decisions
      (cow_id, season, decision, justification, supporting_scc_id, decided_by)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    cow_id,
    season,
    decision,
    justification || null,
    supporting_scc_id || null,
    decided_by || null
  );

  const newDecision = db.prepare('SELECT * FROM dry_off_decisions WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(newDecision);
});

// ---------- 全局错误处理 ----------

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(PORT, () => {
  console.log(`Server is listening on http://localhost:${PORT}`);
});