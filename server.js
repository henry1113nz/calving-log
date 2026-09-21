const express = require('express');
const db = require('./db');
const { addDays, calculateWithdrawal, toDays } = require('./withdrawalCalculator');
const { recommendDryOffTreatment } = require('./dryOffAdvisor');
const { classifyIntent } = require('./assistant');
const {
  clearCookieHeader, cookieHeader, createSession, parseCookies, passwordFields,
  requireAuth, requireRole, tokenHash, verifyPassword
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(express.json());
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(express.static('public'));

const authRequired = requireAuth(db);
const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 10;

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', schema_version: db.pragma('user_version', { simple: true }) });
});

app.post('/api/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  const cleanUsername = String(username || '').trim();
  const attemptKey = `${req.ip}:${cleanUsername.toLowerCase()}`;
  const now = Date.now();
  const previous = loginAttempts.get(attemptKey);
  if (previous && previous.resetAt > now && previous.count >= LOGIN_MAX_ATTEMPTS) {
    res.setHeader('Retry-After', Math.ceil((previous.resetAt - now) / 1000));
    return res.status(429).json({ error: 'Too many sign-in attempts. Try again in 15 minutes.' });
  }
  if (previous && previous.resetAt <= now) loginAttempts.delete(attemptKey);

  const user = cleanUsername
    ? db.prepare('SELECT * FROM users WHERE username = ?').get(cleanUsername)
    : null;
  if (!user || !verifyPassword(password, user)) {
    const current = loginAttempts.get(attemptKey);
    loginAttempts.set(attemptKey, {
      count: (current?.count || 0) + 1,
      resetAt: current?.resetAt || now + LOGIN_WINDOW_MS
    });
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  loginAttempts.delete(attemptKey);
  const session = createSession(db, user.id);
  res.setHeader('Set-Cookie', cookieHeader(session.token, req.secure));
  res.json({ id: user.id, name: user.name, username: user.username, role: user.role });
});

app.get('/api/auth/me', authRequired, (req, res) => {
  res.json({ id: req.user.id, name: req.user.name, username: req.user.username, role: req.user.role });
});

app.post('/api/auth/logout', authRequired, (req, res) => {
  const token = parseCookies(req.headers.cookie || '').calvinglog_session;
  if (token) db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(tokenHash(token));
  res.setHeader('Set-Cookie', clearCookieHeader(req.secure));
  res.status(204).send();
});

app.use('/api', authRequired);

app.post('/api/auth/change-password', (req, res) => {
  const currentPassword = String(req.body?.current_password || '');
  const newPassword = String(req.body?.new_password || '');
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);

  if (!verifyPassword(currentPassword, user)) {
    return res.status(400).json({ error: 'Current password is incorrect' });
  }
  if (newPassword.length < 12) {
    return res.status(400).json({ error: 'New password must contain at least 12 characters' });
  }
  if (verifyPassword(newPassword, user)) {
    return res.status(400).json({ error: 'Choose a new password that is different from the current password' });
  }

  const credentials = passwordFields(newPassword);
  db.transaction(() => {
    db.prepare(`
      UPDATE users SET password_salt = ?, password_hash = ? WHERE id = ?
    `).run(credentials.password_salt, credentials.password_hash, req.user.id);
    db.prepare('DELETE FROM auth_sessions WHERE user_id = ?').run(req.user.id);
  })();

  const session = createSession(db, req.user.id);
  res.setHeader('Set-Cookie', cookieHeader(session.token, req.secure));
  res.json({ message: 'Password changed. Other signed-in sessions have been closed.' });
});

// 外键最终由数据库强制,但那会抛异常变成 500。引用了不存在的记录属于请求
// 有问题而不是服务器有问题,所以在这里先查一次,好返回 400 和一句人话。
function findOrNull(table, id) {
  if (id === undefined || id === null || id === '') {
    return null;
  }
  return db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id);
}

function canonicalDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function milkingSchedule() {
  return db.prepare(`
    SELECT id, effective_from, milkings_per_day, note, created_by, created_at
    FROM milking_schedule
    ORDER BY effective_from
  `).all();
}

// Milking frequency is effective-dated rather than a permanent farm constant. Dry-cow
// products resolve it at calving; lactating-cow products resolve it at treatment.
function milkingsPerDayOn(dateString) {
  const scheduled = dateString && db.prepare(`
    SELECT milkings_per_day
    FROM milking_schedule
    WHERE effective_from <= ?
    ORDER BY effective_from DESC
    LIMIT 1
  `).get(dateString);
  if (scheduled) return scheduled.milkings_per_day;

  const settings = db.prepare('SELECT milkings_per_day FROM farm_settings WHERE id = 1').get();
  return settings ? settings.milkings_per_day : 2;
}

function drugUsesMilkingFrequency(drug) {
  return Boolean(drug && (drug.milk_withdrawal_unit === 'milkings' || drug.requires_regimen));
}

function ruleForEvent(event, drug) {
  if (!drug || !event.drug_rule_id) {
    return null;
  }
  return db.prepare(`
    SELECT * FROM drug_withdrawal_rules WHERE id = ? AND drug_id = ?
  `).get(event.drug_rule_id, drug.id) || null;
}

// 把一条事件交给计算器,返回可以直接写库的三个字段。
function withdrawalFor(event, drug, selectedRule = undefined) {
  const rule = selectedRule === undefined ? ruleForEvent(event, drug) : selectedRule;
  const basisDate = drug?.calculation_basis === 'calving_date'
    ? (event.calving_date || event.event_date)
    : event.event_date;
  const suppliedFrequency = event.milkings_per_day_applied;
  const override = suppliedFrequency === null || suppliedFrequency === undefined
    ? null
    : Number(suppliedFrequency);
  const schedule = milkingSchedule();
  const appliedFrequency = drugUsesMilkingFrequency(drug)
    ? (override || milkingsPerDayOn(basisDate))
    : null;
  const scheduleForCalculation = override ? [] : schedule;
  const result = calculateWithdrawal({
    drug: drug,
    rule: rule,
    event_date: event.event_date,
    calving_date: event.calving_date || null,
    calving_date_source: event.calving_date_source || null,
    milkings_per_day: appliedFrequency || 2,
    milking_schedule: scheduleForCalculation
  });

  const scheduleSnapshot = drugUsesMilkingFrequency(drug)
    ? JSON.stringify(override
        ? [{
            effective_from: basisDate,
            milkings_per_day: override,
            source: 'event_override'
          }]
        : schedule.map(entry => ({
            id: entry.id,
            effective_from: entry.effective_from,
            milkings_per_day: entry.milkings_per_day
          })))
    : null;

  return {
    withdrawal_days_applied: result.days_applied,
    withdrawal_end_date: result.end_date,
    withdrawal_status: result.status,
    milkings_per_day_applied: appliedFrequency,
    milking_schedule_snapshot: scheduleSnapshot,
    message: result.message
  };
}

