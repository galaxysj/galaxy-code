// File and folder icons from Material Icon Theme (MIT), the VS Code icon theme.
// Only the icons named in the glob below are bundled; small ones are inlined by Vite.
const urls = import.meta.glob<string>(
  '../../../../node_modules/material-icon-theme/icons/{document,folder,folder-open,typescript,react,react_ts,javascript,json,markdown,python,rust,go,swift,java,kotlin,ruby,css,sass,less,html,yaml,toml,xml,svg,image,console,powershell,c,cpp,h,hpp,csharp,php,dart,scala,lua,haskell,elixir,r,database,graphql,prisma,svelte,vue,astro,tailwindcss,eslint,prettier,nodejs,npm,yarn,pnpm,bun,deno,tsconfig,vite,docker,git,lock,readme,license,changelog,settings,tune,makefile,gradle,cmake,zip,pdf,video,audio,font,log,table,word,exe,certificate,key,http,jupyter,terraform,nix,zig,ocaml,clojure,erlang,julia,perl,vim,tex,proto,editorconfig,babel,jest,vitest,webpack,rollup,favicon,robots,todo,diff}.svg',
  { eager: true, query: '?url', import: 'default' }
)

const ICONS: Record<string, string> = {}
for (const [path, url] of Object.entries(urls)) ICONS[path.slice(path.lastIndexOf('/') + 1, -4)] = url

/** Exact file names, matched case-insensitively. */
const NAMES: Record<string, string> = {
  'package.json': 'nodejs',
  'package-lock.json': 'npm',
  '.npmrc': 'npm',
  'yarn.lock': 'yarn',
  'pnpm-lock.yaml': 'pnpm',
  'pnpm-workspace.yaml': 'pnpm',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
  'deno.json': 'deno',
  'dockerfile': 'docker',
  'docker-compose.yml': 'docker',
  'docker-compose.yaml': 'docker',
  'compose.yml': 'docker',
  'compose.yaml': 'docker',
  '.gitignore': 'git',
  '.gitattributes': 'git',
  '.gitmodules': 'git',
  '.gitkeep': 'git',
  'makefile': 'makefile',
  'cmakelists.txt': 'cmake',
  '.editorconfig': 'editorconfig',
  '.babelrc': 'babel',
  '.prettierrc': 'prettier',
  '.prettierignore': 'prettier',
  '.eslintrc': 'eslint',
  '.eslintignore': 'eslint',
  'robots.txt': 'robots',
  'favicon.ico': 'favicon',
  'cargo.lock': 'lock',
  'license': 'license',
  'license.md': 'license',
  'license.txt': 'license',
  'changelog.md': 'changelog',
  'readme.md': 'readme',
  'readme': 'readme',
  'todo.md': 'todo'
}

/** File name patterns, checked in order before extensions. */
const PATTERNS: [RegExp, string][] = [
  [/^tsconfig(\..+)?\.json$/, 'tsconfig'],
  [/^jsconfig(\..+)?\.json$/, 'tsconfig'],
  [/^(electron\.)?vite\.config\.[cm]?[jt]s$/, 'vite'],
  [/^vitest\.config\.[cm]?[jt]s$/, 'vitest'],
  [/^jest\.config\.[cm]?[jt]s$/, 'jest'],
  [/^webpack\..*\.[cm]?[jt]s$/, 'webpack'],
  [/^rollup\.config\.[cm]?[jt]s$/, 'rollup'],
  [/^tailwind\.config\.[cm]?[jt]s$/, 'tailwindcss'],
  [/^(\.)?eslint(rc)?(\.config)?\.[a-z]+$/, 'eslint'],
  [/^(\.)?prettier(rc)?(\.config)?\.[a-z]+$/, 'prettier'],
  [/^babel\.config\.[a-z]+$/, 'babel'],
  [/^\.env(\..+)?$/, 'tune'],
  [/^dockerfile\..+$/, 'docker'],
  [/^readme\..+$/, 'readme'],
  [/^changelog(\..+)?$/, 'changelog'],
  [/\.d\.[cm]?ts$/, 'typescript'],
  [/\.lock$/, 'lock']
]

const EXTENSIONS: Record<string, string> = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript',
  tsx: 'react_ts', jsx: 'react',
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  json: 'json', jsonc: 'json', json5: 'json',
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  py: 'python', pyi: 'python', pyw: 'python', ipynb: 'jupyter',
  rs: 'rust', go: 'go', swift: 'swift', java: 'java', kt: 'kotlin', kts: 'kotlin',
  rb: 'ruby', php: 'php', cs: 'csharp', dart: 'dart', scala: 'scala', lua: 'lua',
  hs: 'haskell', ex: 'elixir', exs: 'elixir', r: 'r', zig: 'zig', ml: 'ocaml',
  clj: 'clojure', erl: 'erlang', jl: 'julia', pl: 'perl', vim: 'vim', tex: 'tex',
  c: 'c', h: 'h', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'hpp', hh: 'hpp',
  m: 'c', mm: 'cpp',
  css: 'css', scss: 'sass', sass: 'sass', less: 'less',
  html: 'html', htm: 'html', vue: 'vue', svelte: 'svelte', astro: 'astro',
  yaml: 'yaml', yml: 'yaml', toml: 'toml', ini: 'settings', cfg: 'settings', conf: 'settings', plist: 'xml',
  xml: 'xml', svg: 'svg',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', ico: 'image', bmp: 'image', avif: 'image', icns: 'image', heic: 'image',
  sh: 'console', bash: 'console', zsh: 'console', fish: 'console', ps1: 'powershell',
  sql: 'database', db: 'database', sqlite: 'database', graphql: 'graphql', gql: 'graphql', prisma: 'prisma',
  proto: 'proto', tf: 'terraform', nix: 'nix', gradle: 'gradle', cmake: 'cmake',
  zip: 'zip', tar: 'zip', gz: 'zip', tgz: 'zip', '7z': 'zip', rar: 'zip', dmg: 'zip', pkg: 'zip',
  pdf: 'pdf', doc: 'word', docx: 'word', csv: 'table', tsv: 'table', xls: 'table', xlsx: 'table',
  mp4: 'video', mov: 'video', webm: 'video', mkv: 'video', avi: 'video',
  mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio',
  ttf: 'font', otf: 'font', woff: 'font', woff2: 'font',
  log: 'log', exe: 'exe', pem: 'certificate', crt: 'certificate', cer: 'certificate', key: 'key',
  http: 'http', rest: 'http', diff: 'diff', patch: 'diff', env: 'tune', lockb: 'lock'
}

/** The icon URL for a file name, falling back to a plain document. */
export function fileIconUrl(name: string): string {
  const lower = name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1).toLowerCase()
  let icon = NAMES[lower] ?? PATTERNS.find(([pattern]) => pattern.test(lower))?.[1]
  if (!icon) {
    const dot = lower.lastIndexOf('.')
    if (dot >= 0) icon = EXTENSIONS[lower.slice(dot + 1)]
  }
  return ICONS[icon ?? 'document'] ?? ICONS.document
}

export function folderIconUrl(open: boolean): string {
  return ICONS[open ? 'folder-open' : 'folder']
}
