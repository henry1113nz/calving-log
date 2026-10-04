// Only these parameterised, read-only queries are available to the language model.
// Never accept SQL, table names, credentials or arbitrary HTTP targets from it.
const ROLES = ['owner', 'vet', 'milker'];
const KNOWLEDGE = `CalvingLog is a student field-test prototype for dairy cow records and milk-withholding workflow, with demonstration data only.
It uses HTML/CSS/vanilla JavaScript, Node.js/Express, SQLite/better-sqlite3, and Railway with a persistent SQLite volume. Tests use Node's test runner, isolated API tests and database checks. You cannot see current deployment logs or test results.
Dashboard / shows stored current and unresolved medicine holds, NOT certification of safe milk. Herd /herd.html adds cows, searches tags/breeds and retains culled cows for history. All roles may add cows; Owner/Vet may edit them.
Treatments /events.html records calving, treatment, dry-off, calcium and other events. All roles may record events. Owner/Vet may correct or void past events with an audit reason. Chat never writes an event. Use the structured form to confirm cow, actual dates, product, regimen and diagnosis.
Reviews /reviews.html keeps missing actual calving dates and other unresolved records visible. Owner/Vet correct the source event before resolving a review; a review cannot override an unresolved hold.
Medicines /medicines.html shows label text, source, ACVM registration, verification date, reference revision and regimen rules. Owner/Vet add/edit/verify/deactivate; Milker reads only. No new drug becomes calculable just because it has a name. Verification requires authoritative evidence. Chat cannot verify a label or recommend a drug/dose.
Dry-off /dry-off.html reviews SCC (somatic cell count) evidence and recorded seasonal decisions. Dry-off means stopping milking before the next calving. Owner/Vet record decisions; Milker reads evidence. Do not issue treatment advice.
Milking plan /schedule.html is farm-wide and effective-dated, not an individual cow attribute. OAD means once a day, TAD twice a day. Only Owner changes it. Event snapshots retain the calculation basis used when saved.
Feedback /feedback.html collects trial usability feedback; only Owner can browse submitted responses. Account /account.html manages the signed-in user's password. Owners can create sign-ins, disable/restore other accounts and reset another password after confirming their own password with a reason. Access changes close existing sessions, retain historical record attribution and are audited. No public self-registration or email recovery is provided. Help /help.html explains workflows, date meanings, roles and the trial data notice. AI settings /ai-settings.html is Owner setup/testing; chat never reads passwords, keys, user accounts, feedback or audit actors.
Withholding is determined by approved label rules and the existing deterministic calculator, not AI. This prototype uses calendar days and scheduled frequency, not actual treatment times or actual milking-session records. It does not support every concurrent-treatment/off-label scenario and is not commercially validated. Some labels combine time conditions and milkings: all applicable conditions must be met; never assume satisfying only one is enough. Actual label text, actual calving/last-treatment dates, labelled regimen, minimum dry period, dose limitations and dated milking frequency matter. An expected calving date is planning only. Unverified evidence, dose-dependent rules without veterinary advice or missing facts cannot establish an authoritative clear date.
withdrawal_end_date is inclusive; eligible_from_date is the following day only if no other hold applies. Missing date/no record does NOT mean safe. Stored outputs are not laboratory residue tests, clinical diagnosis or permission to release milk. The product label, farm procedure and veterinarian remain authoritative.
You can explain concepts, summarise retrieved demo data, compare stored records and help navigate, in the user's language. You have no internet search or access to the user's computer. If a fact is absent, say you do not know, or ask a precise follow-up. General knowledge is not live evidence.`;

