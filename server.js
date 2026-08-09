const express = require('express');
const db = require('./db');
const { calculateWithdrawalEndDate } = require('./withdrawalCalculator');
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
  res.json(drugs);
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

  // 计算停药期,并把结果作为快照存下来
  let withdrawalDays = null;
  let withdrawalEndDate = null;

  if (drug) {
    withdrawalDays = drug.milk_withdrawal_days;
    withdrawalEndDate = calculateWithdrawalEndDate({
      milk_withdrawal_days: drug.milk_withdrawal_days,
      calculation_basis: drug.calculation_basis,
      event_date: event_date,
      calving_date: calving_date || null
    });
  }

  const stmt = db.prepare(`
    INSERT INTO health_events
      (cow_id, event_type, event_date, calving_date, drug_id,
       withdrawal_days_applied, withdrawal_end_date, notes, created_by, diagnosis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    cow_id,
    event_type,
    event_date,
    calving_date || null,
    drug_id || null,
    withdrawalDays,
    withdrawalEndDate,
    notes || null,
    created_by || null,
    diagnosis || null
  );

  const newEvent = db.prepare('SELECT * FROM health_events WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(newEvent);
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
    diagnosis: req.body.diagnosis ?? existing.diagnosis
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

  let withdrawalDays = null;
  let withdrawalEndDate = null;

  if (drug) {
    withdrawalDays = drug.milk_withdrawal_days;
    withdrawalEndDate = calculateWithdrawalEndDate({
      milk_withdrawal_days: drug.milk_withdrawal_days,
      calculation_basis: drug.calculation_basis,
      event_date: updated.event_date,
      calving_date: updated.calving_date
    });
  }

  db.prepare(`
    UPDATE health_events
    SET cow_id = ?, event_type = ?, event_date = ?, calving_date = ?, drug_id = ?,
        withdrawal_days_applied = ?, withdrawal_end_date = ?, notes = ?, created_by = ?,
        diagnosis = ?
    WHERE id = ?
  `).run(
    updated.cow_id,
    updated.event_type,
    updated.event_date,
    updated.calving_date,
    updated.drug_id,
    withdrawalDays,
    withdrawalEndDate,
    updated.notes,
    updated.created_by,
    updated.diagnosis,
    req.params.id
  );

  res.json(db.prepare('SELECT * FROM health_events WHERE id = ?').get(req.params.id));
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
      health_events.withdrawal_end_date
    FROM health_events
    JOIN cows ON health_events.cow_id = cows.id
    LEFT JOIN drugs ON health_events.drug_id = drugs.id
    WHERE health_events.deleted_at IS NULL
      AND health_events.withdrawal_end_date IS NOT NULL
      AND health_events.withdrawal_end_date >= ?
    ORDER BY health_events.withdrawal_end_date ASC
  `).all(today);

  const withDaysRemaining = exclusions.map(row => ({
    ...row,
    days_remaining: Math.ceil((new Date(row.withdrawal_end_date) - new Date(today)) / (1000 * 60 * 60 * 24))
  }));

  res.json(withDaysRemaining);
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