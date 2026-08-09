const Database = require('better-sqlite3');
const { migrate } = require('./migrate');
const { seed } = require('./seed');

// 允许指向别的文件,这样验证脚本和以后的测试可以跑在副本上,不碰真实数据。
const DB_FILE = process.env.CALVING_LOG_DB || 'calving-log.db';

const db = new Database(DB_FILE);

// SQLite 默认不强制外键,必须每个连接单独打开。
db.pragma('foreign_keys = ON');

migrate(db);
seed(db);

module.exports = db;
