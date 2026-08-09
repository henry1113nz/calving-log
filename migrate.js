// 数据库迁移。
//
// SQLite 无法用 ALTER TABLE 给已有的表加约束,唯一的办法是按官方文档的做法
// 重建表:建新表 → 拷数据 → 删旧表 → 改名。把每一次结构变更写成一个带版本号
// 的迁移,记录在 PRAGMA user_version 里,已经存在的数据库就能升级而不必删库重建。

const MIGRATIONS = [
  {
    version: 1,
    name: 'initial six-table schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'milker'
            CHECK (role IN ('owner', 'milker', 'vet')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE cows (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tag_number TEXT NOT NULL UNIQUE,
          breed TEXT,
          birth_date TEXT,
          lactation_number INTEGER,
          status TEXT NOT NULL DEFAULT 'lactating'
            CHECK (status IN ('lactating', 'dry', 'culled')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE drugs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          drug_name TEXT NOT NULL UNIQUE,
          active_ingredient TEXT,
          milk_withdrawal_days INTEGER NOT NULL,
          meat_withdrawal_days INTEGER,
          calculation_basis TEXT NOT NULL DEFAULT 'treatment_date'
            CHECK (calculation_basis IN ('treatment_date', 'calving_date')),
          is_active INTEGER NOT NULL DEFAULT 1
        );

        CREATE TABLE scc_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cow_id INTEGER NOT NULL REFERENCES cows(id),
          test_date TEXT NOT NULL,
          scc_value INTEGER NOT NULL,
          source TEXT NOT NULL DEFAULT 'herd_test'
            CHECK (source IN ('herd_test', 'rmt', 'inline', 'culture')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE TABLE health_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cow_id INTEGER NOT NULL REFERENCES cows(id),
          event_type TEXT NOT NULL
            CHECK (event_type IN ('calving', 'treatment', 'dry_off', 'calcium', 'other')),
          event_date TEXT NOT NULL,
          calving_date TEXT,
          drug_id INTEGER REFERENCES drugs(id),
          withdrawal_days_applied INTEGER,
          withdrawal_end_date TEXT,
          notes TEXT,
          created_by INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          deleted_at TEXT
        );

        CREATE TABLE dry_off_decisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cow_id INTEGER NOT NULL REFERENCES cows(id),
          season TEXT NOT NULL,
          decision TEXT NOT NULL
            CHECK (decision IN ('antibiotic_dct', 'teat_seal_only')),
          justification TEXT,
          supporting_scc_id INTEGER REFERENCES scc_records(id),
          decided_by INTEGER REFERENCES users(id),
          decided_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);
    }
  },

  {
    version: 2,
    name: 'tighten value constraints and index foreign keys',
    up: (db) => {
      // 日期校验用 strftime 回写比对:strftime 对无法解析的字符串返回 NULL,
      // 用 IS 而不是 = 才能让 NULL 判为不相等。这同时也拒绝了 '2026-8-1'
      // 这种非标准写法,以及 '2026-02-31' 这种会被 SQLite 悄悄归一化的假日期。
      db.exec(`
        CREATE TABLE cows__new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          tag_number TEXT NOT NULL UNIQUE,
          breed TEXT,
          birth_date TEXT
            CHECK (birth_date IS NULL OR birth_date IS strftime('%Y-%m-%d', birth_date)),
          lactation_number INTEGER
            CHECK (lactation_number IS NULL OR lactation_number >= 0),
          status TEXT NOT NULL DEFAULT 'lactating'
            CHECK (status IN ('lactating', 'dry', 'culled')),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO cows__new (id, tag_number, breed, birth_date, lactation_number, status, created_at)
          SELECT id, tag_number, breed, birth_date, lactation_number, status, created_at FROM cows;
        DROP TABLE cows;
        ALTER TABLE cows__new RENAME TO cows;

        CREATE TABLE drugs__new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          drug_name TEXT NOT NULL UNIQUE,
          active_ingredient TEXT,
          milk_withdrawal_days INTEGER NOT NULL
            CHECK (milk_withdrawal_days >= 0),
          meat_withdrawal_days INTEGER
            CHECK (meat_withdrawal_days IS NULL OR meat_withdrawal_days >= 0),
          calculation_basis TEXT NOT NULL DEFAULT 'treatment_date'
            CHECK (calculation_basis IN ('treatment_date', 'calving_date')),
          is_active INTEGER NOT NULL DEFAULT 1
            CHECK (is_active IN (0, 1))
        );
        INSERT INTO drugs__new (id, drug_name, active_ingredient, milk_withdrawal_days,
                                meat_withdrawal_days, calculation_basis, is_active)
          SELECT id, drug_name, active_ingredient, milk_withdrawal_days,
                 meat_withdrawal_days, calculation_basis, is_active FROM drugs;
        DROP TABLE drugs;
        ALTER TABLE drugs__new RENAME TO drugs;

        CREATE TABLE scc_records__new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cow_id INTEGER NOT NULL REFERENCES cows(id),
          test_date TEXT NOT NULL
            CHECK (test_date IS strftime('%Y-%m-%d', test_date)),
          scc_value INTEGER NOT NULL
            CHECK (scc_value >= 0),
          source TEXT NOT NULL DEFAULT 'herd_test'
            CHECK (source IN ('herd_test', 'rmt', 'inline', 'culture')),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (cow_id, test_date, source)
        );
        INSERT INTO scc_records__new (id, cow_id, test_date, scc_value, source, created_at)
          SELECT id, cow_id, test_date, scc_value, source, created_at FROM scc_records;
        DROP TABLE scc_records;
        ALTER TABLE scc_records__new RENAME TO scc_records;

        CREATE TABLE health_events__new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cow_id INTEGER NOT NULL REFERENCES cows(id),
          event_type TEXT NOT NULL
            CHECK (event_type IN ('calving', 'treatment', 'dry_off', 'calcium', 'other')),
          event_date TEXT NOT NULL
            CHECK (event_date IS strftime('%Y-%m-%d', event_date)),
          calving_date TEXT
            CHECK (calving_date IS NULL OR calving_date IS strftime('%Y-%m-%d', calving_date)),
          drug_id INTEGER REFERENCES drugs(id),
          withdrawal_days_applied INTEGER
            CHECK (withdrawal_days_applied IS NULL OR withdrawal_days_applied >= 0),
          withdrawal_end_date TEXT
            CHECK (withdrawal_end_date IS NULL OR withdrawal_end_date IS strftime('%Y-%m-%d', withdrawal_end_date)),
          notes TEXT,
          created_by INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          deleted_at TEXT
        );
        INSERT INTO health_events__new (id, cow_id, event_type, event_date, calving_date, drug_id,
                                        withdrawal_days_applied, withdrawal_end_date, notes,
                                        created_by, created_at, deleted_at)
          SELECT id, cow_id, event_type, event_date, calving_date, drug_id,
                 withdrawal_days_applied, withdrawal_end_date, notes,
                 created_by, created_at, deleted_at FROM health_events;
        DROP TABLE health_events;
        ALTER TABLE health_events__new RENAME TO health_events;

        -- 一头牛在一个产季只能有一个干奶用药决定。同季两条互相矛盾的记录会直接
        -- 摧毁这张表存在的意义:它是 2027 年起要拿来作为个体化用药理由的证据。
        CREATE TABLE dry_off_decisions__new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          cow_id INTEGER NOT NULL REFERENCES cows(id),
          -- 产季写成 '2026-27' 这样的跨年形式,不是一个可解析的日期,用模式匹配校验。
          season TEXT NOT NULL
            CHECK (season GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
          decision TEXT NOT NULL
            CHECK (decision IN ('antibiotic_dct', 'teat_seal_only')),
          justification TEXT,
          supporting_scc_id INTEGER REFERENCES scc_records(id),
          decided_by INTEGER REFERENCES users(id),
          decided_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (cow_id, season)
        );
        INSERT INTO dry_off_decisions__new (id, cow_id, season, decision, justification,
                                            supporting_scc_id, decided_by, decided_at)
          SELECT id, cow_id, season, decision, justification,
                 supporting_scc_id, decided_by, decided_at FROM dry_off_decisions;
        DROP TABLE dry_off_decisions;
        ALTER TABLE dry_off_decisions__new RENAME TO dry_off_decisions;
      `);

      // 外键列如果不建索引,每次 JOIN 都是全表扫描,而且删除父行时 SQLite
      // 要扫子表来检查约束。数据量小时看不出来,但结构上是缺的。
      db.exec(`
        CREATE INDEX idx_health_events_cow        ON health_events (cow_id);
        CREATE INDEX idx_health_events_drug       ON health_events (drug_id);
        CREATE INDEX idx_health_events_created_by ON health_events (created_by);
        CREATE INDEX idx_scc_records_cow          ON scc_records (cow_id);
        CREATE INDEX idx_decisions_cow            ON dry_off_decisions (cow_id);
        CREATE INDEX idx_decisions_scc            ON dry_off_decisions (supporting_scc_id);
        CREATE INDEX idx_decisions_decided_by     ON dry_off_decisions (decided_by);
      `);

      // 每日禁挤清单是本系统最常跑、也最要紧的查询。用部分索引把软删除的记录
      // 直接排除在索引之外,查询只需扫仍然有效的停药期记录。
      db.exec(`
        CREATE INDEX idx_health_events_withdrawal
          ON health_events (withdrawal_end_date)
          WHERE deleted_at IS NULL AND withdrawal_end_date IS NOT NULL;
      `);
    }
  },

  {
    version: 3,
    name: 'record a structured diagnosis on health events',
    up: (db) => {
      // 干奶用药的判定标准之一是"本泌乳期内有临床乳房炎史",但原来的表里
      // 根本没有地方记录一次治疗到底治的是什么病。只能去 notes 里搜关键词,
      // 而 notes 是自由文本:写 'mastitis'、'Mastitis'、'mast LF' 还是留空
      // 全凭当班的人。合规证据不能建立在字符串匹配上,所以补一个受控字段。
      //
      // 可空:既有记录无法追溯补填,而"没写"和"没有病"是两回事。
      db.exec(`
        ALTER TABLE health_events ADD COLUMN diagnosis TEXT
          CHECK (diagnosis IS NULL OR diagnosis IN (
            'clinical_mastitis', 'milk_fever', 'lameness',
            'retained_membranes', 'metritis', 'ketosis', 'other'
          ))
      `);

      db.exec(`
        CREATE INDEX idx_health_events_diagnosis
          ON health_events (cow_id, diagnosis)
          WHERE diagnosis IS NOT NULL AND deleted_at IS NULL;
      `);
    }
  }
];

