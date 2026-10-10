#!/usr/bin/env node

import { DatabaseSync } from 'node:sqlite';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { IssueStatus, IssueMode, VoteOption } from '../worker/enums.js';
import { DEFAULT_PUBLIC_SETTINGS, RATE_LIMIT_PATTERN, HERO_BACKGROUND_COLOR_PATTERN } from '../worker/api/settings.js';

interface PendingIssueRow {
  id: number;
  title: string | null;
  description: string | null;
  mode: number;
  start_at: number | null;
  end_at: number | null;
  status: number;
  created_at: number;
  updated_at: number;
}

function showHelp(): void {
  console.log('ChinaPoll admin CLI');
  console.log('Usage:');
  console.log('  npm run admin -- initialize-settings');
  console.log('  npm run admin -- set-setting <key> <value>');
  console.log('  npm run admin -- readonly on|off');
  console.log('  npm run admin -- approve-proposal <issue-id>');
  console.log('  npm run admin -- audit-proposal <id>');
  console.log('  npm run admin -- publish-issue <id>');
  console.log('  npm run admin -- finalize <issueId>');
  console.log('  npm run admin -- seed-sample-data');
  console.log('  npm run admin -- list-pending');
  console.log('  npm run admin -- migrate-rate-limit-columns');
  console.log('  npm run admin -- migrate-rate-limit-settings');
}

function getLocalDatabasePath(): string {
  const databaseDirectory = join(
    process.cwd(),
    '.wrangler',
    'v3',
    'd1',
    'miniflare-D1DatabaseObject'
  );
  const databaseFiles = readdirSync(databaseDirectory)
    .filter((name) => /^[a-f0-9]+\.sqlite$/.test(name));

  if (databaseFiles.length !== 1) {
    throw new Error(`Expected one local D1 database in ${databaseDirectory}, found ${databaseFiles.length}.`);
  }

  return join(databaseDirectory, databaseFiles[0]);
}

