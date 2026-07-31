#!/usr/bin/env node
/**
 * 釋放開發用連接埠（預設 3000 前端、4000 後端）。
 *
 * 為什麼需要這支腳本：
 *   在 Windows 上對 `pnpm dev` 按 Ctrl+C 時，pnpm → nest → node 的孫行程
 *   常常不會跟著結束。舊的後端會繼續佔用 4000，新啟動的後端搶不到埠而失敗，
 *   於是「明明改了程式碼、也重啟了，行為卻完全沒變」。
 *   這種狀況很難從症狀反推原因，因此提供一支明確的指令來處理。
 *
 * 用法：
 *   node scripts/free-ports.mjs           # 只列出佔用者，不終止
 *   node scripts/free-ports.mjs --kill    # 終止佔用這些埠的行程
 *   node scripts/free-ports.mjs --kill 4000 4101
 */

import { execSync } from 'node:child_process';

const args = process.argv.slice(2);
const KILL = args.includes('--kill');
const ports = args.filter((a) => /^\d+$/.test(a)).map(Number);
const TARGET_PORTS = ports.length > 0 ? ports : [3000, 4000];

const isWindows = process.platform === 'win32';

/** 找出監聽指定埠的行程 ID。 */
function findPids(port) {
  try {
    if (isWindows) {
      const out = execSync(`netstat -ano -p tcp | findstr LISTENING | findstr :${port}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const pids = new Set();
      for (const line of out.split(/\r?\n/)) {
        // 只採用「本機位址」剛好是這個埠的列，避免比對到 :40001 之類
        const match = line.trim().match(/^TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
        if (match && Number(match[1]) === port) pids.add(Number(match[2]));
      }
      return [...pids];
    }

    const out = execSync(`lsof -ti tcp:${port} -s tcp:LISTEN`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split(/\s+/).filter(Boolean).map(Number);
  } catch {
    // 沒有任何符合的行程時，netstat/findstr 與 lsof 都會以非 0 結束。
    return [];
  }
}

function describe(pid) {
  try {
    if (isWindows) {
      // 以固定格式輸出，避免系統地區設定造成的編碼亂碼。
      const out = execSync(
        `powershell -NoProfile -Command "(Get-Process -Id ${pid}).StartTime.ToString('yyyy-MM-dd HH:mm:ss')"`,
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      return out ? `啟動於 ${out}` : '';
    }
    return execSync(`ps -o lstart= -p ${pid}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

let found = 0;
let killed = 0;

for (const port of TARGET_PORTS) {
  const pids = findPids(port);
  if (pids.length === 0) {
    console.log(`[ports] ${port} 未被佔用`);
    continue;
  }

  for (const pid of pids) {
    found += 1;
    const info = describe(pid);
    console.log(`[ports] ${port} 被 PID ${pid} 佔用${info ? `（${info}）` : ''}`);

    if (!KILL) continue;

    try {
      if (isWindows) execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
      killed += 1;
      console.log(`[ports]   → 已終止 PID ${pid}`);
    } catch (error) {
      console.log(`[ports]   → 終止失敗：${error.message}`);
    }
  }
}

if (found === 0) {
  console.log('\n[ports] 所有目標連接埠都是空的，可以直接啟動 pnpm dev。');
} else if (!KILL) {
  console.log('\n[ports] 這是檢視模式。要終止請執行：node scripts/free-ports.mjs --kill');
} else {
  console.log(`\n[ports] 已終止 ${killed} 個行程，現在可以重新執行 pnpm dev。`);
}
