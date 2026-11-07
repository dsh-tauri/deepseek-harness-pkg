export const PATCHES = [
  {
    name: '@deepseek-ai/dsh-client-ui-renderer',
    file: 'lib/client.js',
    patch: '@deepseek-ai__dsh-client-ui-renderer@0.2.2-rc.1.patch',
    markers: ['exports.SlotOutlet = SlotOutlet;'],
  },
  {
    name: '@deepseek-ai/dsh-client-ui-plugin-manager',
    file: 'lib/client.js',
    patch: '@deepseek-ai__dsh-client-ui-plugin-manager@0.2.2-rc.1.patch',
    markers: ['!pkg.name.startsWith("dsh-tauri")'],
  },
  {
    name: '@deepseek-ai/dsh-client-ui-conversation',
    file: 'lib/client.js',
    patch: '@deepseek-ai__dsh-client-ui-conversation@0.2.2-rc.1.patch',
    // 未分组会话的可输入性：inert 放宽 + 客户端能力标记，两者必须同时在。
    markers: [
      '/* dsh-tauri-desktop: composer stays usable for a session outside every workspace */',
      'document.documentElement.setAttribute("data-dsh-composer-cwd", "1")',
    ],
  },
  {
    name: '@deepseek-ai/dsh-llm-pi-ai',
    file: 'lib/index.js',
    patch: '@deepseek-ai__dsh-llm-pi-ai@0.2.2-rc.1.patch',
    markers: ['/* dsh-tauri-desktop: OpenCode Go session header */', 'isOpenCodeRoute(options.provider, baseURL)'],
  },
]

export function parseHunks(patch) {
  const hunks = []
  let hunk = null
  const lines = patch.split('\n')
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].endsWith('\r') ? lines[i].slice(0, -1) : lines[i]
    if (line.startsWith('diff --git ') || line.startsWith('index ')) {
      hunk = null
      continue
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      hunk = null
      continue
    }
    if (line.startsWith('@@')) {
      const header = line.match(/^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/)
      if (header === null) throw new Error(`无法解析 diff hunk 头: ${line}`)
      hunk = { oldStart: Number(header[1]), lines: [] }
      hunks.push(hunk)
      continue
    }
    if (hunk === null) continue
    if (line.startsWith('\\')) continue
    if (line === '') {
      if (i === lines.length - 1) continue
      hunk = null
      continue
    }
    const kind = line[0]
    if (kind === ' ') hunk.lines.push({ kind: 'context', text: line.slice(1) })
    else if (kind === '+') hunk.lines.push({ kind: 'add', text: line.slice(1) })
    else if (kind === '-') hunk.lines.push({ kind: 'remove', text: line.slice(1) })
    else hunk = null
  }
  return hunks
}

function hunkSourceLines(hunk) {
  return hunk.lines.filter(line => line.kind !== 'add').map(line => line.text)
}

function findHunk(lines, hunk, expected) {
  const want = hunkSourceLines(hunk)
  if (want.length === 0) return expected
  const matches = at => want.every((text, index) => lines[at + index] === text)
  if (expected >= 0 && expected + want.length <= lines.length && matches(expected)) return expected
  const last = lines.length - want.length
  for (let distance = 1; distance <= lines.length + Math.abs(expected); distance += 1) {
    for (const at of [expected - distance, expected + distance]) {
      if (at < 0 || at > last) continue
      if (matches(at)) return at
    }
  }
  return -1
}

export function applyUnifiedDiff(source, patch, label = 'patch') {
  const hunks = parseHunks(patch)
  if (hunks.length === 0) throw new Error(`${label}: 没有可应用的 hunk`)
  const lines = source.split('\n')
  let delta = 0
  for (const hunk of hunks) {
    const at = findHunk(lines, hunk, hunk.oldStart - 1 + delta)
    if (at < 0) throw new Error(`${label}: hunk @@ -${hunk.oldStart} 的上下文与目标文件不匹配`)
    const replacement = hunk.lines.filter(line => line.kind !== 'remove').map(line => line.text)
    const removed = hunk.lines.filter(line => line.kind !== 'add').length
    lines.splice(at, removed, ...replacement)
    delta += replacement.length - removed
  }
  return lines.join('\n')
}

export function isPatched(source, entry) {
  return entry.markers.every(marker => source.includes(marker))
}