const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// 迁移机制是后来才加的,在那之前建的数据库里 user_version 还是 0,但表已经
// 是版本 1 的样子了。靠有没有 health_events 表来区分"空库"和"版本 1 的旧库",
// 否则会把建表迁移重跑一遍然后报错。
function currentVersion(db) {
  const recorded = db.pragma('user_version', { simple: true });
  if (recorded > 0) {
    return recorded;
  }

  const alreadyBuilt = db.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name = 'health_events'
  `).get().count > 0;

  return alreadyBuilt ? 1 : 0;
}

function migrate(db) {
  const startingVersion = currentVersion(db);
  const pending = MIGRATIONS.filter(m => m.version > startingVersion);

  if (pending.length === 0) {
    return { from: startingVersion, to: startingVersion, applied: [] };
  }

  for (const migration of pending) {
    // 重建表要求外键检查关闭,而 PRAGMA foreign_keys 在事务内是空操作,
    // 所以只能在事务两侧设置。legacy_alter_table 是官方重建流程要求的:
    // 删掉旧表之后、改名之前,其它表的外键指向的是一张暂时不存在的表,
    // 新版 ALTER TABLE 会因此重新解析整个 schema 并报错。
    db.pragma('foreign_keys = OFF');
    db.pragma('legacy_alter_table = ON');

    try {
      db.transaction(() => {
        migration.up(db);
        db.pragma(`user_version = ${migration.version}`);
      })();
    } finally {
      db.pragma('legacy_alter_table = OFF');
      db.pragma('foreign_keys = ON');
    }

    const violations = db.pragma('foreign_key_check');
    if (violations.length > 0) {
      throw new Error(
        `Migration ${migration.version} (${migration.name}) left ` +
        `${violations.length} foreign key violations behind`
      );
    }

    console.log(`Applied migration ${migration.version}: ${migration.name}`);
  }

  return {
    from: startingVersion,
    to: LATEST_VERSION,
    applied: pending.map(m => m.version)
  };
}

module.exports = { migrate, LATEST_VERSION };
