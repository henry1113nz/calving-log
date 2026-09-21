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
  },

  {
    version: 4,
    name: 'model how withholding periods are actually expressed on labels',
    up: (db) => {
      // 原来的模型假设停药期就是"一个天数",查了 ACVM 注册库和厂商标签之后
      // 发现这个假设不成立,而且不成立的方式有三种:
      //
      //   1. 单位跟给药途径走。注射和泌乳期乳内注入写小时(Orbenin L.A. 是
      //      96 小时),干奶药写的是产犊后的挤奶次数(Cepravin 是 8 milkings)。
      //      挤奶次数换算成天要看农场一天挤几次,一天一次的农场结果直接翻倍。
      //
      //   2. 干奶药还带一个前置条件:最小干奶期。Cepravin 的标签是
      //      "Treatment to be at least 49 days before calving"。牛要是提前
      //      产犊,标签条件根本没被满足,常规停药期不再适用。
      //
      //   3. 青霉素类的停药期随剂量变化。VCNZ 2023 年的通告说明标签剂量普遍
      //      偏低已被要求上调,剂量提高则停药期必须延长,MPI 为此单独出了一张
      //      69 个产品的对照表。一个产品一个数字表达不了这件事。
      //
      // 第 3 类不建模——那超出本项目范围,而且建了也大概率是错的。改成标记出来,
      // 强制人工填写。这和"干奶药没有产犊日期就不给解禁日"是同一条原则。
      db.exec(`
        CREATE TABLE drugs__new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          drug_name TEXT NOT NULL UNIQUE,
          active_ingredient TEXT,

          milk_withdrawal_value INTEGER NOT NULL
            CHECK (milk_withdrawal_value >= 0),
          milk_withdrawal_unit TEXT NOT NULL DEFAULT 'days'
            CHECK (milk_withdrawal_unit IN ('hours', 'days', 'milkings')),

          meat_withdrawal_days INTEGER
            CHECK (meat_withdrawal_days IS NULL OR meat_withdrawal_days >= 0),

          calculation_basis TEXT NOT NULL DEFAULT 'treatment_date'
            CHECK (calculation_basis IN ('treatment_date', 'calving_date')),

          minimum_dry_period_days INTEGER
            CHECK (minimum_dry_period_days IS NULL OR minimum_dry_period_days >= 0),

          whp_depends_on_dose INTEGER NOT NULL DEFAULT 0
            CHECK (whp_depends_on_dose IN (0, 1)),

          -- 核实凭证。只存数字不存出处,这张表就永远说不清哪些查过、哪些没查过。
          -- verified_on 为空即代表未核实,系统据此在界面上标出来。
          label_wording TEXT,
          source_reference TEXT,
          verified_on TEXT
            CHECK (verified_on IS NULL OR verified_on IS strftime('%Y-%m-%d', verified_on)),

          is_active INTEGER NOT NULL DEFAULT 1
            CHECK (is_active IN (0, 1)),

          -- 最小干奶期只有从产犊日起算的药才有意义。跨列的约束必须写成表级
          -- CHECK,放在所有列定义之后。
          CHECK (minimum_dry_period_days IS NULL OR calculation_basis = 'calving_date')
        );

        INSERT INTO drugs__new
          (id, drug_name, active_ingredient, milk_withdrawal_value, milk_withdrawal_unit,
           meat_withdrawal_days, calculation_basis, is_active)
        SELECT
          id, drug_name, active_ingredient, milk_withdrawal_days, 'days',
          meat_withdrawal_days, calculation_basis, is_active
        FROM drugs;

        DROP TABLE drugs;
        ALTER TABLE drugs__new RENAME TO drugs;
      `);

      // 挤奶次数换算成天需要知道农场一天挤几次。这是农场级设置,不是牛的属性,
      // 也不是药的属性。CHECK (id = 1) 把这张表锁成单行。
      db.exec(`
        CREATE TABLE farm_settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          milkings_per_day INTEGER NOT NULL DEFAULT 2
            CHECK (milkings_per_day IN (1, 2, 3)),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO farm_settings (id, milkings_per_day) VALUES (1, 2);
      `);

      // 停药期算不出来的时候,光把解除日留空会丢掉"为什么算不出来"。而这三种
      // 原因对挤奶工的意义完全不同:等产犊日期是正常状态,需要兽医意见是警告,
      // 最小干奶期被打破是必须拦下来的。
      db.exec(`
        ALTER TABLE health_events ADD COLUMN withdrawal_status TEXT
          CHECK (withdrawal_status IS NULL OR withdrawal_status IN (
            'calculated',
            'awaiting_calving_date',
            'requires_vet_advice',
            'minimum_dry_period_breached',
            'not_applicable'
          ))
      `);

      // 干奶用药时填的产犊日期是预测值,真正产犊之后才变成事实。不区分这两者,
      // 就没办法在牛实际产犊时回头把解除日重算一遍,也没办法在禁挤清单上告诉
      // 挤奶工"这个日期还是估的"。
      db.exec(`
        ALTER TABLE health_events ADD COLUMN calving_date_source TEXT
          CHECK (calving_date_source IS NULL OR calving_date_source IN ('predicted', 'actual'))
      `);

      // 回填既有记录:有解除日的算已算出,用了从产犊日起算的药但没有产犊日期的
      // 归为等待中,没用药的归为不适用。既有的产犊日期一律先当预测值,因为无法
      // 追溯判断当时那个日期是估的还是真的。
      db.exec(`
        UPDATE health_events
        SET withdrawal_status = CASE
          WHEN drug_id IS NULL THEN 'not_applicable'
          WHEN withdrawal_end_date IS NOT NULL THEN 'calculated'
          ELSE 'awaiting_calving_date'
        END;

        UPDATE health_events
        SET calving_date_source = 'predicted'
        WHERE calving_date IS NOT NULL;
      `);

      db.exec(`
        CREATE INDEX idx_health_events_pending_calving
          ON health_events (cow_id)
          WHERE deleted_at IS NULL AND calving_date_source = 'predicted';
      `);
    }
  },

  {
    version: 5,
    name: 'version verified ACVM references and regimen-specific withdrawal rules',
    up: (db) => {
      // v4 能保存“数值 + 单位”,但最新版批准标签暴露了两个仍然装不下的事实:
      // Orbenin L.A. 的停药期取决于实际疗程,而监管标签本身也会修订。药物表只
      // 放当前值会让旧事件在标签更新后失去依据,所以 v5 把来源版本和疗程规则
      // 独立出来,事件直接指向当时采用的版本与规则。
      db.exec(`
        ALTER TABLE drugs ADD COLUMN acvm_registration_no TEXT;
        ALTER TABLE drugs ADD COLUMN label_revision TEXT;
        ALTER TABLE drugs ADD COLUMN verified_by TEXT;
        ALTER TABLE drugs ADD COLUMN requires_regimen INTEGER NOT NULL DEFAULT 0
          CHECK (requires_regimen IN (0, 1));

        CREATE UNIQUE INDEX idx_drugs_acvm_registration
          ON drugs (acvm_registration_no)
          WHERE acvm_registration_no IS NOT NULL;

        CREATE TABLE drug_reference_revisions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          drug_id INTEGER NOT NULL REFERENCES drugs(id),
          acvm_registration_no TEXT NOT NULL,
          label_revision TEXT NOT NULL,
          label_wording TEXT NOT NULL,
          source_reference TEXT NOT NULL,
          verified_on TEXT NOT NULL
            CHECK (verified_on IS strftime('%Y-%m-%d', verified_on)),
          verified_by TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE (drug_id, label_revision)
        );

        CREATE INDEX idx_drug_reference_revisions_drug
          ON drug_reference_revisions (drug_id);

        CREATE TABLE drug_withdrawal_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          drug_id INTEGER NOT NULL REFERENCES drugs(id),
          reference_revision_id INTEGER NOT NULL REFERENCES drug_reference_revisions(id),
          rule_code TEXT NOT NULL,
          rule_name TEXT NOT NULL,
          description TEXT NOT NULL,
          milkings_once_daily INTEGER
            CHECK (milkings_once_daily IS NULL OR milkings_once_daily >= 0),
          milkings_twice_daily INTEGER
            CHECK (milkings_twice_daily IS NULL OR milkings_twice_daily >= 0),
          is_default INTEGER NOT NULL DEFAULT 0
            CHECK (is_default IN (0, 1)),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          CHECK (milkings_once_daily IS NOT NULL OR milkings_twice_daily IS NOT NULL),
          UNIQUE (drug_id, rule_code)
        );

        CREATE INDEX idx_drug_withdrawal_rules_drug
          ON drug_withdrawal_rules (drug_id);
        CREATE INDEX idx_drug_withdrawal_rules_revision
          ON drug_withdrawal_rules (reference_revision_id);
        CREATE UNIQUE INDEX idx_drug_withdrawal_rules_default
          ON drug_withdrawal_rules (drug_id)
          WHERE is_default = 1;

        ALTER TABLE drugs ADD COLUMN current_reference_revision_id INTEGER
          REFERENCES drug_reference_revisions(id);

        CREATE INDEX idx_drugs_current_reference_revision
          ON drugs (current_reference_revision_id);

        ALTER TABLE health_events ADD COLUMN drug_reference_revision_id INTEGER
          REFERENCES drug_reference_revisions(id);
        ALTER TABLE health_events ADD COLUMN drug_rule_id INTEGER
          REFERENCES drug_withdrawal_rules(id);

        CREATE INDEX idx_health_events_reference_revision
          ON health_events (drug_reference_revision_id);
        CREATE INDEX idx_health_events_drug_rule
          ON health_events (drug_rule_id);

        -- 监管数据纠错不能悄悄改写历史。每次批量回填都保留旧、新快照及原因。
        CREATE TABLE withdrawal_corrections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          health_event_id INTEGER NOT NULL REFERENCES health_events(id),
          previous_days INTEGER,
          previous_end_date TEXT,
          previous_status TEXT,
          corrected_days INTEGER,
          corrected_end_date TEXT,
          corrected_status TEXT,
          reason TEXT NOT NULL,
          corrected_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX idx_withdrawal_corrections_event
          ON withdrawal_corrections (health_event_id);

        -- 导入版本让官方数据包只应用一次,也给报告留下可查询的审计点。
        CREATE TABLE reference_data_imports (
          version TEXT PRIMARY KEY,
          source_summary TEXT NOT NULL,
          imported_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        -- “已核验”必须同时具备产品身份、标签版本、原文、来源和核验人。
        -- API 校验不够,直接写数据库也必须被挡住。
        CREATE TRIGGER drugs_verified_provenance_insert
        BEFORE INSERT ON drugs
        WHEN NEW.verified_on IS NOT NULL AND (
          NEW.acvm_registration_no IS NULL OR NEW.label_revision IS NULL OR
          NEW.verified_by IS NULL OR NEW.label_wording IS NULL OR
          NEW.source_reference IS NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'verified drug requires complete ACVM provenance');
        END;

        CREATE TRIGGER drugs_verified_provenance_update
        BEFORE UPDATE ON drugs
        WHEN NEW.verified_on IS NOT NULL AND (
          NEW.acvm_registration_no IS NULL OR NEW.label_revision IS NULL OR
          NEW.verified_by IS NULL OR NEW.label_wording IS NULL OR
          NEW.source_reference IS NULL
        )
        BEGIN
          SELECT RAISE(ABORT, 'verified drug requires complete ACVM provenance');
        END;
      `);
    }
  },

  {
    version: 6,
    name: 'effective-dated milking schedules and event calculation snapshots',
    up: (db) => {
      // Milking frequency changes through the season. A single farm-wide number cannot
      // explain which frequency was used for an old treatment, or which one should be
      // used when a dry cow calves months after treatment. Store dated changes and keep
      // the exact schedule used by each calculation as an event snapshot.
      db.exec(`
        CREATE TABLE milking_schedule (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          effective_from TEXT NOT NULL UNIQUE
            CHECK (effective_from IS strftime('%Y-%m-%d', effective_from)),
          milkings_per_day INTEGER NOT NULL
            CHECK (milkings_per_day IN (1, 2, 3)),
          note TEXT,
          created_by INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX idx_milking_schedule_created_by
          ON milking_schedule (created_by);

        INSERT INTO milking_schedule (effective_from, milkings_per_day, note)
        SELECT '2000-01-01', milkings_per_day,
               'Baseline migrated from the previous farm setting'
        FROM farm_settings
        WHERE id = 1;

        ALTER TABLE health_events ADD COLUMN milkings_per_day_applied INTEGER
          CHECK (milkings_per_day_applied IS NULL OR milkings_per_day_applied IN (1, 2, 3));
        ALTER TABLE health_events ADD COLUMN milking_schedule_snapshot TEXT;

        UPDATE health_events
        SET milkings_per_day_applied = (SELECT milkings_per_day FROM farm_settings WHERE id = 1),
            milking_schedule_snapshot = json_array(json_object(
              'effective_from', '2000-01-01',
              'milkings_per_day', (SELECT milkings_per_day FROM farm_settings WHERE id = 1),
              'source', 'v5_baseline'
            ))
        WHERE drug_id IN (
          SELECT id FROM drugs
          WHERE milk_withdrawal_unit = 'milkings' OR requires_regimen = 1
        );
      `);
    }
  },

  {
    version: 7,
    name: 'authenticate users and audit operational corrections and reviews',
    up: (db) => {
      db.exec(`
        ALTER TABLE users ADD COLUMN username TEXT;
        ALTER TABLE users ADD COLUMN password_salt TEXT;
        ALTER TABLE users ADD COLUMN password_hash TEXT;
        CREATE UNIQUE INDEX idx_users_username ON users(username) WHERE username IS NOT NULL;

        UPDATE users SET username = CASE name
          WHEN 'Farm Owner' THEN 'owner'
          WHEN 'Farm Vet' THEN 'vet'
          WHEN 'Relief Milker' THEN 'milker'
          ELSE 'user-' || id
        END;

        CREATE TABLE auth_sessions (
          token_hash TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL REFERENCES users(id),
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_auth_sessions_user ON auth_sessions(user_id);
        CREATE INDEX idx_auth_sessions_expiry ON auth_sessions(expires_at);

        CREATE TABLE event_corrections (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          health_event_id INTEGER NOT NULL REFERENCES health_events(id),
          reason TEXT NOT NULL CHECK (length(trim(reason)) >= 5),
          previous_snapshot TEXT NOT NULL CHECK (json_valid(previous_snapshot)),
          corrected_snapshot TEXT NOT NULL CHECK (json_valid(corrected_snapshot)),
          corrected_by INTEGER NOT NULL REFERENCES users(id),
          corrected_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX idx_event_corrections_event ON event_corrections(health_event_id);
        CREATE INDEX idx_event_corrections_user ON event_corrections(corrected_by);

        CREATE TABLE event_reviews (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          health_event_id INTEGER NOT NULL REFERENCES health_events(id),
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
          reason TEXT NOT NULL CHECK (length(trim(reason)) >= 5),
          resolution TEXT,
          opened_by INTEGER REFERENCES users(id),
          resolved_by INTEGER REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          resolved_at TEXT,
          CHECK (
            (status = 'open' AND resolution IS NULL AND resolved_by IS NULL AND resolved_at IS NULL)
            OR
            (status = 'resolved' AND resolution IS NOT NULL AND resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
          )
        );
        CREATE UNIQUE INDEX idx_event_reviews_open
          ON event_reviews(health_event_id) WHERE status = 'open';
        CREATE INDEX idx_event_reviews_event ON event_reviews(health_event_id);
        CREATE INDEX idx_event_reviews_opened_by ON event_reviews(opened_by);
        CREATE INDEX idx_event_reviews_resolved_by ON event_reviews(resolved_by);

        INSERT INTO event_reviews (health_event_id, reason, opened_by)
        SELECT id,
               'Legacy unresolved event requires an accountable review before milk enters the vat.',
               created_by
        FROM health_events
        WHERE deleted_at IS NULL
          AND withdrawal_status IN ('awaiting_calving_date', 'requires_vet_advice', 'minimum_dry_period_breached');
      `);
    }
  },

  {
    version: 8,
    name: 'capture privacy-conscious field usability feedback',
    up: (db) => {
      // A deployed prototype needs a traceable way to learn whether farm staff can
      // complete the core jobs without turning free-form feedback into another source
      // of sensitive operational data. Identity comes from the signed-in session and
      // the structured fields make the trial results easy to compare.
      db.exec(`
        CREATE TABLE field_feedback (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          area TEXT NOT NULL CHECK (area IN (
            'dashboard', 'treatments', 'reviews', 'herd', 'dry_off', 'medicines', 'overall'
          )),
          task_code TEXT NOT NULL CHECK (task_code IN (
            'find_hold', 'record_treatment', 'record_calving', 'change_schedule',
            'dry_off_review', 'review_unknown', 'overall_walkthrough'
          )),
          completion_status TEXT NOT NULL CHECK (completion_status IN (
            'completed', 'completed_with_help', 'not_completed'
          )),
          ease_rating INTEGER NOT NULL CHECK (ease_rating BETWEEN 1 AND 5),
          confusing_part TEXT CHECK (confusing_part IS NULL OR length(confusing_part) <= 1000),
          suggestion TEXT CHECK (suggestion IS NULL OR length(suggestion) <= 1000),
          submitted_by INTEGER NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );

        CREATE INDEX idx_field_feedback_submitted_by
          ON field_feedback(submitted_by);
        CREATE INDEX idx_field_feedback_created_at
          ON field_feedback(created_at);
      `);
    }
  },
  {
    version: 9,
    name: 'let field feedback name the assistant page',
    up: (db) => {
      // 试用任务已经包含 Ask 页面,但反馈只能挂到别的页面上。参与者只好把助手的
      // 问题记进"整体走查",事后就分不清那条意见说的是哪一个界面——而助手恰好是
      // 最新、最需要被质疑的部分。
      //
      // SQLite 不能修改已有的 CHECK,所以照例重建表并搬走原有回复。索引跟着表一起
      // 被删,必须重建。
      db.exec(`
        CREATE TABLE field_feedback__new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          area TEXT NOT NULL CHECK (area IN (
            'dashboard', 'treatments', 'reviews', 'herd', 'dry_off', 'medicines',
            'assistant', 'overall'
          )),
          task_code TEXT NOT NULL CHECK (task_code IN (
            'find_hold', 'record_treatment', 'record_calving', 'change_schedule',
            'dry_off_review', 'review_unknown', 'ask_assistant', 'overall_walkthrough'
          )),
          completion_status TEXT NOT NULL CHECK (completion_status IN (
            'completed', 'completed_with_help', 'not_completed'
          )),
          ease_rating INTEGER NOT NULL CHECK (ease_rating BETWEEN 1 AND 5),
          confusing_part TEXT CHECK (confusing_part IS NULL OR length(confusing_part) <= 1000),
          suggestion TEXT CHECK (suggestion IS NULL OR length(suggestion) <= 1000),
          submitted_by INTEGER NOT NULL REFERENCES users(id),
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO field_feedback__new
          (id, area, task_code, completion_status, ease_rating, confusing_part,
           suggestion, submitted_by, created_at)
          SELECT id, area, task_code, completion_status, ease_rating, confusing_part,
                 suggestion, submitted_by, created_at
          FROM field_feedback;
        DROP TABLE field_feedback;
        ALTER TABLE field_feedback__new RENAME TO field_feedback;

        CREATE INDEX idx_field_feedback_submitted_by
          ON field_feedback(submitted_by);
        CREATE INDEX idx_field_feedback_created_at
          ON field_feedback(created_at);
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

// v5 was exercised against the development database while the migration was still
// being finalised. Keep this post-flight idempotent so any such database receives
// the final FK index without pretending a new data migration was applied.
function ensureV5Postflight(db, version) {
  if (version < 5) {
    return;
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_drugs_current_reference_revision
      ON drugs(current_reference_revision_id);
  `);
}

function migrate(db) {
  const startingVersion = currentVersion(db);
  const pending = MIGRATIONS.filter(m => m.version > startingVersion);

  if (pending.length === 0) {
    ensureV5Postflight(db, startingVersion);
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

  ensureV5Postflight(db, LATEST_VERSION);

  return {
    from: startingVersion,
    to: LATEST_VERSION,
    applied: pending.map(m => m.version)
  };
}

module.exports = { migrate, LATEST_VERSION };
