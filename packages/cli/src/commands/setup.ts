import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  API_KEYS,
  apiKeySource,
  geminiKeySource,
  getApiKey,
  initWorkspace,
  inspectWorkspace,
  type KeyedProvider,
  keyFromEnvText,
  loadConfig,
  openWorkspace,
  rememberWorkspace,
  setApiKey,
  updateConfig,
  type Workspace,
} from '@anirecast/core';
import { AppServerClient, resolveCodexCommand } from '@anirecast/daemon';
import { AniError } from '@anirecast/shared';
import type { Command } from 'commander';
import { command, note } from '../output.ts';
import { REPO_ROOT } from './doctor.ts';

export const AGENT_LABEL = 'dev.anirecast.daemon';
const PLIST = path.join(os.homedir(), 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'AniRecast');
const CLI_LINK = path.join(os.homedir(), '.local', 'bin', 'anirecast');
const SKILL_LINK = path.join(os.homedir(), '.codex', 'skills', 'anirecast');
// Claude Code loads the same skill (it is the main operator of agent tasks).
const CLAUDE_SKILL_LINK = path.join(os.homedir(), '.claude', 'skills', 'anirecast');
const uid = () => (process.getuid ? process.getuid() : 0);

interface Step {
  step: string;
  status: 'done' | 'unchanged' | 'skipped' | 'planned' | 'removed';
  detail?: string;
}

