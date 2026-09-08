import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tests = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).map(name => join(root, 'tests', name));
const run = args => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000 });
const validation = run([join(root, 'scripts/validate.mjs')]);
const testing = run(['--test', ...tests]);
const pass = validation.status === 0 && testing.status === 0;
const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const logs = [validation.stdout, validation.stderr, validation.error?.message, testing.stdout, testing.stderr, testing.error?.message].filter(Boolean).join('\n');
mkdirSync(join(root, 'runtime'), { recursive: true });
writeFileSync(join(root, 'runtime/report.html'), `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Claude Continuity — verificação</title><style>body{font:17px/1.6 system-ui;max-width:960px;margin:50px auto;padding:0 24px;background:#f5f2eb;color:#242924}h1{line-height:1.15}aside{border-left:5px solid #b46b22;padding:16px;background:#fff4df}pre{font:13px/1.7 monospace;background:#fff;padding:22px;overflow:auto;border-radius:12px}.status{color:${pass ? '#216c4a' : '#aa2828'};font-weight:700}</style><p>PROTÓTIPO EXPERIMENTAL · 0.2.0</p><h1>Claude OpenRouter Continuity</h1><p class="status">${pass ? 'Testes locais aprovados' : 'Verificação encontrou falhas'}</p><aside><strong>O hot-swap no processo atual não está conectado.</strong> A recuperação por reinício fica desativada por padrão. Estes testes não encerram o Claude, não usam contas e não consomem tokens.</aside><p>O transporte testa a preservação das mensagens e referências de ferramentas após um erro de limite. O auxiliar Windows é validado somente em modo DryRun; a retomada real pelo Gateway ainda exige configuração e teste controlado.</p><p>Executado em ${escape(new Date().toISOString())}.</p><pre>${escape(logs)}</pre></html>`, 'utf8');
process.stdout.write(logs);
process.exitCode = pass ? 0 : 1;
