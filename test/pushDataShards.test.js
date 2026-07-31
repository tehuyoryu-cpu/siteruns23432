'use strict';

/**
 * test/pushDataShards.test.js
 *
 * scripts/push-data-shards.js の _fetchWithRetry() 回帰テスト。
 *
 * 経緯: 429/5xx でリトライする分岐だけ `lastErr = new Error('HTTP ' + res.status)`
 * と本文を読まずに組み立てており、全リトライを使い切って最終的にthrowされる
 * 例外にはGitHub APIが返した詳細（バリデーションエラー内容やレート制限情報等）
 * が一切残らなかった（即時失敗の4xx経路は本文を含めていたため非対称だった）。
 * この回帰を検知するため、globalThis.fetch をモックして直接検証する。
 *
 * 実行: node test/pushDataShards.test.js
 */

const assert = require('assert');
const path   = require('path');

let pass = 0, fail = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    pass++;
  } catch (e) {
    fail++;
    failures.push({ name, error: e });
  }
}

(async () => {
  const { _fetchWithRetry } = require(path.join(__dirname, '..', 'scripts', 'push-data-shards'));
  const realFetch = global.fetch;

  await test('全リトライを使い切った場合、最終エラーにレスポンス本文が含まれる', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      return {
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ message: 'Service Unavailable (test-injected)' }),
      };
    };
    try {
      await assert.rejects(
        () => _fetchWithRetry('https://api.github.com/fake', {}),
        (err) => {
          assert.ok(err.message.includes('HTTP 503'), `message should include status: ${err.message}`);
          assert.ok(err.message.includes('Service Unavailable (test-injected)'),
            `message should include response body, got: ${err.message}`);
          return true;
        }
      );
      assert.ok(calls >= 2, 'should have retried at least once before giving up');
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('本文読み取り自体が失敗してもクラッシュせず次のリトライに進む', async () => {
    let calls = 0;
    global.fetch = async () => {
      calls++;
      if (calls === 1) {
        return {
          ok: false,
          status: 500,
          text: async () => { throw new Error('body already consumed (test-injected)'); },
        };
      }
      return { ok: true, status: 200, text: async () => '{}' };
    };
    try {
      const res = await _fetchWithRetry('https://api.github.com/fake2', {});
      assert.strictEqual(res.ok, true);
      assert.strictEqual(calls, 2, 'should have retried exactly once then succeeded');
    } finally {
      global.fetch = realFetch;
    }
  });

  await test('成功レスポンスはそのまま返る（リトライ不要）', async () => {
    global.fetch = async () => ({ ok: true, status: 200, text: async () => '{}' });
    try {
      const res = await _fetchWithRetry('https://api.github.com/fake3', {});
      assert.strictEqual(res.ok, true);
    } finally {
      global.fetch = realFetch;
    }
  });

  console.log(`\n[pushDataShards.test.js] ${pass} passed, ${fail} failed`);
  if (failures.length) {
    for (const { name, error } of failures) {
      console.error(`\n✗ ${name}`);
      console.error('  ' + (error?.stack ?? error?.message ?? error));
    }
    process.exitCode = 1;
  } else {
    console.log('全テスト成功');
  }
})();
