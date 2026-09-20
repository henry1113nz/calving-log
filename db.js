const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const { migrate } = require('./migrate');
const { seed } = require('./seed');
const { syncAcvmReferenceData } = require('./acvmReferenceData');
const { ensureUserCredentials } = require('./auth');

// 允许指向别的文件,这样验证脚本和以后的测试可以跑在副本上,不碰真实数据。
const DB_FILE = process.env.CALVING_LOG_DB || 'calving-log.db';
const absoluteDbFile = path.resolve(DB_FILE);
const databaseAlreadyExisted = fs.existsSync(absoluteDbFile);

const db = new Database(DB_FILE);

// SQLite 默认不强制外键,必须每个连接单独打开。
db.pragma('foreign_keys = ON');

migrate(db);
seed(db);
ensureUserCredentials(db);

// 官方参考数据有自己的版本与审计记录。既有开发库第一次导入前先生成一份
// v5 结构、旧参考值仍原样保留的备份;测试临时库和全新数据库不制造备份文件。
const referenceSync = syncAcvmReferenceData(db, {
  backupPath: databaseAlreadyExisted && !process.env.CALVING_LOG_DB
    ? `${absoluteDbFile}.backup-before-acvm-v5-20260817`
    : null
});
if (referenceSync.applied) {
  console.log(
    `Applied reference data ${referenceSync.version}; ` +
    `${referenceSync.revised_events} active event(s) reviewed`
  );
  if (referenceSync.backup) {
    console.log(
      `Reference-data backup: ${referenceSync.backup.path} ` +
      `(sha256 ${referenceSync.backup.sha256})`
    );
  }
}

module.exports = db;
