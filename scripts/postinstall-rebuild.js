'use strict';

/**
 * scripts/postinstall-rebuild.js
 *
 * better-sqlite3 は従来型のネイティブアドオン(N-APIではない)のため、
 * NODE_MODULE_VERSION(ABI)がビルド時のNode.jsと完全に一致しないと動かない。
 * `npm install` は素の(システム)Node向けにビルドしてしまうため、そのままでは
 * Electron(別のABI)向けの `npm start` が起動直後にクラッシュする。
 *
 * `electron-builder install-app-deps` はこの用途向けの公式コマンドで、
 * ネイティブモジュールをElectronのABI向けに再ビルドしてくれる。
 * これを postinstall で自動実行する。
 *
 * ただし、再ビルドには Visual Studio Build Tools + Python 等のネイティブ
 * ビルド環境が必要で、開発機に入っていない場合がある。GitHub Actions
 * (windows-latest)には標準搭載されているため問題ないが、ローカル開発機では
 * 保証できない。そのため、失敗しても `npm install` 自体は失敗させず
 * (exit code 0 を返す)、警告メッセージだけ出して案内する。
 * 失敗したまま `npm start` すると NODE_MODULE_VERSION 不一致でクラッシュ
 * するため、その場合は上記ツールを導入した上で
 * `npx electron-builder install-app-deps` を手動実行する必要がある。
 *
 * 他ジョブへの影響:
 *   `node main.js --mode=status/discover/fetch` 等のCLIモードは素のNode上で
 *   動くため、この再ビルドの成否に関わらず動作する
 *   (npm install がビルドしたABIとそのまま一致するため)。
 */

const { spawnSync } = require('child_process');

const result = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['electron-builder', 'install-app-deps'],
  { stdio: 'inherit' }
);

if (result.error || result.status !== 0) {
  console.warn('\n[postinstall] electron-builder install-app-deps に失敗しました。');
  console.warn('[postinstall] 「node main.js --mode=...」等のCLIモードは影響を受けませんが、');
  console.warn('[postinstall] 「npm start」(Electronアプリ) は NODE_MODULE_VERSION 不一致で');
  console.warn('[postinstall] クラッシュする可能性があります。');
  console.warn('[postinstall] Visual Studio Build Tools + Python を導入した上で、以下を手動実行してください:');
  console.warn('[postinstall]   npx electron-builder install-app-deps\n');
}

// ビルドツール不足等でここが失敗しても npm install 自体は失敗させない
process.exit(0);