function initializeSettings(): void {
  const database = new DatabaseSync(getLocalDatabasePath());
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    const insert = database.prepare(
      'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
    );
    let inserted = 0;
    for (const [key, value] of Object.entries(DEFAULT_PUBLIC_SETTINGS)) {
      inserted += Number(insert.run(key, String(value)).changes);
    }
    database.exec('COMMIT');
    transactionStarted = false;
    console.log(`Initialized ${inserted} missing public settings.`);
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('Failed to roll back settings initialization:', rollbackError);
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

function upsertSetting(database: DatabaseSync, key: string, value: string): void {
  database.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, unixepoch())
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`
  ).run(key, value);
}

function validateSettingValue(key: string, value: string): { ok: true; value: string } | { ok: false; error: string } {
  if (!(key in DEFAULT_PUBLIC_SETTINGS)) {
    return { ok: false, error: `Unknown setting key "${key}". Known keys: ${Object.keys(DEFAULT_PUBLIC_SETTINGS).join(', ')}.` };
  }
  switch (key) {
    case 'default_locale':
      if (value !== 'en' && value !== 'zh-CN') return { ok: false, error: 'default_locale must be "en" or "zh-CN".' };
      break;
    case 'site_name':
      if (!value.trim() || value.length > 100) return { ok: false, error: 'site_name must contain 1 to 100 characters.' };
      break;
    case 'site_slogan':
      if (value.length > 300) return { ok: false, error: 'site_slogan must not exceed 300 characters.' };
      break;
    case 'data_repository_url':
      if (value && !value.startsWith('https://')) return { ok: false, error: 'data_repository_url must be an HTTPS URL or empty.' };
      break;
    case 'polls_per_page':
    case 'comments_per_page':
      if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 100) return { ok: false, error: `${key} must be an integer from 1 to 100.` };
      break;
    case 'page_max_width_px':
      if (!/^\d+$/.test(value) || Number(value) < 100 || Number(value) > 9999) return { ok: false, error: 'page_max_width_px must be an integer from 100 to 9999.' };
      break;
    case 'vote_rate_limit':
    case 'comment_rate_limit':
    case 'proposal_rate_limit': {
      const normalized = value.trim().toLowerCase();
      if (!RATE_LIMIT_PATTERN.test(normalized)) return { ok: false, error: `${key} must be in format "N/w|d|h|m|s" (e.g., "5/h", "3/h", "1/d").` };
      return { ok: true, value: normalized };
    }
    case 'hero_title':
      if (!value.trim() || value.length > 200) return { ok: false, error: 'hero_title must contain 1 to 200 characters.' };
      break;
    case 'hero_subtitle':
      if (value.length > 500) return { ok: false, error: 'hero_subtitle must not exceed 500 characters.' };
      break;
    case 'hero_background_color':
      if (value && !HERO_BACKGROUND_COLOR_PATTERN.test(value)) {
        return { ok: false, error: 'hero_background_color must be a CSS color (hex, rgb/a, hsl/a, or named) or a CSS gradient.' };
      }
      break;
    case 'read_only_mode':
    case 'turnstile_enable':
      if (value !== 'true' && value !== 'false') return { ok: false, error: `${key} must be "true" or "false".` };
      break;
    case 'turnstile_secret_key':
      if (value && !/^[0-9a-f]{64}$/i.test(value)) return { ok: false, error: 'turnstile_secret_key must be a 64-character hex string.' };
      break;
  }
  return { ok: true, value };
}

function setSetting(keyText: string | undefined, valueText: string | undefined): void {
  if (!keyText || valueText === undefined) {
    throw new Error('Usage: npm run admin -- set-setting <key> <value>');
  }
  const validation = validateSettingValue(keyText, valueText);
  if (!validation.ok) throw new Error(validation.error);

  const database = new DatabaseSync(getLocalDatabasePath());
  try {
    upsertSetting(database, keyText, validation.value);
    console.log(`Set ${keyText} = ${validation.value}`);
  } finally {
    database.close();
  }
}

function setReadOnly(modeText: string | undefined): void {
  if (modeText !== 'on' && modeText !== 'off') {
    throw new Error('Usage: npm run admin -- readonly on|off');
  }
  const database = new DatabaseSync(getLocalDatabasePath());
  try {
    upsertSetting(database, 'read_only_mode', modeText === 'on' ? 'true' : 'false');
    console.log(`Read-only mode set to ${modeText}.`);
  } finally {
    database.close();
  }
}

function approveProposal(idText: string | undefined): void {
  if (!idText || !/^[1-9]\d*$/.test(idText)) {
    throw new Error('Usage: npm run admin -- approve-proposal <positive issue ID>');
  }

  const issueId = Number(idText);
  if (!Number.isSafeInteger(issueId)) {
    throw new Error('Issue ID must be a safe integer.');
  }

  const database = new DatabaseSync(getLocalDatabasePath());
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;

    const proposal = database.prepare(
      `SELECT id, title, description, mode, start_at, end_at, status
       FROM issues WHERE id = ?`
    ).get(issueId) as PendingIssueRow | undefined;

    if (!proposal) throw new Error(`Pending issue ${issueId} was not found.`);
    if (proposal.status !== IssueStatus.Pending) {
      throw new Error(`Issue ${issueId} is not pending approval.`);
    }
    if (proposal.mode !== IssueMode.Deadline && proposal.mode !== IssueMode.Evergreen) {
      throw new Error(`Issue ${issueId} has an unsupported mode.`);
    }
    if (!proposal.title?.trim()) {
      throw new Error(`Issue ${issueId} has no title.`);
    }

    const update = database.prepare(
      `UPDATE issues
       SET status = ?, reviewed_at = unixepoch(), updated_at = unixepoch()
       WHERE id = ? AND status = ?`
    ).run(IssueStatus.Open, issueId, IssueStatus.Pending);

    if (update.changes !== 1) {
      throw new Error(`Issue ${issueId} changed before approval could complete.`);
    }

    database.exec('COMMIT');
    transactionStarted = false;
    console.log(`Approved submission; issue ID ${issueId} is now open.`);
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('Failed to roll back proposal approval:', rollbackError);
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

const [command = 'help', argument] = process.argv.slice(2);

try {
  switch (command) {
    case 'initialize-settings':
      initializeSettings();
      break;
    case 'approve-proposal':
      approveProposal(argument);
      break;
    case 'audit-proposal':
      console.log(`Audit proposal ${argument ?? 'unknown'} with rule set: 1, 2, 3, 4, 5`);
      break;
    case 'publish-issue':
      console.log(`Publish issue ${argument ?? 'unknown'} to the public feed.`);
      break;
    case 'finalize':
      console.log(`Finalize issue ${argument ?? 'unknown'} and export CSV snapshot.`);
      break;
    case 'set-setting':
      setSetting(argument, process.argv.slice(4).join(' '));
      break;
    case 'readonly':
      setReadOnly(argument);
      break;

function listPending(): void {
  const database = new DatabaseSync(getLocalDatabasePath());
  try {
    const pending = database.prepare(
      `SELECT id, title, description, mode, start_at, end_at, status, created_at, updated_at
       FROM issues WHERE status = ? ORDER BY id DESC`
    ).all(IssueStatus.Pending) as unknown as PendingIssueRow[];

    if (pending.length === 0) {
      console.log('No pending issues found.');
      return;
    }

    console.log(`Found ${pending.length} pending issue(s):\n`);
    for (const issue of pending) {
      const modeLabel = issue.mode === IssueMode.Deadline ? 'Deadline' : 'Evergreen';
      const startAt = issue.start_at ? new Date(issue.start_at * 1000).toISOString().split('T')[0] : 'N/A';
      const endAt = issue.end_at ? new Date(issue.end_at * 1000).toISOString().split('T')[0] : 'N/A';
      const createdAt = new Date(issue.created_at * 1000).toISOString().split('T')[0];

      console.log(`ID: ${issue.id}`);
      console.log(`  Title: ${issue.title ?? '(no title)'}`);
      console.log(`  Description: ${issue.description?.substring(0, 80) ?? '(none)'}${issue.description && issue.description.length > 80 ? '...' : ''}`);
      console.log(`  Mode: ${modeLabel}`);
      console.log(`  Start: ${startAt}, End: ${endAt}`);
      console.log(`  Created: ${createdAt}`);
      console.log('');
    }
  } catch (error) {
    throw error;
  } finally {
    database.close();
  }
}

function migrateRateLimitColumns(): void {
  const database = new DatabaseSync(getLocalDatabasePath());
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;

    // Add ts_bucket column to votes table (replaces ts_hour)
    try {
      database.exec('ALTER TABLE votes ADD COLUMN ts_bucket INTEGER');
      console.log('Added ts_bucket column to votes table');
    } catch (e) {
      if (!(e instanceof Error && e.message.includes('duplicate column'))) throw e;
      console.log('ts_bucket column already exists in votes table');
    }

    // Add ip_prefix and ts_bucket to comments table (replaces hour_bucket)
    try {
      database.exec('ALTER TABLE comments ADD COLUMN ip_prefix TEXT');
      console.log('Added ip_prefix column to comments table');
    } catch (e) {
      if (!(e instanceof Error && e.message.includes('duplicate column'))) throw e;
      console.log('ip_prefix column already exists in comments table');
    }

    try {
      database.exec('ALTER TABLE comments ADD COLUMN ts_bucket INTEGER');
      console.log('Added ts_bucket column to comments table');
    } catch (e) {
      if (!(e instanceof Error && e.message.includes('duplicate column'))) throw e;
      console.log('ts_bucket column already exists in comments table');
    }

    // Add ip_prefix and ts_bucket to issues table (replaces day_bucket)
    try {
      database.exec('ALTER TABLE issues ADD COLUMN ip_prefix TEXT');
      console.log('Added ip_prefix column to issues table');
    } catch (e) {
      if (!(e instanceof Error && e.message.includes('duplicate column'))) throw e;
      console.log('ip_prefix column already exists in issues table');
    }

    try {
      database.exec('ALTER TABLE issues ADD COLUMN ts_bucket INTEGER');
      console.log('Added ts_bucket column to issues table');
    } catch (e) {
      if (!(e instanceof Error && e.message.includes('duplicate column'))) throw e;
      console.log('ts_bucket column already exists in issues table');
    }

    database.exec('COMMIT');
    transactionStarted = false;
    console.log('Rate limit columns migration completed successfully.');
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('Failed to roll back migration:', rollbackError);
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

function migrateRateLimitSettings(): void {
  const database = new DatabaseSync(getLocalDatabasePath());
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;

    // Update settings to new format
    const settings = [
      ['vote_rate_limit', '5/h'],
      ['comment_rate_limit', '3/h'],
      ['proposal_rate_limit', '1/d'],
      ['hero_title', 'Continuous polls · Fully anonymous · Openly auditable'],
      ['hero_subtitle', 'No login required to vote yes/no/neutral on open issues.'],
      ['hero_background_color', ''],
      ['read_only_mode', 'false'],
      ['turnstile_secret_key', ''],
      ['turnstile_enable', 'false']
    ];

    const insert = database.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    for (const [key, value] of settings) {
      insert.run(key, value);
      console.log(`Set ${key} = ${value}`);
    }

    database.exec('COMMIT');
    transactionStarted = false;
    console.log('Rate limit settings migration completed successfully.');
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('Failed to roll back settings migration:', rollbackError);
      }
    }
    throw error;
  } finally {
    database.close();
  }
}

function seedSampleData(): void {
  const database = new DatabaseSync(getLocalDatabasePath());
  let transactionStarted = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionStarted = true;

    const now = Math.floor(Date.now() / 1000);
    const oneDay = 86400;
    const oneWeek = 604800;

    const issueStmt = database.prepare(`
      INSERT INTO issues (title, description, mode, start_at, end_at, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const commentStmt = database.prepare(`
      INSERT INTO comments (issue_id, comment, created_at)
      VALUES (?, ?, ?)
    `);

    const voteStmt = database.prepare(`
      INSERT INTO votes (issue_id, voter_token_hash, ip_prefix_hash, option, ts_bucket, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    // Issue 1: Open deadline poll
    const issue1 = issueStmt.run(
      '应该在工作日实行四天工作制吗？',
      '随着AI技术的发展，许多国家开始探索四天工作制。您认为中国应该在工作日实行四天工作制吗？这将改善工作生活平衡，但可能影响经济产出。',
      IssueMode.Deadline,
      now - oneDay,
      now + oneWeek * 2,
      IssueStatus.Open,
      now - oneDay * 2,
      now - oneDay
    ).lastInsertRowid;

    // Issue 2: Open evergreen poll
    const issue2 = issueStmt.run(
      '您支持取消中高考分流政策吗？',
      '目前的中高考分流政策将约50%的学生分流至职业教育。支持者认为这缓解了高等教育资源压力，反对者认为这过早决定了孩子的人生轨迹。',
      IssueMode.Evergreen,
      now - oneWeek,
      null,
      IssueStatus.Open,
      now - oneWeek * 2,
      now - oneWeek
    ).lastInsertRowid;

    // Issue 3: Closed deadline poll
    const issue3 = issueStmt.run(
      '春节假期是否应该延长至15天？',
      '每年春节假期仅7-8天，许多人认为时间太短无法回家探亲。延长至15天虽有利于家庭团聚，但可能影响生产连续性。',
      IssueMode.Deadline,
      now - oneWeek * 4,
      now - oneWeek * 3,
      IssueStatus.Closed,
      now - oneWeek * 5,
      now - oneWeek * 3
    ).lastInsertRowid;

    // Issue 4: Pending proposal
    const issue4 = issueStmt.run(
      '建议取消所有小区封闭式管理，实行开放社区',
      '封闭式小区管理虽然提高了安全性，但也造成了城市道路资源浪费、公共交通不便、应急通道受阻等问题。建议参考国际经验推行开放社区。',
      IssueMode.Deadline,
      now + oneDay,
      now + oneWeek * 4,
      IssueStatus.Pending,
      now - oneDay,
      now
    ).lastInsertRowid;

    // Issue 5: Another open poll
    const issue5 = issueStmt.run(
      '您认为应该将法定退休年龄延迟到65岁吗？',
      '面对人口老龄化和养老金压力，多国已延迟退休年龄。中国正在逐步实施延迟退休政策，您对延迟至65岁持什么态度？',
      IssueMode.Deadline,
      now - oneDay * 3,
      now + oneWeek * 3,
      IssueStatus.Open,
      now - oneWeek,
      now - oneDay * 3
    ).lastInsertRowid;

    // Add comments for issue 1
    commentStmt.run(issue1, '四天工作制可以提高效率，北欧国家已经证明了这一点', now - 10000);
    commentStmt.run(issue1, '中国国情不同，制造业大国如果减少工作日会严重影响GDP', now - 9000);
    commentStmt.run(issue1, '关键是工资不能降，如果四天工作制工资不变我完全支持', now - 8000);
    commentStmt.run(issue1, '建议先在互联网、金融等高附加值行业试点', now - 7000);

    // Add comments for issue 2
    commentStmt.run(issue2, '分流政策本质是教育资源不均的妥协，应该增加优质高中学位', now - 50000);
    commentStmt.run(issue2, '职业教育本身没有贵贱之分，关键是社会认可度和就业前景', now - 49000);
    commentStmt.run(issue2, '一个考试决定一生太残酷，应该建立多元化升学通道', now - 48000);

    // Add comments for issue 3
    commentStmt.run(issue3, '15天太长了，中小企业根本承受不起', now - 300000);
    commentStmt.run(issue3, '可以分阶段实施，先延长到10天看效果', now - 299000);

    // Add comments for issue 5
    commentStmt.run(issue5, '延迟退休是大势所趋，但要配套完善养老保障体系', now - 20000);
    commentStmt.run(issue5, '体力劳动者怎么干到65岁？建议按工种分类', now - 19000);
    commentStmt.run(issue5, '年轻人就业难，老人不退休更挤占岗位', now - 18000);

    // Add sample votes (using dummy hashes)
    const dummyVoterHash = 'a'.repeat(64);
    const dummyIpHash = 'b'.repeat(64);
    const hourNow = Math.floor(now / 3600) * 3_600_000;

    // Votes for issue 1 (four-day work week)
    for (let i = 0; i < 15; i++) {
      voteStmt.run(issue1, dummyVoterHash + i.toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Approve, hourNow - i, now - i * 100);
    }
    for (let i = 0; i < 8; i++) {
      voteStmt.run(issue1, dummyVoterHash + (i + 100).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Oppose, hourNow - i, now - i * 100);
    }
    for (let i = 0; i < 5; i++) {
      voteStmt.run(issue1, dummyVoterHash + (i + 200).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Neutral, hourNow - i, now - i * 100);
    }

    // Votes for issue 2 (education streaming)
    for (let i = 0; i < 22; i++) {
      voteStmt.run(issue2, dummyVoterHash + (i + 300).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Approve, hourNow - i * 2, now - i * 200);
    }
    for (let i = 0; i < 18; i++) {
      voteStmt.run(issue2, dummyVoterHash + (i + 400).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Oppose, hourNow - i * 2, now - i * 200);
    }
    for (let i = 0; i < 7; i++) {
      voteStmt.run(issue2, dummyVoterHash + (i + 500).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Neutral, hourNow - i * 2, now - i * 200);
    }

    // Votes for issue 3 (Spring Festival - closed)
    for (let i = 0; i < 45; i++) {
      voteStmt.run(issue3, dummyVoterHash + (i + 600).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Approve, hourNow - 1000 - i, now - 604800 - i * 100);
    }
    for (let i = 0; i < 12; i++) {
      voteStmt.run(issue3, dummyVoterHash + (i + 700).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Oppose, hourNow - 1000 - i, now - 604800 - i * 100);
    }
    for (let i = 0; i < 3; i++) {
      voteStmt.run(issue3, dummyVoterHash + (i + 800).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Neutral, hourNow - 1000 - i, now - 604800 - i * 100);
    }

    // Votes for issue 5 (retirement age)
    for (let i = 0; i < 12; i++) {
      voteStmt.run(issue5, dummyVoterHash + (i + 900).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Approve, hourNow - i * 3, now - i * 300);
    }
    for (let i = 0; i < 28; i++) {
      voteStmt.run(issue5, dummyVoterHash + (i + 1000).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Oppose, hourNow - i * 3, now - i * 300);
    }
    for (let i = 0; i < 9; i++) {
      voteStmt.run(issue5, dummyVoterHash + (i + 1100).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Neutral, hourNow - i * 3, now - i * 300);
    }

    // Additional 10 issues
    const issuesData = [
      // Issue 6: Open deadline
      {
        title: '是否应该强制企业公开薪资区间？',
        description: '薪资透明度有助于减少性别和地域薪酬歧视，但企业担心会增加内部管理成本和竞争对手获取人才成本信息。',
        mode: IssueMode.Deadline,
        startAt: now - oneDay * 2,
        endAt: now + oneWeek * 4,
        status: IssueStatus.Open,
        createdAt: now - oneWeek,
        updatedAt: now - oneDay * 2,
        comments: [
          '薪资透明能让求职者更高效匹配岗位',
          '企业内部薪资倒挂问题会暴露，管理层会头疼',
          '建议只公开区间，不公开具体人员薪资',
          '欧美很多州已经立法要求公开薪资范围'
        ],
        votes: { approve: 35, oppose: 12, neutral: 8 }
      },
      // Issue 7: Open evergreen
      {
        title: '您支持取消预售制，推行现房销售吗？',
        description: '预售制让开发商低成本扩张，但也导致烂尾楼风险转嫁给购房者。现房销售虽能规避风险，但可能推高房价并减少供给。',
        mode: IssueMode.Evergreen,
        startAt: now - oneWeek * 2,
        endAt: null,
        status: IssueStatus.Open,
        createdAt: now - oneWeek * 3,
        updatedAt: now - oneWeek * 2,
        comments: [
          '预售制本质是让老百姓给开发商免费融资',
          '现房销售会大幅减少开发商杠杆，短期供给会收缩',
          '可以逐步过渡，先在一二线城市试点'
        ],
        votes: { approve: 42, oppose: 15, neutral: 10 }
      },
      // Issue 8: Closed
      {
        title: '双十一预售制是否应该取消？',
        description: '今年多平台取消预售制，改为现货直售。消费者无需熬夜付尾款，但失去了价格锁定和分期免息优惠。',
        mode: IssueMode.Deadline,
        startAt: now - oneWeek * 3,
        endAt: now - oneWeek * 2,
        status: IssueStatus.Closed,
        createdAt: now - oneWeek * 4,
        updatedAt: now - oneWeek * 2,
        comments: [
          '终于不用算复杂的满减规则了',
          '预售制能让商家备货更精准，减少浪费',
          '直接降价比搞预售复杂规则强多了'
        ],
        votes: { approve: 28, oppose: 9, neutral: 5 }
      },
      // Issue 9: Pending
      {
        title: '建议将法定节假日调休制度改为弹性休假',
        description: '现行调休制度导致连续工作7天以上，引发疲劳驾驶和健康隐患。建议取消调休，改为企业自主安排弹性年假，保障劳动者连续休息权。',
        mode: IssueMode.Deadline,
        startAt: now + oneDay * 3,
        endAt: now + oneWeek * 3,
        status: IssueStatus.Pending,
        createdAt: now - oneDay,
        updatedAt: now,
        comments: [],
        votes: { approve: 0, oppose: 0, neutral: 0 }
      },
      // Issue 10: Open deadline
      {
        title: '是否应该立法规定最高室温不得低于26℃？',
        description: '夏季公共场所空调过低导致能源浪费和"空调病"。日本已立法公共场所制冷温度不低于28℃，中国是否应跟进立法？',
        mode: IssueMode.Deadline,
        startAt: now - oneDay * 5,
        endAt: now + oneWeek * 2,
        status: IssueStatus.Open,
        createdAt: now - oneWeek * 2,
        updatedAt: now - oneDay * 5,
        comments: [
          '商场地铁太冷了，夏天还得带外套',
          '26℃对怕热人群不友好，建议分区域控温',
          '节能是大势所趋，立法倒逼技术升级'
        ],
        votes: { approve: 18, oppose: 22, neutral: 12 }
      },
      // Issue 11: Open evergreen
      {
        title: '您支持建立全国统一的养老保险个人账户制吗？',
        description: '目前养老保险实行统筹账户与个人账户并存，但个人账户空账问题突出。建议建立真实的个人账户制，资金归个人所有、可继承、跨地区流转。',
        mode: IssueMode.Evergreen,
        startAt: now - oneWeek * 3,
        endAt: null,
        status: IssueStatus.Open,
        createdAt: now - oneWeek * 4,
        updatedAt: now - oneWeek * 3,
        comments: [
          '个人账户真实化是养老金制度改革的核心',
          '跨省流转还得靠全国统一信息平台',
          '可继承性能缓解年轻人的缴费抵触心理'
        ],
        votes: { approve: 38, oppose: 8, neutral: 14 }
      },
      // Issue 12: Open deadline
      {
        title: '中小学是否应该全面推行AI辅助教学？',
        description: '大模型技术成熟后，AI可实现因材施教、自动批改、个性化练习。但过度依赖可能弱化师生情感连接和批判性思维培养。',
        mode: IssueMode.Deadline,
        startAt: now - oneDay * 10,
        endAt: now + oneWeek,
        status: IssueStatus.Open,
        createdAt: now - oneWeek * 2,
        updatedAt: now - oneDay * 10,
        comments: [
          'AI批改作文能减轻老师90%负担',
          '教育本质是人对人的影响，AI不能替代老师',
          '建议作为辅助工具，不可替代主课堂教学',
          '贫困地区学校更需要AI优质教学资源下沉'
        ],
        votes: { approve: 25, oppose: 18, neutral: 11 }
      },
      // Issue 13: Closed
      {
        title: '网约车是否应取消"双证"要求？',
        description: '多地放宽网约车办证条件，取消车辆运输证和人员从业证要求。支持者称能增加就业和运力，反对者担忧安全隐患和市场秩序混乱。',
        mode: IssueMode.Deadline,
        startAt: now - oneWeek * 5,
        endAt: now - oneWeek * 4,
        status: IssueStatus.Closed,
        createdAt: now - oneWeek * 6,
        updatedAt: now - oneWeek * 4,
        comments: [
          '放宽准入后司机素质参差不齐，安全堪忧',
          '能让更多灵活就业者入行，缓解就业压力',
          '平台应承担更多安全管理责任'
        ],
        votes: { approve: 15, oppose: 32, neutral: 7 }
      },
      // Issue 14: Open deadline
      {
        title: '是否应立法保护"离职自由"，禁止竞业限制滥用？',
        description: '大厂普遍要求基层员工签竞业协议，违约金高达年薪数倍。司法实践中竞业限制适用范围过宽、补偿金额过低，严重限制劳动者职业选择自由。',
        mode: IssueMode.Deadline,
        startAt: now - oneDay * 7,
        endAt: now + oneWeek * 5,
        status: IssueStatus.Open,
        createdAt: now - oneWeek * 2,
        updatedAt: now - oneDay * 7,
        comments: [
          '基层码农根本接触不到核心机密，签竞业纯粹是霸王条款',
          '竞业补偿应不低于原薪资的50%才合理',
          '建议明确仅针对掌握核心商业秘密的高管和技术骨干'
        ],
        votes: { approve: 45, oppose: 6, neutral: 9 }
      },
      // Issue 15: Open evergreen
      {
        title: '您支持设立"独生子女父母护理假"制度吗？',
        description: '独生子女面临"421"家庭养老压力（4老人、2父母、1自己）。建议立法给予独生子女每年带薪护理假10-15天，缓解家庭养老焦虑。',
        mode: IssueMode.Evergreen,
        startAt: now - oneWeek,
        endAt: null,
        status: IssueStatus.Open,
        createdAt: now - oneWeek * 2,
        updatedAt: now - oneWeek,
        comments: [
          '独生子女压力确实大，国家应该给政策倾斜',
          '企业负担会加重，建议由社保基金统筹支付',
          '护理假要防止被挪作他用，需实名认证'
        ],
        votes: { approve: 31, oppose: 11, neutral: 13 }
      }
    ];

    let voteOffset = 1200;
    for (const issueData of issuesData) {
      const issueId = issueStmt.run(
        issueData.title,
        issueData.description,
        issueData.mode,
        issueData.startAt,
        issueData.endAt,
        issueData.status,
        issueData.createdAt,
        issueData.updatedAt
      ).lastInsertRowid;

      // Add comments
      for (const comment of issueData.comments) {
        commentStmt.run(issueId, comment, now - Math.floor(Math.random() * 100000) - 1000);
      }

      // Add votes
      const { approve, oppose, neutral } = issueData.votes;
      for (let i = 0; i < approve; i++) {
        voteStmt.run(issueId, dummyVoterHash + (voteOffset++).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Approve, hourNow - Math.floor(Math.random() * 2000), now - Math.floor(Math.random() * 50000));
      }
      for (let i = 0; i < oppose; i++) {
        voteStmt.run(issueId, dummyVoterHash + (voteOffset++).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Oppose, hourNow - Math.floor(Math.random() * 2000), now - Math.floor(Math.random() * 50000));
      }
      for (let i = 0; i < neutral; i++) {
        voteStmt.run(issueId, dummyVoterHash + (voteOffset++).toString(16).padStart(16, '0'), dummyIpHash, VoteOption.Neutral, hourNow - Math.floor(Math.random() * 2000), now - Math.floor(Math.random() * 50000));
      }
    }

    database.exec('COMMIT');
    transactionStarted = false;
    console.log('Sample data seeded successfully (5 issues, comments, and votes in Chinese).');
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec('ROLLBACK');
      } catch (rollbackError) {
        console.error('Failed to roll back sample data seeding:', rollbackError);
      }
    }
    throw error;
  } finally {
    database.close();
  }
}
    case 'seed-sample-data':
      seedSampleData();
      break;
    case 'list-pending':
      listPending();
      break;
    case 'migrate-rate-limit-columns':
      migrateRateLimitColumns();
      break;
    case 'migrate-rate-limit-settings':
      migrateRateLimitSettings();
      break;
    case 'help':
      showHelp();
      break;
    default:
      showHelp();
      throw new Error(`Unknown command: ${command}`);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
