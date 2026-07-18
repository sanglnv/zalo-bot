'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

require.extensions['.gs'] = require.extensions['.js'];

function makeRuntime() {
  const rows = [];
  const sheet = {
    getLastRow: () => rows.length,
    getLastColumn: () => rows.length ? rows[0].length : 0,
    appendRow(row) { rows.push([...row]); },
    getRange(row, column, rowCount, columnCount) {
      return {
        getValues() {
          return rows.slice(row - 1, row - 1 + rowCount)
            .map((source) => source.slice(column - 1, column - 1 + columnCount));
        },
        setValues(values) {
          values.forEach((value, offset) => { rows[row - 1 + offset] = [...value]; });
        }
      };
    }
  };
  const book = { getSheetByName: () => rows.length ? sheet : null, insertSheet: () => sheet };
  global.PropertiesService = {
    getScriptProperties: () => ({ getProperty: (name) => name === 'SPREADSHEET_ID' ? 'sheet-id' : null })
  };
  global.SpreadsheetApp = { openById: () => book };
  global.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  return { rows };
}

function loadRepository() {
  delete require.cache[require.resolve('../repositories/SheetRepositorySupport.gs')];
  delete require.cache[require.resolve('../repositories/SheetCustomerRepository.gs')];
  global.SheetRepositorySupport = require('../repositories/SheetRepositorySupport.gs');
  return require('../repositories/SheetCustomerRepository.gs');
}

test('save() persists memberId alongside the existing columns, and header row includes it', () => {
  const runtime = makeRuntime();
  const repo = loadRepository()();
  repo.save({
    customerId: 'c1', phone: '0901234567', displayName: 'Sang',
    platformLinks: [{ platform: 'telegram', platformUserId: 'chat-1' }],
    memberId: 'M1'
  });
  assert.deepEqual(runtime.rows[0], ['customerId', 'phone', 'displayName', 'platformLinksJson', 'memberId']);
  assert.equal(runtime.rows[1][4], 'M1');
});

test('findById/findByPlatformUserId round-trip memberId, defaulting to null when absent', () => {
  const repo = loadRepository()();
  repo.save({
    customerId: 'c1', phone: null, displayName: '',
    platformLinks: [{ platform: 'telegram', platformUserId: 'chat-1' }],
    memberId: null
  });
  assert.equal(repo.findById('c1').memberId, null);

  repo.save({
    customerId: 'c2', phone: '0909', displayName: 'B',
    platformLinks: [{ platform: 'zalo', platformUserId: 'zalo-2' }],
    memberId: 'M2'
  });
  assert.equal(repo.findById('c2').memberId, 'M2');
  assert.equal(repo.findByPlatformUserId('zalo', 'zalo-2').memberId, 'M2');
});

test('save() updates an existing row (including memberId) in place instead of appending a duplicate', () => {
  const runtime = makeRuntime();
  const repo = loadRepository()();
  repo.save({
    customerId: 'c1', phone: null, displayName: 'Sang',
    platformLinks: [{ platform: 'telegram', platformUserId: 'chat-1' }],
    memberId: null
  });
  repo.save({
    customerId: 'c1', phone: '0901234567', displayName: 'Sang',
    platformLinks: [{ platform: 'telegram', platformUserId: 'chat-1' }],
    memberId: 'M1'
  });
  assert.equal(runtime.rows.length, 2, 'header + one data row, no duplicate');
  assert.equal(repo.findById('c1').memberId, 'M1');
  assert.equal(repo.findById('c1').phone, '0901234567');
});

function loadMemberRepository(client) {
  global.BotOrderWebhookClient = client;
  delete require.cache[require.resolve('../repositories/MemberRepository.gs')];
  return require('../repositories/MemberRepository.gs');
}

test('MemberRepository.resolve() returns null without calling the POS when there is no phone', () => {
  let called = false;
  const repo = loadMemberRepository({
    listMembers: () => { called = true; return []; },
    createMember: () => { called = true; return { memberId: 'unused' }; }
  })();
  assert.equal(repo.resolve({ name: 'Sang', phone: null }), null);
  assert.equal(repo.resolve(null), null);
  assert.equal(called, false);
});

test('MemberRepository.resolve() finds an existing member by exact phone match instead of creating a new one', () => {
  const createCalls = [];
  const repo = loadMemberRepository({
    listMembers(query) {
      assert.equal(query, '0901234567');
      return [
        { memberId: 'M-other', phone: '0909999999' },
        { memberId: 'M1', phone: '0901234567' }
      ];
    },
    createMember(member) { createCalls.push(member); return { memberId: 'should-not-be-used' }; }
  })();
  assert.deepEqual(repo.resolve({ name: 'Sang', phone: '0901234567' }), { memberId: 'M1' });
  assert.equal(createCalls.length, 0);
});

test('MemberRepository.resolve() creates a new member when no existing phone match is found', () => {
  const createCalls = [];
  const repo = loadMemberRepository({
    listMembers: () => [{ memberId: 'M-other', phone: '0909999999' }],
    createMember(member) { createCalls.push(member); return { memberId: 'M-new' }; }
  })();
  assert.deepEqual(repo.resolve({ name: 'Sang', phone: '0901234567' }), { memberId: 'M-new' });
  assert.deepEqual(createCalls, [{ name: 'Sang', phone: '0901234567' }]);
});