/** Points `link` at `target`; refuses to replace anything that is not already our symlink. */
function ensureLink(link: string, target: string, dryRun: boolean): Step {
  const name = `link ${link}`;
  if (existsSync(link) || isSymlink(link)) {
    if (isSymlink(link) && path.resolve(path.dirname(link), readlinkSync(link)) === target)
      return { step: name, status: 'unchanged', detail: target };
    if (!isSymlink(link))
      throw new AniError('conflict', `${link} exists and is not a symlink; move it away first`);
    if (dryRun) return { step: name, status: 'planned', detail: `repoint to ${target}` };
    rmSync(link);
  }
  if (dryRun) return { step: name, status: 'planned', detail: target };
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(target, link);
  return { step: name, status: 'done', detail: target };
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function plist(): string {
  const env = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local', 'bin'),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
  const args = [
    process.execPath,
    '--disable-warning=ExperimentalWarning',
    path.join(REPO_ROOT, 'apps', 'daemon', 'src', 'main.ts'),
  ];
  const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${xml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${xml(REPO_ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${env}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(path.join(LOG_DIR, 'daemon.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(LOG_DIR, 'daemon.log'))}</string>
</dict>
</plist>
`;
}

export function launchAgentLoaded(): boolean {
  return spawnSync('launchctl', ['print', `gui/${uid()}/${AGENT_LABEL}`], { stdio: 'ignore' }).status === 0;
}

function installAgent(dryRun: boolean): Step {
  if (dryRun) return { step: 'launchd agent', status: 'planned', detail: PLIST };
  mkdirSync(path.dirname(PLIST), { recursive: true });
  mkdirSync(LOG_DIR, { recursive: true });
  const next = plist();
  const same = existsSync(PLIST) && readFileSync(PLIST, 'utf8') === next;
  writeFileSync(PLIST, next);
  spawnSync('launchctl', ['bootout', `gui/${uid()}/${AGENT_LABEL}`], { stdio: 'ignore' });
  const r = spawnSync('launchctl', ['bootstrap', `gui/${uid()}`, PLIST], { encoding: 'utf8' });
  if (r.status !== 0) throw new AniError('internal', `launchctl bootstrap failed: ${r.stderr.trim()}`);
  return {
    step: 'launchd agent',
    status: same ? 'unchanged' : 'done',
    detail: `${PLIST} (logs: ${LOG_DIR}/daemon.log)`,
  };
}

async function waitForHeartbeat(root: string, timeoutMs = 20_000): Promise<Step> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ws = openWorkspace(root, { role: 'cli' });
    try {
      const hb = ws.db.prepare('SELECT pid, at FROM daemon_heartbeat WHERE id = 1').get() as
        | { pid: number; at: number }
        | undefined;
      if (hb && Date.now() - hb.at < 10_000)
        return { step: 'daemon running', status: 'done', detail: `pid ${hb.pid}` };
    } finally {
      ws.close();
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new AniError('internal', 'The daemon did not start within 20 s', {
    hint: `Check ${LOG_DIR}/daemon.log`,
  });
}

/** Adds the workspace as a Codex desktop project (experimental app-server API) unless one already covers it. */
async function ensureCodexProject(ws: Workspace, dryRun: boolean): Promise<Step> {
  const cmd = resolveCodexCommand(loadConfig().codex.binPath);
  if (!cmd) return { step: 'codex project', status: 'skipped', detail: 'Codex CLI not found' };
  const client = new AppServerClient({ command: cmd.command, args: cmd.args });
  try {
    await client.start();
    const list = await client.request<{
      data: Array<{ id: string; name: string; roots: Array<{ path: string }> }>;
    }>('project/list', { limit: 200 });
    const covering = list.data.find((p) =>
      p.roots.some(
        (r) => ws.root === path.resolve(r.path) || ws.root.startsWith(`${path.resolve(r.path)}${path.sep}`),
      ),
    );
    if (covering)
      return { step: 'codex project', status: 'unchanged', detail: `${covering.name} (${covering.id})` };
    if (dryRun) return { step: 'codex project', status: 'planned', detail: ws.root };
    const created = await client.request<{ project: { id: string; name: string } }>('project/create', {
      name: ws.manifest.name,
      roots: [{ path: ws.root }],
      idempotencyKey: `anirecast:${ws.manifest.workspaceId}`,
    });
    return {
      step: 'codex project',
      status: 'done',
      detail: `${created.project.name} (${created.project.id}); check it appears in the Codex desktop sidebar`,
    };
  } catch (error) {
    return {
      step: 'codex project',
      status: 'skipped',
      detail: `project API unavailable: ${(error as Error).message}`,
    };
  } finally {
    client.stop();
  }
}

export function registerSetup(program: Command): void {
  program
    .command('setup')
    .description(
      'Install AniRecast on this Mac: Python env, CLI link, Codex and Claude Code skill, launchd agent, workspace, Codex project',
    )
    .option('--no-codex-project', 'do not add the workspace as a Codex desktop project')
    .option('--no-agent', 'do not install the launchd agent')
    .option('--build-web', 'rebuild the web UI even if a build exists')
    .option('--dry-run', 'show what would change')
    .option('--uninstall', 'remove the launchd agent and links (workspaces and keys are kept)')
    .action(
      command(
        async (opts: {
          codexProject: boolean;
          agent: boolean;
          buildWeb?: boolean;
          dryRun?: boolean;
          uninstall?: boolean;
        }) => {
          if (process.platform !== 'darwin')
            throw new AniError('usage', 'setup currently supports macOS only (Windows is milestone M7)');
          if (process.env.CODEX_SANDBOX) throw new AniError('usage', 'Run setup outside the Codex sandbox');
          const dry = Boolean(opts.dryRun);
          const steps: Step[] = [];
          if (opts.uninstall) {
            if (!dry) {
              spawnSync('launchctl', ['bootout', `gui/${uid()}/${AGENT_LABEL}`], { stdio: 'ignore' });
              rmSync(PLIST, { force: true });
            }
            steps.push({ step: 'launchd agent', status: dry ? 'planned' : 'removed', detail: PLIST });
            for (const link of [CLI_LINK, SKILL_LINK, CLAUDE_SKILL_LINK]) {
              if (isSymlink(link) && readlinkSync(link).startsWith(REPO_ROOT)) {
                if (!dry) rmSync(link);
                steps.push({ step: `link ${link}`, status: dry ? 'planned' : 'removed' });
              }
            }
            return { steps };
          }
          note('python environment (uv sync)…');
          if (!dry) {
            const r = spawnSync('uv', ['sync', '--quiet', '--project', path.join(REPO_ROOT, 'python')], {
              encoding: 'utf8',
            });
            if (r.status !== 0)
              throw new AniError('dependency_missing', `uv sync failed: ${r.stderr.trim()}`, {
                hint: 'Install uv: brew install uv',
              });
          }
          steps.push({
            step: 'python sidecar',
            status: dry ? 'planned' : 'done',
            detail: path.join(REPO_ROOT, 'python'),
          });
          steps.push(ensureLink(CLI_LINK, path.join(REPO_ROOT, 'bin', 'anirecast'), dry));
          steps.push(ensureLink(SKILL_LINK, path.join(REPO_ROOT, 'skills', 'anirecast'), dry));
          steps.push(ensureLink(CLAUDE_SKILL_LINK, path.join(REPO_ROOT, 'skills', 'anirecast'), dry));
          const dist = path.join(REPO_ROOT, 'apps', 'web', 'dist', 'index.html');
          if (opts.buildWeb || !existsSync(dist)) {
            note('building the web UI…');
            if (!dry) {
              const r = spawnSync('pnpm', ['--filter', '@anirecast/web', 'build'], {
                cwd: REPO_ROOT,
                encoding: 'utf8',
              });
              if (r.status !== 0)
                throw new AniError('internal', `web build failed: ${r.stderr.trim().slice(-500)}`);
            }
            steps.push({ step: 'web build', status: dry ? 'planned' : 'done' });
          } else {
            steps.push({ step: 'web build', status: 'unchanged', detail: dist });
          }
          // The global --workspace names the workspace to create (if empty or missing) or open, and serve.
          const requested = program.opts<{ workspace?: string }>().workspace;
          let root = requested ? path.resolve(requested) : loadConfig().workspace;
          if (!root) throw new AniError('usage', 'Pass --workspace <dir> the first time');
          const inspect = inspectWorkspace(root);
          if (!inspect.valid) {
            if (existsSync(path.join(root, 'anirecast.workspace.json')))
              throw new AniError('invalid_workspace', inspect.problems.join('; '));
            if (!dry) initWorkspace(root, { name: path.basename(root) }).close();
            steps.push({ step: 'workspace', status: dry ? 'planned' : 'done', detail: `created ${root}` });
          } else {
            steps.push({ step: 'workspace', status: 'unchanged', detail: root });
          }
          if (!dry) rememberWorkspace(root);
          root = path.resolve(root);
          const keySource = geminiKeySource();
          steps.push({
            step: 'gemini key',
            status: keySource === 'keychain' ? 'unchanged' : 'skipped',
            detail:
              keySource === 'keychain'
                ? 'macOS keychain'
                : 'not in the keychain; the launchd daemon cannot read .env — run `anirecast auth set-key`',
          });
          if (opts.agent) {
            steps.push(installAgent(dry));
            if (!dry) steps.push(await waitForHeartbeat(root));
          }
          if (opts.codexProject && !dry && existsSync(path.join(root, 'anirecast.workspace.json'))) {
            const ws = openWorkspace(root, { role: 'cli' });
            try {
              steps.push(await ensureCodexProject(ws, dry));
            } finally {
              ws.close();
            }
          }
          const port = loadConfig().daemon.port;
          return {
            steps,
            web: `http://127.0.0.1:${port}`,
            next: ['anirecast doctor', `open http://127.0.0.1:${port}`],
          };
        },
      ),
    );

  const auth = program
    .command('auth')
    .description('API keys for Gemini, fal.ai and the JEV router (macOS keychain, never in a workspace)');
  const providerOf = (value: string | undefined): KeyedProvider => {
    const p = (value ?? 'gemini') as KeyedProvider;
    if (!(p in API_KEYS))
      throw new AniError('usage', `--provider must be one of ${Object.keys(API_KEYS).join(', ')}`);
    return p;
  };
  auth
    .command('set-key')
    .description(
      'Read the key from stdin (e.g. `pbpaste | anirecast auth set-key --provider fal`) or from a .env file',
    )
    .option('--provider <name>', 'gemini (default), fal or jev')
    .option(
      '--from-env-file <file>',
      'take the key from this file (GEMINI_API_KEY, FAL_KEY/FAL_AI_KEY or JEV_API_KEY; JEV_URL is saved too)',
    )
    .action(
      command(async (opts: { provider?: string; fromEnvFile?: string }) => {
        const provider = providerOf(opts.provider);
        let key: string | undefined;
        let baseUrl: string | undefined;
        if (opts.fromEnvFile) {
          const text = readFileSync(opts.fromEnvFile, 'utf8');
          key = keyFromEnvText(provider, text);
          if (provider === 'jev') baseUrl = /^JEV_URL\s*=\s*"?([^"\n]+)"?/m.exec(text)?.[1]?.trim();
        } else {
          if (process.stdin.isTTY) note('Paste the key, then press Ctrl-D:');
          const chunks: Buffer[] = [];
          for await (const c of process.stdin) chunks.push(c as Buffer);
          key = Buffer.concat(chunks).toString('utf8').trim();
        }
        if (!key) throw new AniError('usage', `No ${API_KEYS[provider].label} key found`);
        setApiKey(provider, key);
        if (baseUrl)
          updateConfig((c) => {
            c.providers.jev.baseUrl = baseUrl;
          });
        return { provider, stored: 'keychain', length: key.length, ...(baseUrl ? { baseUrl } : {}) };
      }),
    );
  auth
    .command('status')
    .option('--check', 'make one free call per configured key to confirm it works')
    .action(
      command(async (opts: { check?: boolean }) => {
        const config = loadConfig();
        const out = [];
        for (const provider of Object.keys(API_KEYS) as KeyedProvider[]) {
          const source = apiKeySource(provider);
          const row: Record<string, unknown> = { provider, source };
          if (provider === 'jev') row.baseUrl = process.env.JEV_URL ?? config.providers.jev.baseUrl;
          if (opts.check && source !== 'missing') {
            const key = getApiKey(provider) ?? '';
            const res =
              provider === 'gemini'
                ? await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', {
                    headers: { 'x-goog-api-key': key },
                  })
                : provider === 'fal'
                  ? await fetch('https://api.fal.ai/v1/models?limit=1', {
                      headers: { authorization: `Key ${key}` },
                    })
                  : await fetch(`${row.baseUrl}/models`, { headers: { authorization: `Bearer ${key}` } });
            row.valid = res.ok;
            row.status = res.status;
          }
          out.push(row);
        }
        return out;
      }),
    );
}
