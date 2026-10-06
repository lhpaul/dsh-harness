/**
 * Shared fixtures. Every test tree lives in a fresh temp directory under
 * $HOME (not /tmp: every workspace-write policy grants /tmp, which would make
 * negative controls meaningless). Never touches the real ~/Git.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const INSTALL_ROOT = join(REPO, 'node_modules', '@deepseek-ai')
export const isMac = process.platform === 'darwin'

/** Create an empty temp dir under $HOME; returns [path, cleanup]. */
export function tempHomeDir(prefix = '.dsh-harness-test-') {
  const dir = realpathSync(mkdtempSync(join(homedir(), prefix)))
  return [dir, () => rmSync(dir, { recursive: true, force: true })]
}

export function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value, null, '\t'))
}

/**
 * Build a fake home mirroring LH's layout:
 *   home/Git/Blum        Blum.code-workspace (+ JSONC variant), repo docs/
 *   home/Git/Leasity     Leasity - Core.code-workspace, broken.code-workspace, repo leasity-mvp-webapp/
 *   home/Git/Cerebro/LH  the vault, with 45 - Autoconocimiento/Diarios
 *   home/Documents/LH/Negocios/Proyectos/{Blum,Leasity}
 *   home/outside         a directory outside every scope
 */
export function buildFixture(base) {
  const home = join(base, 'home')
  const git = join(home, 'Git')
  const p = {
    home,
    git,
    blum: join(git, 'Blum'),
    blumRepo: join(git, 'Blum', 'docs'),
    leasity: join(git, 'Leasity'),
    leasityRepo: join(git, 'Leasity', 'leasity-mvp-webapp'),
    vault: join(git, 'Cerebro', 'LH'),
    diarios: join(git, 'Cerebro', 'LH', '45 - Autoconocimiento', 'Diarios'),
    principios: join(git, 'Cerebro', 'LH', '45 - Autoconocimiento', 'Principios'),
    assetsBlum: join(home, 'Documents', 'LH', 'Negocios', 'Proyectos', 'Blum'),
    assetsLeasity: join(home, 'Documents', 'LH', 'Negocios', 'Proyectos', 'Leasity'),
    shared: join(home, 'Documents', 'LH', 'Negocios', 'Shared'),
    outside: join(home, 'outside'),
  }
  for (const dir of [p.blumRepo, p.leasityRepo, p.diarios, p.principios, p.assetsBlum, p.assetsLeasity, p.shared, p.outside]) {
    mkdirSync(dir, { recursive: true })
  }
  writeJson(join(p.blum, 'Blum.code-workspace'), {
    folders: [
      { path: 'docs' },
      { path: '../Cerebro/LH' },
      { path: '../../Documents/LH/Negocios/Proyectos/Blum' },
    ],
    settings: {},
  })
  writeJson(join(p.blum, 'Blum - BAUM.code-workspace'), `{
\t// JSONC: comments and trailing commas, as VS Code writes them
\t"folders": [
\t\t{ "path": "docs" },
\t\t{ "path": "../Cerebro/LH" }, /* same vault, deduplicated */
\t\t{ "path": "../../Documents/LH/Negocios/Shared" },
\t\t{ "path": "../../Documents/LH/Negocios/does-not-exist" },
\t],
\t"settings": { "url": "https://example.com//not-a-comment" },
}
`)
  writeJson(join(p.leasity, 'Leasity - Core.code-workspace'), {
    folders: [
      { path: 'leasity-mvp-webapp' },
      { path: '../Cerebro/LH' },
      { path: '../../Documents/LH/Negocios/Proyectos/Leasity' },
    ],
  })
  writeJson(join(p.leasity, 'broken.code-workspace'), '{ "folders": [ { "path": ')
  return p
}
