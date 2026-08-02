const express = require('express');
const db = require('./db');
const { calculateWithdrawalEndDate } = require('./withdrawalCalculator');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static('public'));

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
  const { cow_id, event_type, event_date, calving_date, drug_id, notes, created_by } = req.body;

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
       withdrawal_days_applied, withdrawal_end_date, notes, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    created_by || null
  );

  const newEvent = db.prepare('SELECT * FROM health_events WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(newEvent);
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