const text = (description, maxLength = 100) => ({ type: 'string', description, maxLength });
const page = { type: 'integer', minimum: 0, maximum: 10000, description: 'Offset for paging through results; counts cover all matching rows.' };
const status = { type: 'string', enum: ['all', 'active', 'lactating', 'dry', 'culled'] };
function definition(name, description, properties = {}, required = []) {
  return { type: 'function', function: { name, description,
    parameters: { type: 'object', properties, required, additionalProperties: false } } };
}
const DEFINITIONS = [
  definition('herd_summary', 'Count cows by status, breed and lactation number. Active means not culled; all includes retained culled cows.'),
  definition('find_cows', 'Search demo cow tags or breeds, filter status and paginate. Null fields are unknown, not zero.', { search: text('Partial tag or breed'), status, offset: page }),
  definition('cow_history', 'Read one exact cow tag and its stored event/withholding snapshots, without recalculating. Counts include all events; pages contain up to 20.', { tag: text('Exact cow tag, as provided or resolved in conversation'), offset: page }, ['tag']),
  definition('event_records', 'Count and list non-voided events with optional exact cow tag, product-name search, event type and inclusive ISO date range. No clinical notes or actor names.', {
    tag: text('Exact cow tag'), medicine: text('Partial product name'),
    event_type: { type: 'string', enum: ['calving', 'treatment', 'dry_off', 'calcium', 'other'] },
    from: text('Inclusive YYYY-MM-DD', 10), to: text('Inclusive YYYY-MM-DD', 10), offset: page
  }),
  definition('milk_holds', 'Read today\'s exact Dashboard exclusions including unresolved and predicted holds. NOT a release decision. Filter exact tag if needed.', { tag: text('Exact cow tag'), offset: page }),
  definition('medicine_library', 'Count/search active, inactive or unverified medicine references. Search product/ingredient/ACVM number. Label text and rules only returned for a product search, not entire library.', {
    search: text('Partial name, active ingredient or ACVM number'),
    state: { type: 'string', enum: ['active', 'inactive', 'unverified', 'all'] }, offset: page
  }),
  definition('milking_plan', 'Read current farm-wide frequency and effective-dated changes; no free-text schedule notes.', { offset: page }),
  definition('review_queue', 'Count/list open or resolved event reviews. No reviewer identities, reasons or free-text resolutions are disclosed.', {
    state: { type: 'string', enum: ['open', 'resolved', 'all'] }, tag: text('Exact cow tag'), offset: page
  }),
  definition('scc_evidence', 'Read numeric SCC test evidence and recorded dry-off decisions for an exact cow tag. Historical decisions are not new treatment recommendations.', { tag: text('Exact cow tag'), offset: page }, ['tag'])
];

