const { app, BrowserWindow, ipcMain } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');
const pty = require('@homebridge/node-pty-prebuilt-multiarch');

// Debug file logging is off by default. Enable it by launching with the
// environment variable USAGEAI_DEBUG=1 (also accepts true/on/yes).
const DEBUG_LOG = /^(1|true|on|yes)$/i.test(process.env.USAGEAI_DEBUG || '');

let currentUsageRequest = null;

function stripTerminalSequences(value) {
  return value
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, '')
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/\r/g, '\n');
}

function formatDuration(totalMinutes) {
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}日${hours}時間`;
  if (hours > 0) return `${hours}時間${minutes}分`;
  return `${Math.max(minutes, 1)}分`;
}

function remainingUntil(resetText) {
  const now = new Date();
  const text = resetText.replace(/\s*\(.*?\)/, '').trim();
  const time = text.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  const dated = text.match(/^([A-Z][a-z]{2})\s+(\d{1,2}),\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  let target;

  if (time) {
    let hour = Number(time[1]);
    if (time[3].toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (time[3].toLowerCase() === 'am' && hour === 12) hour = 0;
    target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, Number(time[2] || 0));
    if (target <= now) target.setDate(target.getDate() + 1);
  } else if (dated) {
    const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    let hour = Number(dated[3]);
    if (dated[5].toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (dated[5].toLowerCase() === 'am' && hour === 12) hour = 0;
    target = new Date(now.getFullYear(), months[dated[1]], Number(dated[2]), hour, Number(dated[4] || 0));
    if (target <= now) target.setFullYear(target.getFullYear() + 1);
  }

  return target && !Number.isNaN(target.getTime())
    ? formatDuration(Math.ceil((target - now) / 60000))
    : null;
}

function parseUsageBlock(text, heading) {
  const start = text.search(heading);
  if (start < 0) return null;
  const block = text.slice(start, start + 350);
  // Capture an optional fractional part (screen-reader text may report e.g. "49.4%").
  const usage = block.match(/(\d{1,3}(?:\.\d+)?)%\s*(?:\d{1,3}(?:\.\d+)?%\s*)?(?:used|使用済み)/i);
  const reset = block.match(/(?:Resets|リセット)\s+([^\n]+)/i);
  if (!usage || !reset) return null;
  const resetAt = reset[1].trim();
  // Round to one decimal place (round on the 2nd decimal), then cap at 100.
  const percent = Math.min(100, Math.round(Number(usage[1]) * 10) / 10);
  return { percent, resetAt, remaining: remainingUntil(resetAt) };
}

function parseClaudeUsage(rawOutput) {
  const text = stripTerminalSequences(rawOutput);
  const session = parseUsageBlock(text, /Current session|現在のセッション/i);
  const weekly = parseUsageBlock(text, /Current week \(all models\)|現在の週/i);
  if (!session || !weekly) {
    throw new Error('Claude CLI の使用状況を読み取れませんでした。Claude Codeを最新にしてから、もう一度更新してください。');
  }
  const plan = text.match(/Claude\s+(Pro|Max|Free|Team|Enterprise)/i)?.[1] || 'Connected';
  return { session, weekly, plan };
}

function fetchClaudeUsage() {
  if (currentUsageRequest) return currentUsageRequest;

  currentUsageRequest = new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const logPath = path.join(app.getPath('userData'), 'claude-usage-debug.log');
    const log = (msg) => {
      if (!DEBUG_LOG) return;
      const line = `[+${String(Date.now() - startedAt).padStart(5, ' ')}ms] ${msg}\n`;
      try { fs.appendFileSync(logPath, line); } catch { /* ignore log errors */ }
    };
    if (DEBUG_LOG) {
      try { fs.writeFileSync(logPath, `===== claude:usage run @ ${new Date().toISOString()} =====\n`); } catch { /* ignore */ }
    }

    let output = '';
    let sendScheduled = false;
    let trustAnswered = false;
    let sendAttempts = 0;
    let completeTimer;
    let timeoutTimer;
    let retryTimer;
    let terminal;
    let finished = false;

    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(completeTimer);
      clearTimeout(timeoutTimer);
      clearTimeout(retryTimer);
      try { terminal?.kill(); } catch { /* terminal already closed */ }
      if (error) {
        log(`FINISH with error: ${error.message}`);
        reject(error);
      } else {
        try {
          const result = parseClaudeUsage(output);
          log(`FINISH ok: session=${result.session.percent}% weekly=${result.weekly.percent}% plan=${result.plan}`);
          log(`RAW OUTPUT:\n${stripTerminalSequences(output)}`);
          resolve(result);
        } catch (parseError) {
          log(`FINISH parse failed: ${parseError.message}`);
          log(`RAW OUTPUT:\n${stripTerminalSequences(output)}`);
          reject(parseError);
        }
      }
    };

    // Sends /usage, retrying until the usage panel appears. Guards against the
    // keystroke being lost when the REPL is not ready yet (the previous
    // one-shot send was the likely cause of the timeout).
    const trySend = () => {
      if (finished) return;
      const readable = stripTerminalSequences(output);
      if (/Current session|現在のセッション/i.test(readable)) {
        log('usage panel detected, stop sending');
        return;
      }
      sendAttempts += 1;
      log(`sending /usage (attempt ${sendAttempts})`);
      try { terminal.write('/usage\r\n'); } catch { /* terminal gone */ }
      if (sendAttempts < 5) retryTimer = setTimeout(trySend, 2500);
    };

    const scheduleSend = (via) => {
      if (sendScheduled || finished) return;
      sendScheduled = true;
      log(`REPL ready (${via}), scheduling first /usage`);
      setTimeout(trySend, 500);
    };

    try {
      // Run claude in a dedicated empty folder so it has nothing to touch and
      // the workspace-trust state is deterministic (prompted once, then remembered).
      const workspaceDir = path.join(app.getPath('userData'), 'claude-workspace');
      try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch { /* already exists */ }

      log(`spawn: claude --ax-screen-reader (cwd=${workspaceDir})`);
      terminal = pty.spawn('cmd.exe', ['/d', '/s', '/c', 'claude --ax-screen-reader'], {
        name: 'xterm-256color', cols: 120, rows: 42, cwd: workspaceDir, env: process.env
      });
      terminal.onData((data) => {
        output += data;
        const readable = stripTerminalSequences(output);

        // claude blocks on a workspace-trust prompt before the REPL starts.
        // Auto-confirm it once (y + Enter), then start sending /usage.
        if (!trustAnswered && /trust this folder|Please answer y or n|Enter y\/n|Do you trust|Permission Required: Accessing workspace/i.test(readable)) {
          trustAnswered = true;
          log('workspace-trust prompt detected -> answering y');
          try { terminal.write('y\r'); } catch { /* terminal gone */ }
          setTimeout(() => scheduleSend('post-trust'), 1500);
          return;
        }

        if (parseUsageBlock(readable, /Current week \(all models\)|現在の週/i)) {
          clearTimeout(retryTimer);
          completeTimer ||= setTimeout(() => finish(), 600);
        }
      });
      terminal.onExit(({ exitCode }) => {
        log(`pty exit code=${exitCode} outputLen=${output.length}`);
        if (!finished && output.length < 100) finish(new Error(`Claude CLI が終了しました（コード ${exitCode}）。ログイン状態を確認してください。`));
      });
      // If no trust prompt shows up (folder already trusted), the REPL is ready.
      // Give trust detection priority: the prompt appears ~3.5s after launch.
      setTimeout(() => { if (!trustAnswered) scheduleSend('no-trust'); }, 5000);
      // Absolute fallback in case detection misses entirely.
      setTimeout(() => scheduleSend('9s-fallback'), 9000);
      timeoutTimer = setTimeout(() => {
        log(`TIMEOUT. sendAttempts=${sendAttempts} trustAnswered=${trustAnswered}`);
        log(`RAW OUTPUT:\n${stripTerminalSequences(output)}`);
        finish(new Error('Claude CLI からの応答がタイムアウトしました。'));
      }, 25000);
    } catch (error) {
      finish(new Error(`Claude CLI を起動できませんでした: ${error.message}`));
    }
  }).finally(() => { currentUsageRequest = null; });

  return currentUsageRequest;
}

let currentCodexRequest = null;

// The Codex binary lives under %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe.
// The <hash> segment changes on update, so resolve the newest one dynamically.
function resolveCodexExe() {
  const base = path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin');
  try {
    const candidates = fs.readdirSync(base)
      .map((d) => path.join(base, d, 'codex.exe'))
      .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
    if (candidates.length) {
      candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      return candidates[0];
    }
  } catch { /* base missing */ }
  return null;
}

function codexRemaining(resetText) {
  // Examples: "23:48 on 22 Aug", "14:23", "22 Aug".
  const now = new Date();
  const t = resetText.match(/(\d{1,2}):(\d{2})/);
  const dm = resetText.match(/(\d{1,2})\s+([A-Z][a-z]{2})/);
  const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
  const target = new Date(now);
  if (dm && months[dm[2]] !== undefined) target.setMonth(months[dm[2]], Number(dm[1]));
  if (t) target.setHours(Number(t[1]), Number(t[2]), 0, 0);
  else target.setHours(0, 0, 0, 0);
  if (!dm && t && target <= now) target.setDate(target.getDate() + 1);
  if (dm && target < now) target.setFullYear(target.getFullYear() + 1);
  const mins = Math.ceil((target - now) / 60000);
  return mins > 0 ? formatDuration(mins) : null;
}

function parseCodexUsage(rawOutput) {
  const text = stripTerminalSequences(rawOutput);
  const plan = text.match(/Account:\s*\S+\s*\(([^)]+)\)/i)?.[1]?.trim() || 'Connected';
  const limits = [];
  // Each limit renders as: "<Label> limit: [bar] N% left (resets <when>)".
  const re = /([A-Za-z][A-Za-z0-9 -]*?)\s+limit:\s*(?:\[[^\]]*\]\s*)?(\d{1,3}(?:\.\d+)?)\s*%\s*left\s*\(resets\s+([^)]+)\)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const label = m[1].trim();
    const left = Number(m[2]);
    const percent = Math.min(100, Math.round((100 - left) * 10) / 10);
    const resetAt = m[3].trim();
    limits.push({ label, percent, resetAt, remaining: codexRemaining(resetAt) });
  }
  if (!limits.length) {
    throw new Error('Codex CLI の使用状況を読み取れませんでした（/status の出力形式が想定と異なります）。');
  }
  return { plan, limits };
}

function fetchCodexUsage() {
  if (currentCodexRequest) return currentCodexRequest;

  currentCodexRequest = new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const logPath = path.join(app.getPath('userData'), 'codex-usage-debug.log');
    const log = (msg) => {
      if (!DEBUG_LOG) return;
      try { fs.appendFileSync(logPath, `[+${String(Date.now() - startedAt).padStart(5, ' ')}ms] ${msg}\n`); } catch { /* ignore */ }
    };
    if (DEBUG_LOG) {
      try { fs.writeFileSync(logPath, `===== codex:usage run @ ${new Date().toISOString()} =====\n`); } catch { /* ignore */ }
    }

    let output = '';
    let trustAnswered = false;
    let sendScheduled = false;
    let sendAttempts = 0;
    let completeTimer;
    let timeoutTimer;
    let retryTimer;
    let terminal;
    let finished = false;

    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(completeTimer);
      clearTimeout(timeoutTimer);
      clearTimeout(retryTimer);
      try { terminal?.kill(); } catch { /* already closed */ }
      if (error) {
        log(`FINISH with error: ${error.message}`);
        reject(error);
      } else {
        try {
          const result = parseCodexUsage(output);
          log(`FINISH ok: plan=${result.plan} limits=${result.limits.map((l) => `${l.label}:${l.percent}%`).join(', ')}`);
          log(`RAW OUTPUT:\n${stripTerminalSequences(output)}`);
          resolve(result);
        } catch (parseError) {
          log(`FINISH parse failed: ${parseError.message}`);
          log(`RAW OUTPUT:\n${stripTerminalSequences(output)}`);
          reject(parseError);
        }
      }
    };

    const trySend = () => {
      if (finished) return;
      const readable = stripTerminalSequences(output);
      if (/%\s*left\s*\(resets/i.test(readable)) { log('status already visible, stop sending'); return; }
      sendAttempts += 1;
      log(`sending /status (attempt ${sendAttempts})`);
      try { terminal.write('/status\r'); } catch { /* gone */ }
      if (sendAttempts < 5) retryTimer = setTimeout(trySend, 3500);
    };
    const scheduleSend = (via) => {
      if (sendScheduled || finished) return;
      sendScheduled = true;
      log(`scheduling /status (${via})`);
      setTimeout(trySend, 1500);
    };

    const codexExe = resolveCodexExe();
    if (!codexExe) {
      finish(new Error('Codex CLI が見つかりません（%LOCALAPPDATA%\\OpenAI\\Codex 未検出）。'));
      return;
    }

    try {
      const workspaceDir = path.join(app.getPath('userData'), 'codex-workspace');
      try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch { /* exists */ }
      log(`spawn: ${codexExe} (cwd=${workspaceDir})`);
      // Keep output in the normal terminal buffer. This makes the /status text
      // available to the parser even when Codex redraws its TUI during startup.
      terminal = pty.spawn(codexExe, ['--no-alt-screen'], {
        name: 'xterm-256color', cols: 120, rows: 42, cwd: workspaceDir, env: process.env
      });
      terminal.onData((data) => {
        output += data;
        const readable = stripTerminalSequences(output);
        // Directory-trust prompt is a numbered menu; option 1 is the default -> Enter.
        if (!trustAnswered && /Do you trust|Press enter to continue|Yes, continue/i.test(readable)) {
          trustAnswered = true;
          log('trust prompt detected -> Enter');
          try { terminal.write('\r'); } catch { /* gone */ }
          setTimeout(() => scheduleSend('post-trust'), 3000);
          return;
        }
        // Once the main TUI banner is up, the REPL can accept /status.
        if (/OpenAI Codex \(v/i.test(readable)) scheduleSend('banner');
        if (/%\s*left\s*\(resets/i.test(readable)) {
          clearTimeout(retryTimer);
          completeTimer ||= setTimeout(() => finish(), 800);
        }
      });
      terminal.onExit(({ exitCode }) => {
        log(`pty exit code=${exitCode} outputLen=${output.length}`);
        if (!finished && output.length < 100) finish(new Error(`Codex CLI が終了しました（コード ${exitCode}）。ログイン状態を確認してください。`));
      });
      // Fallbacks in case detection misses.
      setTimeout(() => scheduleSend('12s-fallback'), 12000);
      timeoutTimer = setTimeout(() => {
        log(`TIMEOUT. sendAttempts=${sendAttempts} trustAnswered=${trustAnswered}`);
        log(`RAW OUTPUT:\n${stripTerminalSequences(output)}`);
        finish(new Error('Codex CLI からの応答がタイムアウトしました。'));
      // Codex may initialize configured MCP servers before accepting slash
      // commands, so its first status read can take noticeably longer than the
      // other CLIs.
      }, 60000);
    } catch (error) {
      finish(new Error(`Codex CLI を起動できませんでした: ${error.message}`));
    }
  }).finally(() => { currentCodexRequest = null; });

  return currentCodexRequest;
}

let currentKiroRequest = null;

function resolveKiroExe() {
  const p = path.join(process.env.LOCALAPPDATA || '', 'Kiro-Cli', 'kiro-cli.exe');
  try { if (fs.statSync(p).isFile()) return p; } catch { /* not found */ }
  return null;
}

function kiroRemaining(dateStr) {
  if (!dateStr) return null;
  const target = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  const mins = Math.ceil((target - new Date()) / 60000);
  return mins > 0 ? formatDuration(mins) : null;
}

function parseKiroUsage(rawOutput) {
  const text = stripTerminalSequences(rawOutput);
  const plan = text.match(/resets on\s*\d{4}-\d{2}-\d{2}\s*\|\s*([A-Za-z][A-Za-z ]+)/i)?.[1]?.trim()
    || text.match(/Plan:\s*([A-Za-z][A-Za-z ]+?)\s*\(/i)?.[1]?.trim()
    || 'Connected';
  const resetAt = text.match(/resets on\s*(\d{4}-\d{2}-\d{2})/i)?.[1] || null;
  // e.g. "Credits (404.28 of 1000 covered in plan)" / "Agentic requests (50 of 100 covered in plan)".
  const m = text.match(/(Credits|Agentic requests)\s*\(\s*([\d.]+)\s*of\s*([\d.]+)\s*covered in plan\)/i);
  if (!m) {
    throw new Error('Kiro CLI の使用状況を読み取れませんでした（/usage の出力形式が想定と異なります）。');
  }
  const used = Number(m[2]);
  const limit = Number(m[3]);
  const percent = Math.min(100, Math.round((used / limit) * 1000) / 10);
  return { plan, resource: m[1], used, limit, percent, resetAt, remaining: kiroRemaining(resetAt) };
}

function fetchKiroUsage() {
  if (currentKiroRequest) return currentKiroRequest;

  currentKiroRequest = new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const logPath = path.join(app.getPath('userData'), 'kiro-usage-debug.log');
    const log = (msg) => {
      if (!DEBUG_LOG) return;
      try { fs.appendFileSync(logPath, `[+${String(Date.now() - startedAt).padStart(5, ' ')}ms] ${msg}\n`); } catch { /* ignore */ }
    };
    if (DEBUG_LOG) {
      try { fs.writeFileSync(logPath, `===== kiro:usage run @ ${new Date().toISOString()} =====\n`); } catch { /* ignore */ }
    }

    let output = '';
    let trustAnswered = false;
    let sendScheduled = false;
    let sendAttempts = 0;
    let completeTimer;
    let timeoutTimer;
    let retryTimer;
    let terminal;
    let finished = false;

    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(completeTimer);
      clearTimeout(timeoutTimer);
      clearTimeout(retryTimer);
      try { terminal?.kill(); } catch { /* already closed */ }
      if (error) {
        log(`FINISH with error: ${error.message}`);
        reject(error);
      } else {
        try {
          const result = parseKiroUsage(output);
          log(`FINISH ok: plan=${result.plan} ${result.resource}=${result.percent}% (${result.used}/${result.limit})`);
          log(`RAW OUTPUT:\n${stripTerminalSequences(output)}`);
          resolve(result);
        } catch (parseError) {
          log(`FINISH parse failed: ${parseError.message}`);
          log(`RAW OUTPUT:\n${stripTerminalSequences(output)}`);
          reject(parseError);
        }
      }
    };

    const trySend = () => {
      if (finished) return;
      if (/covered in plan/i.test(stripTerminalSequences(output))) { log('usage already visible, stop sending'); return; }
      sendAttempts += 1;
      log(`sending /usage (attempt ${sendAttempts})`);
      try { terminal.write('/usage\r'); } catch { /* gone */ }
      if (sendAttempts < 5) retryTimer = setTimeout(trySend, 3500);
    };
    const scheduleSend = (via) => {
      if (sendScheduled || finished) return;
      sendScheduled = true;
      log(`scheduling /usage (${via})`);
      setTimeout(trySend, 800);
    };

    const kiroExe = resolveKiroExe();
    if (!kiroExe) {
      finish(new Error('Kiro CLI が見つかりません（%LOCALAPPDATA%\\Kiro-Cli\\kiro-cli.exe 未検出）。'));
      return;
    }

    try {
      const workspaceDir = path.join(app.getPath('userData'), 'kiro-workspace');
      try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch { /* exists */ }
      log(`spawn: ${kiroExe} chat --legacy-ui (cwd=${workspaceDir})`);
      // Legacy UI renders /usage as plain sequential text and starts without the
      // heavy MCP init of the new TUI; --trust-tools= grants no tools (read-only).
      terminal = pty.spawn(kiroExe, ['chat', '--legacy-ui', '--trust-tools='], {
        name: 'xterm-256color', cols: 120, rows: 42, cwd: workspaceDir, env: process.env
      });
      terminal.onData((data) => {
        output += data;
        const readable = stripTerminalSequences(output);
        if (!trustAnswered && /Do you trust|Press enter to continue|Yes, continue|trust the files/i.test(readable)) {
          trustAnswered = true;
          log('trust prompt detected -> Enter');
          try { terminal.write('\r'); } catch { /* gone */ }
          setTimeout(() => scheduleSend('post-trust'), 1500);
          return;
        }
        if (/What should we work on|happy coding|Plan:\s/i.test(readable)) scheduleSend('banner');
        if (/covered in plan/i.test(readable)) {
          clearTimeout(retryTimer);
          completeTimer ||= setTimeout(() => finish(), 700);
        }
      });
      terminal.onExit(({ exitCode }) => {
        log(`pty exit code=${exitCode} outputLen=${output.length}`);
        if (!finished && output.length < 100) finish(new Error(`Kiro CLI が終了しました（コード ${exitCode}）。ログイン状態を確認してください。`));
      });
      setTimeout(() => scheduleSend('10s-fallback'), 10000);
      timeoutTimer = setTimeout(() => {
        log(`TIMEOUT. sendAttempts=${sendAttempts} trustAnswered=${trustAnswered}`);
        log(`RAW OUTPUT:\n${stripTerminalSequences(output)}`);
        finish(new Error('Kiro CLI からの応答がタイムアウトしました。'));
      }, 30000);
    } catch (error) {
      finish(new Error(`Kiro CLI を起動できませんでした: ${error.message}`));
    }
  }).finally(() => { currentKiroRequest = null; });

  return currentKiroRequest;
}

let currentAgyRequest = null;

// Resolve the Antigravity CLI (agy) executable.
// Installed via PowerShell: irm https://antigravity.google/cli/install.ps1 | iex
// Default location: %LOCALAPPDATA%\agy\bin\agy.exe
function resolveAgyExe() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const p = path.join(localAppData, 'agy', 'bin', 'agy.exe');
  try { if (fs.statSync(p).isFile()) return p; } catch { /* not found */ }
  return null;
}

function agyRemaining(resetText) {
  // agy reports resets like "Refreshes in 167h 56m", "4h 12m", "7m", or "Quota available".
  if (!resetText || /quota available/i.test(resetText)) return null;
  const dm = resetText.match(/(\d+)d/);
  const hm = resetText.match(/(\d+)\s*h/);
  const mm = resetText.match(/(\d+)\s*m/);
  let totalMinutes = 0;
  if (dm) totalMinutes += Number(dm[1]) * 1440;
  if (hm) totalMinutes += Number(hm[1]) * 60;
  if (mm) totalMinutes += Number(mm[1]);
  return totalMinutes > 0 ? formatDuration(totalMinutes) : null;
}

function parseAgyUsage(rawOutput) {
  const text = stripTerminalSequences(rawOutput);
  // Detect plan/model from the banner e.g. "Gemini 3.6 Flash (High)"
  const plan = text.match(/Gemini\s+[\d.]+\s+\w+(?:\s*\(\w+\))?/i)?.[0]?.trim()
    || text.match(/Model:\s*(.+?)(?:\s*$|\s*\n)/im)?.[1]?.trim()
    || 'Connected';

  // Parse quota from agy /usage actual output. Format:
  //   GEMINI MODELS
  //     Models within this group: Gemini Flash, Gemini Pro
  //
  //     Weekly Limit
  //       [████████████████████████████] 99.98%
  //       100% remaining · Refreshes in 167h 56m
  //
  //     Five Hour Limit
  //       [████████████████████████████] 99.86%
  //       100% remaining · Refreshes in 4h 56m
  //
  //   CLAUDE AND GPT MODELS
  //     ...
  //       Quota available
  const limits = [];

  // Pattern: "N% remaining · Refreshes in Xh Ym" or "Quota available"
  // We need to pair each with its preceding limit label (e.g. "Weekly Limit", "Five Hour Limit")
  // Strategy: find all limit blocks by scanning for the label then the remaining line
  const blocks = text.split(/\n/);
  let currentLabel = '';
  let currentGroup = '';
  for (const line of blocks) {
    // Detect group header
    const groupMatch = line.match(/^(GEMINI MODELS|CLAUDE AND GPT MODELS)/i);
    if (groupMatch) {
      currentGroup = groupMatch[1].trim();
      continue;
    }
    // Detect limit label
    const labelMatch = line.match(/^\s*(Weekly Limit|Five Hour Limit|Monthly Limit|Daily Limit)/i);
    if (labelMatch) {
      currentLabel = labelMatch[1].trim();
      continue;
    }
    // Detect "N% remaining · Refreshes in Xh Ym"
    const remainingMatch = line.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*remaining\s*·\s*Refreshes?\s+in\s+([\dhm ]+)/i);
    if (remainingMatch && currentLabel) {
      const remaining = Number(remainingMatch[1]);
      const percent = Math.min(100, Math.round((100 - remaining) * 10) / 10);
      const resetAt = remainingMatch[2].trim();
      const groupPrefix = currentGroup.toLowerCase().includes('claude') ? 'Claude/GPT ' : '';
      limits.push({ label: groupPrefix + currentLabel, percent, resetAt, remaining: agyRemaining(resetAt) });
      currentLabel = '';
      continue;
    }
    // Detect "Quota available" (fully available, 0% used)
    if (/Quota available/i.test(line) && currentLabel) {
      const groupPrefix = currentGroup.toLowerCase().includes('claude') ? 'Claude/GPT ' : '';
      limits.push({ label: groupPrefix + currentLabel, percent: 0, resetAt: 'quota available', remaining: null });
      currentLabel = '';
      continue;
    }
  }

  if (!limits.length) {
    throw new Error('Antigravity CLI の使用状況を読み取れませんでした（/usage の出力形式が想定と異なります）。');
  }
  return { plan, limits };
}

function fetchAgyUsage() {
  if (currentAgyRequest) return currentAgyRequest;

  currentAgyRequest = new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const logPath = path.join(app.getPath('userData'), 'agy-usage-debug.log');
    const log = (msg) => {
      if (!DEBUG_LOG) return;
      try { fs.appendFileSync(logPath, `[+${String(Date.now() - startedAt).padStart(5, ' ')}ms] ${msg}\n`); } catch { /* ignore */ }
    };
    if (DEBUG_LOG) {
      try { fs.writeFileSync(logPath, `===== agy:usage run @ ${new Date().toISOString()} =====\n`); } catch { /* ignore */ }
    }

    let output = '';
    let sendScheduled = false;
    let trustAnswered = false;
    let sendAttempts = 0;
    let completeTimer;
    let timeoutTimer;
    let retryTimer;
    let terminal;
    let finished = false;

    const finish = (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(completeTimer);
      clearTimeout(timeoutTimer);
      clearTimeout(retryTimer);
      try { terminal?.kill(); } catch { /* already closed */ }
      if (error) {
        log(`FINISH with error: ${error.message}`);
        reject(error);
      } else {
        try {
          const result = parseAgyUsage(output);
          log(`FINISH ok: plan=${result.plan} limits=${result.limits.map((l) => `${l.label}:${l.percent}%`).join(', ')}`);
          log(`RAW OUTPUT:\n${stripTerminalSequences(output)}`);
          resolve(result);
        } catch (parseError) {
          log(`FINISH parse failed: ${parseError.message}`);
          log(`RAW OUTPUT:\n${stripTerminalSequences(output)}`);
          reject(parseError);
        }
      }
    };

    const trySend = () => {
      if (finished) return;
      const readable = stripTerminalSequences(output);
      if (/%\s*remaining/i.test(readable) || /Quota available/i.test(readable)) {
        log('usage data detected, stop sending');
        return;
      }
      sendAttempts += 1;
      log(`sending /usage (attempt ${sendAttempts})`);
      try { terminal.write('/usage\r'); } catch { /* gone */ }
      if (sendAttempts < 5) retryTimer = setTimeout(trySend, 3500);
    };
    const scheduleSend = (via) => {
      if (sendScheduled || finished) return;
      sendScheduled = true;
      log(`scheduling /usage (${via})`);
      setTimeout(trySend, 2000);
    };

    const agyExe = resolveAgyExe();
    if (!agyExe) {
      finish(new Error('Antigravity CLI (agy) が見つかりません（%LOCALAPPDATA%\\agy\\bin\\agy.exe 未検出）。'));
      return;
    }

    try {
      const workspaceDir = path.join(app.getPath('userData'), 'agy-workspace');
      try { fs.mkdirSync(workspaceDir, { recursive: true }); } catch { /* exists */ }
      log(`spawn: ${agyExe} (cwd=${workspaceDir})`);
      terminal = pty.spawn(agyExe, [], {
        name: 'xterm-256color', cols: 120, rows: 42, cwd: workspaceDir, env: process.env
      });
      terminal.onData((data) => {
        output += data;
        const readable = stripTerminalSequences(output);
        // agy presents a directory trust prompt with arrow-key selection.
        // "Yes, I trust this folder" is pre-selected; just press Enter.
        if (!trustAnswered && /Do you trust the contents|Yes, I trust this folder/i.test(readable)) {
          trustAnswered = true;
          log('trust prompt detected -> Enter');
          try { terminal.write('\r'); } catch { /* gone */ }
          return;
        }
        // Detect the REPL is ready: agy shows the model name in the status bar
        // e.g. "Gemini 3.6 Flash · hig" after sign-in and trust are done.
        // This fires whether trust was prompted or not (already-trusted workspaces skip it).
        if (!sendScheduled && /Gemini\s+[\d.]+\s+\w+\s*·/i.test(readable)) {
          scheduleSend('model-banner');
        }
        // Detect usage output arrived (looks for "% remaining" or "Quota available")
        if (sendScheduled && (/%\s*remaining/i.test(readable) || /Quota available/i.test(readable))) {
          clearTimeout(retryTimer);
          // Wait for all groups to render (there are usually 2 groups)
          completeTimer ||= setTimeout(() => finish(), 1500);
        }
      });
      terminal.onExit(({ exitCode }) => {
        log(`pty exit code=${exitCode} outputLen=${output.length}`);
        if (!finished && output.length < 100) finish(new Error(`Antigravity CLI が終了しました（コード ${exitCode}）。ログイン状態を確認してください。`));
      });
      // Fallback: if no model banner detected within 15s, try sending anyway
      setTimeout(() => scheduleSend('15s-fallback'), 15000);
      timeoutTimer = setTimeout(() => {
        log(`TIMEOUT. sendAttempts=${sendAttempts} trustAnswered=${trustAnswered}`);
        log(`RAW OUTPUT:\n${stripTerminalSequences(output)}`);
        finish(new Error('Antigravity CLI からの応答がタイムアウトしました。'));
      }, 35000);
    } catch (error) {
      finish(new Error(`Antigravity CLI を起動できませんでした: ${error.message}`));
    }
  }).finally(() => { currentAgyRequest = null; });

  return currentAgyRequest;
}

// Settings persistence
const DEFAULT_SETTINGS = {
  providers: [
    { id: 'claude', enabled: true },
    { id: 'codex', enabled: true },
    { id: 'kiro', enabled: true },
    { id: 'agy', enabled: true }
  ]
};

function getSettingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const data = fs.readFileSync(getSettingsPath(), 'utf8');
    const settings = JSON.parse(data);
    // Ensure all known providers exist (in case new ones are added)
    const known = ['claude', 'codex', 'kiro', 'agy'];
    const existing = settings.providers.map((p) => p.id);
    for (const id of known) {
      if (!existing.includes(id)) {
        settings.providers.push({ id, enabled: true });
      }
    }
    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  fs.writeFileSync(getSettingsPath(), JSON.stringify(settings, null, 2), 'utf8');
}

function createWindow() {
  // Restore saved window bounds and zoom
  const settings = loadSettings();
  const wb = settings.windowBounds || {};
  const bounds = {
    width: wb.width || 980,
    height: wb.height || 760,
    ...(wb.x !== undefined && wb.y !== undefined ? { x: wb.x, y: wb.y } : {})
  };

  const window = new BrowserWindow({
    ...bounds,
    minWidth: 760,
    minHeight: 620,
    backgroundColor: '#f6f8fb',
    title: 'UsageAI',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  });

  // Save window position/size on move or resize (debounced)
  let saveTimer;
  const saveWindowState = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      if (window.isMinimized() || window.isMaximized()) return;
      const b = window.getBounds();
      const current = loadSettings();
      current.windowBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
      saveSettings(current);
    }, 500);
  };
  window.on('resize', saveWindowState);
  window.on('move', saveWindowState);

  // Show the window as soon as the first paint is ready so it appears instantly
  // without a white flash. Usage data is fetched asynchronously by the renderer.
  window.once('ready-to-show', () => window.show());
  window.loadFile('index.html');
}

app.whenReady().then(() => {
  ipcMain.handle('claude:usage', fetchClaudeUsage);
  ipcMain.handle('codex:usage', fetchCodexUsage);
  ipcMain.handle('kiro:usage', fetchKiroUsage);
  ipcMain.handle('agy:usage', fetchAgyUsage);
  ipcMain.handle('settings:load', () => loadSettings());
  ipcMain.handle('settings:save', (_event, settings) => { saveSettings(settings); return true; });
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