const REVIEW_STATUSES = new Set([
  'awaiting_calving_date', 'requires_vet_advice', 'minimum_dry_period_breached'
]);

function openEventReview(eventId, reason, openedBy) {
  const existing = db.prepare(`
    SELECT id FROM event_reviews WHERE health_event_id = ? AND status = 'open'
  `).get(eventId);
  if (existing) {
    db.prepare(`UPDATE event_reviews SET reason = ? WHERE id = ?`).run(reason, existing.id);
    return existing.id;
  }
  return db.prepare(`
    INSERT INTO event_reviews (health_event_id, reason, opened_by)
    VALUES (?, ?, ?)
  `).run(eventId, reason, openedBy || null).lastInsertRowid;
}

function resolveOpenEventReview(eventId, resolution, resolvedBy) {
  db.prepare(`
    UPDATE event_reviews
    SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = datetime('now')
    WHERE health_event_id = ? AND status = 'open'
  `).run(resolution, resolvedBy, eventId);
}

// 产犊对账。
//
// 干奶用药时填的产犊日期是预测值,系统却拿它算出了一个解除日并当作事实展示。
// 牛提前产犊时没有任何机制回头修正,记录会一直显示一个已经不成立的日期——
// 这正是行业里"干奶牛提前产犊、奶被挤进大罐"这类事故的成因。
//
// 关键区分:快照冻结的是当时适用的**规则**(停药天数),不是当时手上的**输入**。
// 产犊日期从预测变成事实,是输入变了,解除日必须重算;天数不变。
function reconcilePredictedCalving(cowId, actualCalvingDate, reconciledBy) {
  const pending = db.prepare(`
    SELECT health_events.*, drugs.*, health_events.id AS event_id
    FROM health_events
    JOIN drugs ON health_events.drug_id = drugs.id
    WHERE health_events.cow_id = ?
      AND health_events.deleted_at IS NULL
      AND (
        health_events.calving_date_source = 'predicted'
        OR health_events.withdrawal_status = 'awaiting_calving_date'
      )
      AND drugs.calculation_basis = 'calving_date'
  `).all(cowId);

  const update = db.prepare(`
    UPDATE health_events
    SET calving_date = ?, calving_date_source = 'actual',
        withdrawal_days_applied = ?, withdrawal_end_date = ?, withdrawal_status = ?,
        milkings_per_day_applied = ?, milking_schedule_snapshot = ?
    WHERE id = ?
  `);

  const reconciled = [];

  for (const row of pending) {
    const recalculated = withdrawalFor(
      {
        event_date: row.event_date,
        calving_date: actualCalvingDate,
        calving_date_source: 'actual',
        drug_rule_id: row.drug_rule_id
      },
      row
    );

    update.run(
      actualCalvingDate,
      recalculated.withdrawal_days_applied,
      recalculated.withdrawal_end_date,
      recalculated.withdrawal_status,
      recalculated.milkings_per_day_applied,
      recalculated.milking_schedule_snapshot,
      row.event_id
    );

    if (REVIEW_STATUSES.has(recalculated.withdrawal_status)) {
      openEventReview(row.event_id, recalculated.message, reconciledBy);
    } else {
      resolveOpenEventReview(
        row.event_id,
        'Resolved automatically when the actual calving date was recorded.',
        reconciledBy
      );
    }

    reconciled.push({
      event_id: row.event_id,
      drug_name: row.drug_name,
      previous_calving_date: row.calving_date,
      actual_calving_date: actualCalvingDate,
      previous_end_date: row.withdrawal_end_date,
      new_end_date: recalculated.withdrawal_end_date,
      status: recalculated.withdrawal_status,
      milkings_per_day_applied: recalculated.milkings_per_day_applied,
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
  const today = new Date().toISOString().slice(0, 10);
  const perDay = milkingsPerDayOn(today);

  // 未核实的药必须在接口层就标出来。一个没有出处的停药天数看起来和核实过的
  // 一模一样,不主动区分,用的人就无从分辨。
  res.json(drugs.map(drug => {
    const rules = db.prepare(`
      SELECT id, rule_code, rule_name, description, milkings_once_daily,
             milkings_twice_daily, is_default
      FROM drug_withdrawal_rules
      WHERE drug_id = ? AND reference_revision_id = ?
      ORDER BY is_default DESC, id
    `).all(drug.id, drug.current_reference_revision_id);

    let summary;
    if (drug.requires_regimen) {
      summary = `Select the treatment regimen (${rules.length} approved options)`;
    } else if (drug.whp_depends_on_dose) {
      summary = 'Depends on dose — veterinary/manual period required';
    } else {
      summary = `${drug.milk_withdrawal_value} ${drug.milk_withdrawal_unit}` +
        (drug.milk_withdrawal_unit === 'milkings'
          ? ` (${toDays(drug.milk_withdrawal_value, 'milkings', perDay)} days at ${perDay} milkings/day)`
          : '') +
        ` from the ${drug.calculation_basis === 'calving_date' ? 'calving date' : 'last treatment date'}`;
    }

    return {
      ...drug,
      is_verified: drug.verified_on !== null,
      withdrawal_summary: summary,
      rules
    };
  }));
});

// 给前端和报告使用的完整参考数据状态,包括已停用但必须解释原因的产品。
app.get('/api/drugs/reference-status', (req, res) => {
  const drugs = db.prepare(`
    SELECT d.*,
           (SELECT COUNT(*) FROM drug_withdrawal_rules r
            WHERE r.drug_id = d.id AND r.reference_revision_id = d.current_reference_revision_id)
             AS rule_count
    FROM drugs d
    ORDER BY d.is_active DESC, d.drug_name
  `).all().map(drug => ({
    ...drug,
    is_verified: drug.verified_on !== null,
    status: drug.is_active
      ? (drug.verified_on ? 'verified' : 'unverified')
      : 'inactive_pending_current_label'
  }));

  res.json({
    active_count: drugs.filter(d => d.is_active).length,
    verified_active_count: drugs.filter(d => d.is_active && d.is_verified).length,
    unverified_active_count: drugs.filter(d => d.is_active && !d.is_verified).length,
    inactive_count: drugs.filter(d => !d.is_active).length,
    drugs
  });
});

// 录入核实过的停药期数据。
//
// 核实的意思是"查过官方来源",不是"填过数字"。所以标记 verified_on 的同时
// 必须给出标签原文和出处——没有凭证的核实声明本身就是不可信的,拦在这里比
// 事后追查便宜得多。
app.put('/api/drugs/:id', requireRole('owner', 'vet'), (req, res) => {
  const existing = findOrNull('drugs', req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Drug not found' });
  }

  const supplied = field => Object.prototype.hasOwnProperty.call(req.body, field);
  const value = field => supplied(field) ? req.body[field] : existing[field];
  const updated = {
    milk_withdrawal_value: value('milk_withdrawal_value'),
    milk_withdrawal_unit: value('milk_withdrawal_unit'),
    meat_withdrawal_days: value('meat_withdrawal_days'),
    calculation_basis: value('calculation_basis'),
    minimum_dry_period_days: value('minimum_dry_period_days'),
    whp_depends_on_dose: value('whp_depends_on_dose'),
    requires_regimen: value('requires_regimen'),
    acvm_registration_no: value('acvm_registration_no'),
    label_revision: value('label_revision'),
    label_wording: value('label_wording'),
    source_reference: value('source_reference'),
    verified_on: value('verified_on'),
    verified_by: value('verified_by')
  };

  const criticalFields = [
    'milk_withdrawal_value', 'milk_withdrawal_unit', 'meat_withdrawal_days',
    'calculation_basis', 'minimum_dry_period_days', 'whp_depends_on_dose',
    'requires_regimen', 'acvm_registration_no', 'label_revision'
  ];
  const criticalChanged = criticalFields.some(field => supplied(field) && updated[field] !== existing[field]);
  if (criticalChanged && !supplied('verified_on')) {
    updated.verified_on = null;
    updated.verified_by = null;
  }

  if (!['hours', 'days', 'milkings'].includes(updated.milk_withdrawal_unit)) {
    return res.status(400).json({ error: "milk_withdrawal_unit must be 'hours', 'days' or 'milkings'" });
  }

  if (updated.verified_on && !(
    updated.acvm_registration_no && updated.label_revision && updated.label_wording &&
    updated.source_reference && updated.verified_by
  )) {
    return res.status(400).json({
      error: 'A drug cannot be marked as verified without ACVM registration number, ' +
             'label revision, label wording, source reference and verified_by'
    });
  }

  if (updated.minimum_dry_period_days !== null && updated.calculation_basis !== 'calving_date') {
    return res.status(400).json({
      error: 'minimum_dry_period_days only applies to drugs counted from the calving date'
    });
  }

  let existingRevision = null;
  if (updated.verified_on) {
    existingRevision = db.prepare(`
      SELECT * FROM drug_reference_revisions WHERE drug_id = ? AND label_revision = ?
    `).get(existing.id, updated.label_revision);
    if (existingRevision && (
      existingRevision.acvm_registration_no !== updated.acvm_registration_no ||
      existingRevision.label_wording !== updated.label_wording ||
      existingRevision.source_reference !== updated.source_reference ||
      existingRevision.verified_on !== updated.verified_on ||
      existingRevision.verified_by !== updated.verified_by
    )) {
      return res.status(409).json({
        error: 'A stored label revision is immutable; use a new label_revision for changed evidence'
      });
    }
  }

  db.transaction(() => {
    let revisionId = criticalChanged ? null : existing.current_reference_revision_id;
    if (updated.verified_on) {
      if (!existingRevision) {
        const inserted = db.prepare(`
          INSERT INTO drug_reference_revisions
            (drug_id, acvm_registration_no, label_revision, label_wording,
             source_reference, verified_on, verified_by)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          existing.id, updated.acvm_registration_no, updated.label_revision,
          updated.label_wording, updated.source_reference, updated.verified_on,
          updated.verified_by
        );
        revisionId = Number(inserted.lastInsertRowid);
      } else {
        revisionId = existingRevision.id;
      }
    }

    db.prepare(`
      UPDATE drugs
      SET milk_withdrawal_value = ?, milk_withdrawal_unit = ?, meat_withdrawal_days = ?,
          calculation_basis = ?, minimum_dry_period_days = ?, whp_depends_on_dose = ?,
          requires_regimen = ?, acvm_registration_no = ?, label_revision = ?,
          label_wording = ?, source_reference = ?, verified_on = ?, verified_by = ?,
          current_reference_revision_id = ?
      WHERE id = ?
    `).run(
      updated.milk_withdrawal_value,
      updated.milk_withdrawal_unit,
      updated.meat_withdrawal_days,
      updated.calculation_basis,
      updated.minimum_dry_period_days,
      updated.whp_depends_on_dose ? 1 : 0,
      updated.requires_regimen ? 1 : 0,
      updated.acvm_registration_no,
      updated.label_revision,
      updated.label_wording,
      updated.source_reference,
      updated.verified_on,
      updated.verified_by,
      revisionId,
      req.params.id
    );
  })();

  res.json(db.prepare('SELECT * FROM drugs WHERE id = ?').get(req.params.id));
});

// 还没核实的药。核实工作本身需要一份清单,这就是那份清单。
app.get('/api/drugs/unverified', (req, res) => {
  const pending = db.prepare(`
    SELECT id, drug_name, active_ingredient, milk_withdrawal_value, milk_withdrawal_unit,
           calculation_basis, whp_depends_on_dose, requires_regimen,
           acvm_registration_no, label_revision
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

// ---------- effective-dated milking schedule ----------

app.get('/api/milking-schedule', (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const entries = db.prepare(`
    SELECT milking_schedule.*, users.name AS created_by_name
    FROM milking_schedule
    LEFT JOIN users ON milking_schedule.created_by = users.id
    ORDER BY effective_from DESC
  `).all();
  res.json({
    today,
    current_milkings_per_day: milkingsPerDayOn(today),
    entries
  });
});

app.post('/api/milking-schedule', requireRole('owner'), (req, res) => {
  const { effective_from, milkings_per_day, note } = req.body;
  const created_by = req.user.id;
  if (!canonicalDate(effective_from)) {
    return res.status(400).json({ error: 'effective_from must be a real YYYY-MM-DD date' });
  }
  if (![1, 2, 3].includes(milkings_per_day)) {
    return res.status(400).json({ error: 'milkings_per_day must be 1, 2 or 3' });
  }
  if (created_by && !findOrNull('users', created_by)) {
    return res.status(400).json({ error: 'created_by does not match any known user' });
  }
  if (db.prepare('SELECT id FROM milking_schedule WHERE effective_from = ?').get(effective_from)) {
    return res.status(409).json({
      error: `A milking schedule change already exists for ${effective_from}`
    });
  }

  const result = db.prepare(`
    INSERT INTO milking_schedule (effective_from, milkings_per_day, note, created_by)
    VALUES (?, ?, ?, ?)
  `).run(effective_from, milkings_per_day, note || null, created_by || null);

  const today = new Date().toISOString().slice(0, 10);
  if (effective_from <= today) {
    db.prepare(`
      UPDATE farm_settings SET milkings_per_day = ?, updated_at = datetime('now') WHERE id = 1
    `).run(milkingsPerDayOn(today));
  }

  res.status(201).json(
    db.prepare('SELECT * FROM milking_schedule WHERE id = ?').get(result.lastInsertRowid)
  );
});

// ---------- legacy farm settings ----------

app.get('/api/settings', (req, res) => {
  const settings = db.prepare('SELECT * FROM farm_settings WHERE id = 1').get();
  const today = new Date().toISOString().slice(0, 10);
  res.json({ ...settings, milkings_per_day: milkingsPerDayOn(today) });
});

// Retained for older clients. The multi-page UI uses /api/milking-schedule so future
// seasonal changes have an explicit effective date. This endpoint changes the baseline.
app.put('/api/settings', requireRole('owner'), (req, res) => {
  const { milkings_per_day } = req.body;

  if (![1, 2, 3].includes(milkings_per_day)) {
    return res.status(400).json({ error: 'milkings_per_day must be 1, 2 or 3' });
  }

  db.prepare(`
    UPDATE farm_settings SET milkings_per_day = ?, updated_at = datetime('now') WHERE id = 1
  `).run(milkings_per_day);
  db.prepare(`
    UPDATE milking_schedule
    SET milkings_per_day = ?
    WHERE effective_from = '2000-01-01'
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
      drug_withdrawal_rules.rule_name AS drug_rule_name,
      drug_reference_revisions.label_revision AS reference_label_revision,
      users.name AS created_by_name
    FROM health_events
    JOIN cows ON health_events.cow_id = cows.id
    LEFT JOIN drugs ON health_events.drug_id = drugs.id
    LEFT JOIN drug_withdrawal_rules ON health_events.drug_rule_id = drug_withdrawal_rules.id
    LEFT JOIN drug_reference_revisions
      ON health_events.drug_reference_revision_id = drug_reference_revisions.id
    LEFT JOIN users ON health_events.created_by = users.id
    WHERE health_events.deleted_at IS NULL
    ORDER BY health_events.event_date DESC
  `).all();

  res.json(events);
});

app.post('/api/events', (req, res) => {
  const {
    cow_id, event_type, event_date, calving_date, drug_id, drug_rule_id,
    notes, diagnosis, milkings_per_day
  } = req.body;
  const created_by = req.user.id;

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
    if (!drug.is_active) {
      return res.status(400).json({
        error: `${drug.drug_name} is inactive because it has no current verified ACVM label`
      });
    }
  }

  let selectedRule = null;
  if (drug_rule_id) {
    selectedRule = findOrNull('drug_withdrawal_rules', drug_rule_id);
    if (!selectedRule || !drug || selectedRule.drug_id !== drug.id ||
        selectedRule.reference_revision_id !== drug.current_reference_revision_id) {
      return res.status(400).json({
        error: 'drug_rule_id is not a current approved rule for the selected drug'
      });
    }
  }
  if (drug?.requires_regimen && !selectedRule) {
    return res.status(400).json({
      error: `${drug.drug_name} requires the actual treatment regimen to be selected`
    });
  }
  if (selectedRule && !drug.requires_regimen) {
    return res.status(400).json({
      error: 'drug_rule_id only applies to a drug with regimen-specific label rules'
    });
  }

  if (milkings_per_day !== undefined && milkings_per_day !== null &&
      ![1, 2, 3].includes(milkings_per_day)) {
    return res.status(400).json({ error: 'milkings_per_day must be 1, 2 or 3 when supplied' });
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
    {
      event_date,
      calving_date: effectiveCalvingDate,
      calving_date_source: calvingDateSource,
      drug_rule_id: selectedRule?.id || null,
      milkings_per_day_applied: milkings_per_day ?? null
    },
    drug,
    selectedRule
  );

  const stmt = db.prepare(`
    INSERT INTO health_events
      (cow_id, event_type, event_date, calving_date, calving_date_source, drug_id,
       drug_reference_revision_id, drug_rule_id,
       withdrawal_days_applied, withdrawal_end_date, withdrawal_status,
       milkings_per_day_applied, milking_schedule_snapshot,
       notes, created_by, diagnosis)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    cow_id,
    event_type,
    event_date,
    effectiveCalvingDate,
    calvingDateSource,
    drug_id || null,
    drug?.current_reference_revision_id || null,
    selectedRule?.id || null,
    withdrawal.withdrawal_days_applied,
    withdrawal.withdrawal_end_date,
    withdrawal.withdrawal_status,
    withdrawal.milkings_per_day_applied,
    withdrawal.milking_schedule_snapshot,
    notes || null,
    created_by || null,
    diagnosis || null
  );

  // 记录产犊,就是这头牛的产犊日期从预测变成事实的时刻。此前按预测日期算出的
  // 干奶期解除日必须在这一刻重算,否则牛提前产犊时记录会一直停在旧日期上。
  const reconciled = event_type === 'calving'
    ? reconcilePredictedCalving(cow_id, effectiveCalvingDate, req.user.id)
    : [];

  const newEvent = db.prepare('SELECT * FROM health_events WHERE id = ?').get(result.lastInsertRowid);

  if (REVIEW_STATUSES.has(withdrawal.withdrawal_status)) {
    openEventReview(Number(result.lastInsertRowid), withdrawal.message, req.user.id);
  }

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
app.put('/api/events/:id', requireRole('owner', 'vet'), (req, res) => {
  const existing = db.prepare('SELECT * FROM health_events WHERE id = ?').get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Event not found' });
  }
  if (existing.deleted_at) {
    return res.status(404).json({ error: 'Event has been deleted and cannot be updated' });
  }
  const correctionReason = String(req.body.correction_reason || '').trim();
  if (correctionReason.length < 5) {
    return res.status(400).json({ error: 'correction_reason must contain at least 5 characters' });
  }

  const supplied = field => Object.prototype.hasOwnProperty.call(req.body, field);
  const updated = {
    cow_id: req.body.cow_id ?? existing.cow_id,
    event_type: req.body.event_type ?? existing.event_type,
    event_date: req.body.event_date ?? existing.event_date,
    calving_date: req.body.calving_date ?? existing.calving_date,
    drug_id: req.body.drug_id ?? existing.drug_id,
    drug_rule_id: supplied('drug_rule_id') ? req.body.drug_rule_id : existing.drug_rule_id,
    notes: req.body.notes ?? existing.notes,
    created_by: existing.created_by,
    diagnosis: req.body.diagnosis ?? existing.diagnosis,
    calving_date_source: req.body.calving_date_source ?? existing.calving_date_source,
    milkings_per_day_applied: supplied('milkings_per_day')
      ? req.body.milkings_per_day
      : existing.milkings_per_day_applied
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
    if (!drug.is_active) {
      return res.status(400).json({
        error: `${drug.drug_name} is inactive because it has no current verified ACVM label`
      });
    }
  }

  let selectedRule = null;
  if (updated.drug_rule_id) {
    selectedRule = findOrNull('drug_withdrawal_rules', updated.drug_rule_id);
    if (!selectedRule || !drug || selectedRule.drug_id !== drug.id ||
        selectedRule.reference_revision_id !== drug.current_reference_revision_id) {
      return res.status(400).json({
        error: 'drug_rule_id is not a current approved rule for the selected drug'
      });
    }
  }
  if (drug?.requires_regimen && !selectedRule) {
    return res.status(400).json({
      error: `${drug.drug_name} requires the actual treatment regimen to be selected`
    });
  }
  if (selectedRule && !drug.requires_regimen) {
    return res.status(400).json({
      error: 'drug_rule_id only applies to a drug with regimen-specific label rules'
    });
  }

  if (updated.milkings_per_day_applied !== null &&
      updated.milkings_per_day_applied !== undefined &&
      ![1, 2, 3].includes(updated.milkings_per_day_applied)) {
    return res.status(400).json({ error: 'milkings_per_day must be 1, 2 or 3 when supplied' });
  }

  // 更正后的产犊日期如果没有明说来源,而记录里原本也没有,就仍当预测值处理。
  if (updated.calving_date && !updated.calving_date_source) {
    updated.calving_date_source = 'predicted';
  }

  const withdrawal = withdrawalFor(updated, drug, selectedRule);

  const corrected = db.transaction(() => {
    db.prepare(`
      UPDATE health_events
      SET cow_id = ?, event_type = ?, event_date = ?, calving_date = ?, calving_date_source = ?,
          drug_id = ?, withdrawal_days_applied = ?, withdrawal_end_date = ?, withdrawal_status = ?,
          drug_reference_revision_id = ?, drug_rule_id = ?,
          milkings_per_day_applied = ?, milking_schedule_snapshot = ?,
          notes = ?, created_by = ?, diagnosis = ?
      WHERE id = ?
    `).run(
      updated.cow_id, updated.event_type, updated.event_date, updated.calving_date,
      updated.calving_date_source, updated.drug_id, withdrawal.withdrawal_days_applied,
      withdrawal.withdrawal_end_date, withdrawal.withdrawal_status,
      drug?.current_reference_revision_id || null, selectedRule?.id || null,
      withdrawal.milkings_per_day_applied, withdrawal.milking_schedule_snapshot,
      updated.notes, updated.created_by, updated.diagnosis, req.params.id
    );

    const row = db.prepare('SELECT * FROM health_events WHERE id = ?').get(req.params.id);
    db.prepare(`
      INSERT INTO event_corrections
        (health_event_id, reason, previous_snapshot, corrected_snapshot, corrected_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(req.params.id, correctionReason, JSON.stringify(existing), JSON.stringify(row), req.user.id);

    const alreadyUnderReview = db.prepare(`
      SELECT id FROM event_reviews WHERE health_event_id = ? AND status = 'open'
    `).get(row.id);
    const reviewedEstimate = alreadyUnderReview && drug?.calculation_basis === 'calving_date'
      && row.calving_date_source !== 'actual';
    if (REVIEW_STATUSES.has(row.withdrawal_status) || reviewedEstimate) {
      const reason = reviewedEstimate
        ? `${drug.drug_name} now has an estimated clear date, but the open review remains until the actual calving date is recorded.`
        : withdrawal.message;
      openEventReview(row.id, reason, req.user.id);
    } else {
      resolveOpenEventReview(
        row.id,
        `Resolved by correction: ${correctionReason}`,
        req.user.id
      );
    }
    return row;
  })();

  res.json({ ...corrected, withdrawal_message: withdrawal.message, correction_reason: correctionReason });
});

app.get('/api/events/:id/corrections', (req, res) => {
  if (!findOrNull('health_events', req.params.id)) {
    return res.status(404).json({ error: 'Event not found' });
  }
  res.json(db.prepare(`
    SELECT event_corrections.*, users.name AS corrected_by_name
    FROM event_corrections
    JOIN users ON event_corrections.corrected_by = users.id
    WHERE event_corrections.health_event_id = ?
    ORDER BY event_corrections.corrected_at DESC, event_corrections.id DESC
  `).all(req.params.id));
});

// 软删除:只标记 deleted_at,不真正移除记录
app.delete('/api/events/:id', requireRole('owner', 'vet'), (req, res) => {
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

// 同一条记录在每日清单和助手页上必须给出同一段警告文字。解释分了家,挤奶工就会
// 按自己看到的那一版判断,而两版里总有一版是旧的。
// 未解决的记录必须自己说明为什么解除不了。清单和助手用同一句话,人才不会以为
// 这是两回事。
function unresolvedHoldWarning(row) {
  if (row.withdrawal_status === 'awaiting_calving_date') {
    return 'No calving date is recorded for this dry-cow treatment. Record the actual ' +
      'calving before any milk enters the vat.';
  }
  if (row.withdrawal_status === 'minimum_dry_period_breached') {
    return 'This is a legacy unresolved early-calving record. Recalculate it against ' +
      'the current approved label before milk enters the vat.';
  }
  return `No authoritative clear date is stored for ${row.drug_name || 'this event'}. ` +
    'Keep this cow out of the vat until the treatment details are reviewed.';
}

function calculatedHoldWarnings(row) {
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
  if (row.drug_name && !row.drug_reference_revision_id) {
    warnings.push(
      'This event predates versioned ACVM references. Review the stored clear date ' +
      'before relying on it.'
    );
  }
  return warnings;
}

function vatExclusions(today = new Date().toISOString().split('T')[0]) {

  const exclusions = db.prepare(`
    SELECT
      health_events.id,
      cows.tag_number,
      health_events.event_type,
      health_events.event_date,
      drugs.drug_name,
      drugs.verified_on AS drug_verified_on,
      health_events.drug_reference_revision_id,
      health_events.withdrawal_status,
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
    const warnings = calculatedHoldWarnings(row);

    return {
      ...row,
      days_remaining: Math.ceil((new Date(row.withdrawal_end_date) - new Date(today)) / (1000 * 60 * 60 * 24)),
      // withdrawal_end_date is inclusive: milk stays out through that date. The
      // following day is the earliest eligible date, assuming no other hold applies.
      eligible_from_date: addDays(row.withdrawal_end_date, 1),
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
      AND health_events.withdrawal_status IN (
        'awaiting_calving_date', 'requires_vet_advice', 'minimum_dry_period_breached'
      )
    ORDER BY health_events.event_date DESC
  `).all().map(row => ({
    ...row,
    withdrawal_end_date: null,
    eligible_from_date: null,
    days_remaining: null,
    is_estimate: false,
    requires_attention: true,
    warnings: [unresolvedHoldWarning(row)]
  }));

  // 需要处理的排在前面:没有解除日的牛比"还有三天"的牛更需要有人去看一眼。
  return [...unresolved, ...withDaysRemaining];
}

app.get('/api/vat-exclusions', (req, res) => {
  res.json(vatExclusions());
});

// ---------- constrained natural-language assistant ----------

// 牛号和日期一律在服务器这边自己解析,不让模型提供任何实体。模型把耳号听错一位、
// 把日期说早一天,做出来的草稿看上去一样合理,而错的是奶能不能进罐这件事。
const ASSISTANT_TODAY_WORDS = /(today|tonight|this morning|今天|今日|今早)/i;
const ASSISTANT_YESTERDAY_WORDS = /(yesterday|last night|昨天|昨日|昨晚)/i;
const ASSISTANT_CALVING_WORDS = /(calv|gave birth|产犊|生了|下犊|生犊)/i;
const ASSISTANT_TREATMENT_WORDS = /(treat|antibiotic|mastitis|dry ?cow|打针|治疗|用药|乳房炎|干奶)/i;

// 只认数据库里真实存在的耳号。从句子里"猜"一个号码出来,等于给另一头牛建记录。
function assistantCowReference(question) {
  const tokens = String(question).toLowerCase().match(/[a-z0-9]+/g) || [];
  const cows = db.prepare('SELECT id, tag_number, status FROM cows').all();
  const matched = cows.filter(cow => tokens.includes(String(cow.tag_number).toLowerCase()));

  if (matched.length === 1) return { cow: matched[0], question: null };
  if (matched.length > 1) {
    return {
      cow: null,
      question: `More than one cow tag appears in this question (${matched.map(cow => cow.tag_number).join(', ')}). Ask about one cow at a time.`
    };
  }
  const numeric = tokens.filter(token => /\d/.test(token));
  if (numeric.length) {
    return {
      cow: null,
      question: `No cow is recorded with tag ${numeric.join(' or ')}. Check the tag on the Herd page.`
    };
  }
  return { cow: null, question: 'Name the cow by her tag number, for example "cow 212".' };
}

// 日期只接受说得死的三种写法。"上周""前几天"这类含糊说法宁可回问,也不替人取整。
function assistantDateReference(question, today) {
  const explicit = String(question).match(/(\d{4}-\d{2}-\d{2})/);
  if (explicit) {
    if (!canonicalDate(explicit[1])) {
      return { date: null, question: `${explicit[1]} is not a valid calendar date. Use YYYY-MM-DD.` };
    }
    if (explicit[1] > today) {
      return { date: null, question: `${explicit[1]} is in the future. Record an event after it has happened.` };
    }
    return { date: explicit[1], question: null };
  }
  if (ASSISTANT_YESTERDAY_WORDS.test(question)) return { date: addDays(today, -1), question: null };
  if (ASSISTANT_TODAY_WORDS.test(question)) return { date: today, question: null };
  return { date: null, question: 'Give the date as "today", "yesterday" or YYYY-MM-DD.' };
}

function assistantScheduleSnapshot(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// 解释一头牛的状态时,每个字段都是从事件快照里读出来的,没有任何一处重新计算。
// 重算会让解释和每日清单对不上,而人会相信后看到的那一个。
function assistantCowStatus(question, today = new Date().toISOString().split('T')[0]) {
  const reference = assistantCowReference(question);
  if (!reference.cow) {
    return { supported: true, resolved: false, message: reference.question, questions: [reference.question] };
  }

  const rows = db.prepare(`
    SELECT
      health_events.id,
      health_events.event_type,
      health_events.event_date,
      health_events.calving_date,
      health_events.calving_date_source,
      health_events.withdrawal_days_applied,
      health_events.withdrawal_end_date,
      health_events.withdrawal_status,
      health_events.milkings_per_day_applied,
      health_events.milking_schedule_snapshot,
      health_events.drug_reference_revision_id,
      drugs.drug_name,
      drugs.verified_on AS drug_verified_on,
      drug_withdrawal_rules.rule_name AS drug_rule_name,
      drug_reference_revisions.acvm_registration_no,
      drug_reference_revisions.label_revision
    FROM health_events
    LEFT JOIN drugs ON health_events.drug_id = drugs.id
    LEFT JOIN drug_withdrawal_rules ON health_events.drug_rule_id = drug_withdrawal_rules.id
    LEFT JOIN drug_reference_revisions
      ON health_events.drug_reference_revision_id = drug_reference_revisions.id
    WHERE health_events.cow_id = ? AND health_events.deleted_at IS NULL
    ORDER BY health_events.event_date DESC, health_events.id DESC
    LIMIT 10
  `).all(reference.cow.id);

  const events = rows.map(row => {
    const requiresAttention = REVIEW_STATUSES.has(row.withdrawal_status);
    const onHoldToday = Boolean(row.withdrawal_end_date && row.withdrawal_end_date >= today);
    return {
      ...row,
      milking_schedule_snapshot: assistantScheduleSnapshot(row.milking_schedule_snapshot),
      eligible_from_date: row.withdrawal_end_date ? addDays(row.withdrawal_end_date, 1) : null,
      days_remaining: onHoldToday
        ? Math.ceil((new Date(row.withdrawal_end_date) - new Date(today)) / (1000 * 60 * 60 * 24))
        : null,
      on_hold_today: onHoldToday,
      requires_attention: requiresAttention,
      is_estimate: row.calving_date_source === 'predicted',
      warnings: requiresAttention ? [unresolvedHoldWarning(row)] : calculatedHoldWarnings(row)
    };
  });

  const unresolved = events.filter(event => event.requires_attention);
  const holds = events.filter(event => event.on_hold_today);
  const latestHold = holds.reduce(
    (latest, event) => (!latest || event.withdrawal_end_date > latest.withdrawal_end_date ? event : latest),
    null
  );

  let message;
  if (unresolved.length) {
    message = `Cow ${reference.cow.tag_number} must stay out of the vat. ` +
      `${unresolved.length} record${unresolved.length === 1 ? '' : 's'} ` +
      'cannot be cleared automatically and need human review.';
  } else if (latestHold) {
    message = `Cow ${reference.cow.tag_number} is on hold through ${latestHold.withdrawal_end_date}. ` +
      `The earliest eligible date is ${latestHold.eligible_from_date} if no other hold applies.` +
      (holds.some(event => event.is_estimate)
        ? ' At least one clear date still rests on an expected calving date.'
        : '');
  } else {
    message = `No medicine hold is stored for cow ${reference.cow.tag_number} today. ` +
      'Other animal-health and farm holds must still be checked.';
  }

  return {
    supported: true,
    resolved: true,
    source: 'deterministic_database_query',
    explanation_basis: 'stored_event_snapshot',
    cow: reference.cow,
    on_hold_today: holds.length > 0 || unresolved.length > 0,
    requires_attention: unresolved.length > 0,
    message,
    events
  };
}

// 草稿永远只是草稿:这个函数不写库。真正写库仍然走 POST /api/events,那条路上的
// 角色检查、字段校验、快照和审计一个都不能绕过。
function assistantEventDraft(question, today = new Date().toISOString().split('T')[0]) {
  const reference = assistantCowReference(question);
  const date = assistantDateReference(question, today);
  const mentionsCalving = ASSISTANT_CALVING_WORDS.test(question);
  const mentionsTreatment = ASSISTANT_TREATMENT_WORDS.test(question);
  const questions = [];
  if (!reference.cow) questions.push(reference.question);
  if (!date.date) questions.push(date.question);
  if (mentionsCalving && mentionsTreatment) {
    questions.push('This sentence mentions both a calving and a treatment. Record them as two separate events.');
  }

  const base = {
    supported: true,
    record_written: false,
    source: 'draft_only_no_record_written',
    cow: reference.cow,
    event_date: date.date
  };

  if (questions.length) {
    return {
      ...base,
      resolved: false,
      can_confirm: false,
      questions,
      message: 'The assistant needs one more detail before it can prepare a draft. Nothing has been saved.'
    };
  }

  // 药品和疗程只能由人来选。药选错一种,或者把 Orbenin 的疗程猜错一个,算出来的
  // 解除日会早于真正的停药期,而清单上看不出任何异常。
  if (mentionsTreatment) {
    return {
      ...base,
      resolved: true,
      can_confirm: false,
      event_type: 'treatment',
      blocked_fields: ['drug_id', 'drug_rule_id'],
      questions: [],
      message: `Cow ${reference.cow.tag_number} on ${date.date}: the assistant will not choose the medicine, ` +
        'the treatment regimen or the withholding period. Open Treatments and complete the record there.',
      next_step: { label: 'Open Treatments', href: '/events.html' }
    };
  }

  return {
    ...base,
    resolved: true,
    can_confirm: true,
    event_type: 'calving',
    questions: [],
    message: `Draft only — nothing has been saved yet. Confirm to record that cow ${reference.cow.tag_number} ` +
      `calved on ${date.date}. Recording an actual calving recalculates dry-cow holds that were based ` +
      'on an expected calving date.',
    confirm_with: {
      method: 'POST',
      url: '/api/events',
      body: { cow_id: reference.cow.id, event_type: 'calving', event_date: date.date }
    }
  };
}

function assistantVatAnswer() {
  const rows = vatExclusions();
  const unresolvedCount = rows.filter(row => row.requires_attention || !row.withdrawal_end_date).length;
  return {
    supported: true,
    source: 'deterministic_database_query',
    count: rows.length,
    unresolved_count: unresolvedCount,
    message: rows.length
      ? `${rows.length} cow${rows.length === 1 ? '' : 's'} must stay out of the vat today. ` +
        `${unresolvedCount} record${unresolvedCount === 1 ? ' still needs' : 's still need'} human review.`
      : 'No medicine holds are listed today. Other animal-health and farm holds must still be checked.',
    rows
  };
}

app.post('/api/assistant/query', async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'Enter a question' });
  if (question.length > 500) {
    return res.status(400).json({ error: 'Question must be 500 characters or fewer' });
  }

  const classification = await classifyIntent(question);
  const envelope = {
    intent: classification.intent,
    assistant_mode: classification.mode,
    notice: classification.notice
  };

  if (classification.intent === 'vat_exclusions_today') {
    return res.json({ ...envelope, ...assistantVatAnswer() });
  }
  if (classification.intent === 'cow_status') {
    return res.json({ ...envelope, ...assistantCowStatus(question) });
  }
  if (classification.intent === 'draft_event') {
    return res.json({ ...envelope, ...assistantEventDraft(question) });
  }

  return res.json({
    ...envelope,
    supported: false,
    message: "This prototype answers today's vat-exclusion question, explains one cow's recorded hold, " +
      'and prepares a calving record for a person to confirm. It does not diagnose, advise on ' +
      'treatment or release milk.'
  });
});

// ---------- accountable review queue ----------

app.get('/api/reviews', (req, res) => {
  const status = req.query.status || 'open';
  if (!['open', 'resolved', 'all'].includes(status)) {
    return res.status(400).json({ error: "status must be 'open', 'resolved' or 'all'" });
  }
  const where = status === 'all' ? '' : 'WHERE event_reviews.status = ?';
  const params = status === 'all' ? [] : [status];
  res.json(db.prepare(`
    SELECT event_reviews.*, health_events.withdrawal_status, health_events.withdrawal_end_date,
           health_events.event_date, cows.tag_number, drugs.drug_name,
           opened.name AS opened_by_name, resolved.name AS resolved_by_name
    FROM event_reviews
    JOIN health_events ON event_reviews.health_event_id = health_events.id
    JOIN cows ON health_events.cow_id = cows.id
    LEFT JOIN drugs ON health_events.drug_id = drugs.id
    LEFT JOIN users opened ON event_reviews.opened_by = opened.id
    LEFT JOIN users resolved ON event_reviews.resolved_by = resolved.id
    ${where}
    ORDER BY CASE event_reviews.status WHEN 'open' THEN 0 ELSE 1 END,
             event_reviews.created_at DESC, event_reviews.id DESC
  `).all(...params));
});

app.post('/api/reviews/:id/resolve', requireRole('owner', 'vet'), (req, res) => {
  const review = db.prepare(`
    SELECT event_reviews.*, health_events.withdrawal_status
    FROM event_reviews
    JOIN health_events ON event_reviews.health_event_id = health_events.id
    WHERE event_reviews.id = ?
  `).get(req.params.id);
  if (!review || review.status !== 'open') {
    return res.status(404).json({ error: 'Open review not found' });
  }
  if (REVIEW_STATUSES.has(review.withdrawal_status)) {
    return res.status(409).json({
      error: 'Correct the event until it has an authoritative result before resolving this review'
    });
  }
  const resolution = String(req.body.resolution || '').trim();
  if (resolution.length < 5) {
    return res.status(400).json({ error: 'resolution must contain at least 5 characters' });
  }
  resolveOpenEventReview(review.health_event_id, resolution, req.user.id);
  res.json(db.prepare('SELECT * FROM event_reviews WHERE id = ?').get(req.params.id));
});

// ---------- users ----------

app.get('/api/users', (req, res) => {
  const users = db.prepare(`
    SELECT id, name, username, role, created_at FROM users ORDER BY name
  `).all();
  res.json(users);
});

app.post('/api/users', requireRole('owner'), (req, res) => {
  const { name, role, username, password } = req.body;

  if (!name || !username || !password) {
    return res.status(400).json({ error: 'name, username and password are required' });
  }

  let credentials;
  try { credentials = passwordFields(password); }
  catch (error) { return res.status(400).json({ error: error.message }); }

  const cleanUsername = String(username).trim();
  if (!/^[a-zA-Z0-9._-]{3,40}$/.test(cleanUsername)) {
    return res.status(400).json({
      error: 'username must contain 3 to 40 letters, numbers, dots, underscores or hyphens'
    });
  }
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(cleanUsername)) {
    return res.status(409).json({ error: 'That username is already in use' });
  }

  const stmt = db.prepare(`
    INSERT INTO users (name, role, username, password_salt, password_hash)
    VALUES (?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    name, role || 'milker', cleanUsername,
    credentials.password_salt, credentials.password_hash
  );

  const newUser = db.prepare(`
    SELECT id, name, username, role, created_at FROM users WHERE id = ?
  `).get(result.lastInsertRowid);
  res.status(201).json(newUser);
});

// ---------- field usability feedback ----------

const FEEDBACK_AREAS = new Set([
  'dashboard', 'treatments', 'reviews', 'herd', 'dry_off', 'medicines', 'assistant', 'overall'
]);
const FEEDBACK_TASKS = new Set([
  'find_hold', 'record_treatment', 'record_calving', 'change_schedule',
  'dry_off_review', 'review_unknown', 'ask_assistant', 'overall_walkthrough'
]);
const FEEDBACK_COMPLETION = new Set([
  'completed', 'completed_with_help', 'not_completed'
]);

app.get('/api/feedback', requireRole('owner'), (req, res) => {
  const rows = db.prepare(`
    SELECT field_feedback.*, users.name AS submitted_by_name, users.role AS submitted_by_role
    FROM field_feedback
    JOIN users ON field_feedback.submitted_by = users.id
    ORDER BY field_feedback.created_at DESC, field_feedback.id DESC
    LIMIT 200
  `).all();
  res.json(rows);
});

app.post('/api/feedback', (req, res) => {
  const { area, task_code, completion_status } = req.body || {};
  const easeRating = Number(req.body?.ease_rating);
  const confusingPart = String(req.body?.confusing_part || '').trim();
  const suggestion = String(req.body?.suggestion || '').trim();

  if (!FEEDBACK_AREAS.has(area)) {
    return res.status(400).json({ error: 'Choose a valid page or area' });
  }
  if (!FEEDBACK_TASKS.has(task_code)) {
    return res.status(400).json({ error: 'Choose the task that was tested' });
  }
  if (!FEEDBACK_COMPLETION.has(completion_status)) {
    return res.status(400).json({ error: 'Choose whether the task was completed' });
  }
  if (!Number.isInteger(easeRating) || easeRating < 1 || easeRating > 5) {
    return res.status(400).json({ error: 'Ease rating must be a whole number from 1 to 5' });
  }
  if (confusingPart.length > 1000 || suggestion.length > 1000) {
    return res.status(400).json({ error: 'Each comment must be 1,000 characters or fewer' });
  }

  const result = db.prepare(`
    INSERT INTO field_feedback
      (area, task_code, completion_status, ease_rating, confusing_part, suggestion, submitted_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    area, task_code, completion_status, easeRating,
    confusingPart || null, suggestion || null, req.user.id
  );

  res.status(201).json(db.prepare(`
    SELECT field_feedback.*, users.name AS submitted_by_name, users.role AS submitted_by_role
    FROM field_feedback
    JOIN users ON field_feedback.submitted_by = users.id
    WHERE field_feedback.id = ?
  `).get(result.lastInsertRowid));
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

app.post('/api/decisions', requireRole('owner', 'vet'), (req, res) => {
  const { cow_id, season, decision, justification, supporting_scc_id } = req.body;
  const decided_by = req.user.id;

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
  // 请求体解析失败是调用方发错了东西。返回 500 会让人以为系统坏了,也会把这类
  // 噪音混进真正需要排查的错误日志里。
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body is not valid JSON' });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Request body is too large' });
  }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

app.listen(PORT, () => {
  console.log(`Server is listening on http://localhost:${PORT}`);
});