function validateArguments(name, args) {
  const schema = DEFINITIONS.find(item => item.function.name === name)?.function.parameters;
  if (!schema || !args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (Object.keys(args).some(key => !Object.hasOwn(schema.properties, key))) return false;
  if (schema.required.some(key => !Object.hasOwn(args, key))) return false;
  return Object.entries(args).every(([key, value]) => {
    const rule = schema.properties[key];
    if (rule.type === 'string') return typeof value === 'string' && value.length > 0 && value.length <= (rule.maxLength || 100)
      && !/[\u0000-\u001f\u007f]/.test(value) && (!rule.enum || rule.enum.includes(value))
      && (!['from', 'to'].includes(key) || /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
    return Number.isInteger(value) && value >= rule.minimum && value <= rule.maximum;
  }) && (!args.from || !args.to || args.from <= args.to);
}

const pick = (row, keys) => Object.fromEntries(keys.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
const EVENT_FIELDS = ['id', 'tag_number', 'event_type', 'event_date', 'drug_name', 'withdrawal_status', 'withdrawal_end_date',
  'eligible_from_date', 'requires_attention', 'on_hold_today', 'is_estimate', 'calving_date', 'calving_date_source',
  'withdrawal_days_applied', 'milkings_per_day_applied', 'drug_rule_name', 'acvm_registration_no', 'label_revision', 'warnings'];
const literalLike = value => `%${String(value).replace(/[\\%_]/g, '\\$&')}%`;

function createAssistantTools({ db, vatExclusions, cowStatus, now = Date.now }) {
  function summary() {
    const by_status = db.prepare('SELECT status, COUNT(*) AS count FROM cows GROUP BY status ORDER BY status').all();
    return {
      schema_version: db.pragma('user_version', { simple: true }),
      total_including_culled: by_status.reduce((n, row) => n + row.count, 0),
      active: by_status.filter(row => row.status !== 'culled').reduce((n, row) => n + row.count, 0), by_status,
      by_breed: db.prepare("SELECT breed, status, COUNT(*) AS count FROM cows GROUP BY breed, status ORDER BY breed, status LIMIT 30").all(),
      by_lactation: db.prepare('SELECT lactation_number, status, COUNT(*) AS count FROM cows GROUP BY lactation_number, status ORDER BY lactation_number, status LIMIT 30').all(),
      grouping_limit: 'Each grouped breakdown is limited to 30 rows; total and active counts cover all cows.'
    };
  }
  function paged(rows, total, offset = 0) { return { total, offset, returned: rows.length, truncated: total > offset + rows.length, rows }; }
  function execute(name, args = {}, role) {
    if (!ROLES.includes(role)) return { error: 'not_authorised' };
    if (!validateArguments(name, args)) return { error: 'invalid_tool_arguments' };
    const offset = args.offset || 0;
    const source = { label: name.replace(/_/g, ' '), href: '/assistant.html', checked_at: new Date(now()).toISOString(), tool: name };
    let data;
    if (name === 'herd_summary') { data = summary(); source.href = '/herd.html'; }
    if (name === 'find_cows') {
      const where = []; const params = [];
      if (args.search) { where.push("(tag_number LIKE ? ESCAPE '\\' OR breed LIKE ? ESCAPE '\\')"); params.push(literalLike(args.search), literalLike(args.search)); }
      if (args.status === 'active') where.push("status != 'culled'");
      else if (args.status && args.status !== 'all') { where.push('status = ?'); params.push(args.status); }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM cows ${clause}`).get(...params).n;
      data = paged(db.prepare(`SELECT tag_number, breed, birth_date, lactation_number, status FROM cows ${clause} ORDER BY tag_number LIMIT 20 OFFSET ?`).all(...params, offset), total, offset);
      source.href = '/herd.html';
    }
    if (name === 'cow_history') {
      const cow = db.prepare('SELECT tag_number, breed, status, lactation_number FROM cows WHERE tag_number = ?').get(args.tag);
      if (!cow) data = { found: false, message: 'No exact cow tag found. Ask the user to check the tag.' };
      else {
        const snapshot = cowStatus(args.tag);
        data = { found: true, cow, message: snapshot.message, on_hold_today: snapshot.on_hold_today,
          requires_attention: snapshot.requires_attention,
          ...paged(snapshot.events.slice(offset, offset + 20).map(row => ({ ...pick(row, EVENT_FIELDS),
            milking_schedule_snapshot: (row.milking_schedule_snapshot || []).slice(0, 20).map(entry => pick(entry, ['effective_from', 'milkings_per_day'])) })), snapshot.events.length, offset) };
      }
      source.href = '/events.html';
    }
    if (name === 'event_records') {
      const where = ['e.deleted_at IS NULL']; const params = [];
      for (const [key, column] of Object.entries({ tag: 'c.tag_number', event_type: 'e.event_type' })) {
        if (args[key]) { where.push(`${column} = ?`); params.push(args[key]); }
      }
      if (args.medicine) { where.push("d.drug_name LIKE ? ESCAPE '\\'"); params.push(literalLike(args.medicine)); }
      if (args.from) { where.push('e.event_date >= ?'); params.push(args.from); }
      if (args.to) { where.push('e.event_date <= ?'); params.push(args.to); }
      const tables = `FROM health_events e JOIN cows c ON e.cow_id = c.id LEFT JOIN drugs d ON e.drug_id = d.id WHERE ${where.join(' AND ')}`;
      const total = db.prepare(`SELECT COUNT(*) AS n ${tables}`).get(...params).n;
      data = { ...paged(db.prepare(`SELECT e.id, c.tag_number, e.event_type, e.event_date, d.drug_name,
        e.withdrawal_status, e.withdrawal_end_date, e.calving_date, e.calving_date_source ${tables}
        ORDER BY e.event_date DESC, e.id DESC LIMIT 20 OFFSET ?`).all(...params, offset), total, offset),
      by_event_type: db.prepare(`SELECT e.event_type, COUNT(*) AS count ${tables} GROUP BY e.event_type`).all(...params),
      warning: 'Dates are stored snapshots, not fresh release decisions. Use cow_history for their evidence and warnings.' };
      source.href = '/events.html';
    }
    if (name === 'milk_holds') {
      const rows = vatExclusions().filter(row => !args.tag || String(row.tag_number) === args.tag);
      data = { today_utc: new Date(now()).toISOString().slice(0, 10), cow_count: new Set(rows.map(row => row.tag_number)).size,
        unresolved_records: rows.filter(row => row.requires_attention || !row.withdrawal_end_date).length,
        ...paged(rows.slice(offset, offset + 20).map(row => pick(row, EVENT_FIELDS)), rows.length, offset),
        warning: 'No listed hold is not proof of safe milk. Unknown and predicted dates stay on hold; labels, farm checks and veterinarian remain authoritative.' };
      source.href = '/';
    }
    if (name === 'medicine_library') {
      const where = []; const params = []; const state = args.state || 'active';
      if (state === 'active' || state === 'inactive') { where.push('is_active = ?'); params.push(state === 'active' ? 1 : 0); }
      if (state === 'unverified') where.push('(verified_on IS NULL OR current_reference_revision_id IS NULL)');
      if (args.search) {
        where.push("(drug_name LIKE ? ESCAPE '\\' OR active_ingredient LIKE ? ESCAPE '\\' OR acvm_registration_no LIKE ? ESCAPE '\\')");
        params.push(...Array(3).fill(literalLike(args.search)));
      }
      const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db.prepare(`SELECT COUNT(*) AS n FROM drugs ${clause}`).get(...params).n;
      // Whitelist metadata; omit personal verifier identities and free-text evidence source fields.
      const drugs = db.prepare(`SELECT id, drug_name, active_ingredient, is_active, acvm_registration_no, label_revision,
        verified_on, current_reference_revision_id, calculation_basis, minimum_dry_period_days,
        whp_depends_on_dose, requires_regimen FROM drugs ${clause} ORDER BY drug_name LIMIT 20 OFFSET ?`).all(...params, offset);
      data = paged(drugs.map(drug => {
        const row = { ...drug }; delete row.current_reference_revision_id;
        if (args.search) {
          const revision = db.prepare('SELECT label_wording FROM drug_reference_revisions WHERE id = ?').get(drug.current_reference_revision_id);
          row.label_wording = revision?.label_wording?.slice(0, 3500) || null;
          row.label_wording_truncated = (revision?.label_wording?.length || 0) > 3500;
          row.rule_count = db.prepare('SELECT COUNT(*) AS n FROM drug_withdrawal_rules WHERE drug_id = ? AND reference_revision_id = ?').get(drug.id, drug.current_reference_revision_id).n;
          row.rules = db.prepare(`SELECT rule_name, milkings_once_daily, milkings_twice_daily, is_default
            FROM drug_withdrawal_rules WHERE drug_id = ? AND reference_revision_id = ? ORDER BY id LIMIT 10`).all(drug.id, drug.current_reference_revision_id);
          row.rules_truncated = row.rule_count > row.rules.length;
        }
        return row;
      }), total, offset);
      source.href = '/medicines.html';
    }
    if (name === 'milking_plan') {
      const today = new Date(now()).toISOString().slice(0, 10);
      const current = db.prepare('SELECT effective_from, milkings_per_day FROM milking_schedule WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1').get(today) || null;
      data = { today_utc: today, scope: 'farm-wide', current,
        ...paged(db.prepare('SELECT effective_from, milkings_per_day FROM milking_schedule ORDER BY effective_from DESC LIMIT 20 OFFSET ?').all(offset), db.prepare('SELECT COUNT(*) AS n FROM milking_schedule').get().n, offset) };
      source.href = '/schedule.html';
    }
    if (name === 'review_queue') {
      const where = []; const params = []; const state = args.state || 'open';
      if (state !== 'all') { where.push('r.status = ?'); params.push(state); }
      if (args.tag) { where.push('c.tag_number = ?'); params.push(args.tag); }
      const tables = `FROM event_reviews r JOIN health_events e ON r.health_event_id = e.id JOIN cows c ON e.cow_id = c.id
        LEFT JOIN drugs d ON e.drug_id = d.id ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`;
      data = paged(db.prepare(`SELECT r.id, c.tag_number, d.drug_name, r.status, e.event_date, e.withdrawal_status, e.calving_date_source,
        r.resolved_at ${tables} ORDER BY r.id DESC LIMIT 20 OFFSET ?`).all(...params, offset), db.prepare(`SELECT COUNT(*) AS n ${tables}`).get(...params).n, offset);
      source.href = '/reviews.html';
    }
    if (name === 'scc_evidence') {
      const cow = db.prepare('SELECT id, tag_number FROM cows WHERE tag_number = ?').get(args.tag);
      data = !cow ? { found: false } : { found: true, tag: cow.tag_number,
        tests: paged(db.prepare('SELECT test_date, scc_value, source FROM scc_records WHERE cow_id = ? ORDER BY test_date DESC LIMIT 20 OFFSET ?').all(cow.id, offset), db.prepare('SELECT COUNT(*) AS n FROM scc_records WHERE cow_id = ?').get(cow.id).n, offset),
        decisions: paged(db.prepare('SELECT season, decision FROM dry_off_decisions WHERE cow_id = ? ORDER BY season DESC LIMIT 20 OFFSET ?').all(cow.id, offset), db.prepare('SELECT COUNT(*) AS n FROM dry_off_decisions WHERE cow_id = ?').get(cow.id).n, offset),
        warning: 'Historical evidence/decisions only. Chat is not a prescribing or dry-off decision authority.' };
      source.href = '/dry-off.html';
    }
    // Keep each tool result bounded, including unusually long imported text fields.
    if (JSON.stringify(data).length > 18000) data = { omitted: true, message: 'Result too large. Narrow the search or use the linked page.' };
    return { data, source: { ...source, filters: args, facts: data } };
  }
  return { definitions: DEFINITIONS, execute };
}

module.exports = { createAssistantTools, validateArguments, KNOWLEDGE, DEFINITIONS };
