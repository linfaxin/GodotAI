import type {BackendError, BackendReply} from './summer-adapter.ts';

const MAX_FILE_BYTES = 1_000_000;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', {ignoreBOM: true});

export interface ProjectFileScope {
  projectId: string;
  editorRevision: number;
}

type FileSnapshot = ProjectFileScope & {content: string | number[] | undefined};
export type ProjectFileReceipt = ProjectFileScope & {path: string; sha256: string; bytes: number};
export type ProjectFileRead = ProjectFileReceipt & {content: string};
export type ProjectFileWrite = {path: string; content: string; expectedSha256: string; expected: ProjectFileScope};

function failure(code: BackendError['code'], message: string): BackendReply<never> {
  return {ok: false, error: {code, message, source: 'sdk'}};
}

function sameScope(a: ProjectFileScope | undefined, b: ProjectFileScope) {
  return a?.projectId === b.projectId && a.editorRevision === b.editorRevision;
}

function encode(content: string) {
  if (content.length > MAX_FILE_BYTES) return;
  const bytes = encoder.encode(content);
  if (bytes.length <= MAX_FILE_BYTES && decoder.decode(bytes) === content) return bytes;
}

async function sha256(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}

export function createProjectFileAccess(
  snapshot: (path: string) => FileSnapshot | undefined,
  edit: (path: string, content: string) => ProjectFileScope,
) {
  async function read(path: string, expected?: ProjectFileScope): Promise<BackendReply<ProjectFileRead>> {
    const file = snapshot(path);
    if (!file) return failure('not_ready', '编辑项目尚未就绪');
    if (expected && !sameScope(file, expected)) return failure('revision_conflict', '项目或编辑版本已变化');
    if (file.content === undefined) return failure('not_found', '项目文件不存在');
    if (typeof file.content !== 'string') return failure('unsupported', '当前只支持项目中的 UTF-8 文本脚本');
    const bytes = encode(file.content);
    if (!bytes) return failure('unsupported', '脚本超出 1000000 字节或无法无损编码为 UTF-8');
    const hash = await sha256(bytes);
    const current = snapshot(path);
    if (!sameScope(current, file) || current?.content !== file.content)
      return failure('revision_conflict', '读取期间项目或编辑版本已变化');
    return {ok: true, result: {
      path: 'res:/' + path, content: file.content, sha256: hash, bytes: bytes.length,
      projectId: file.projectId, editorRevision: file.editorRevision,
    }};
  }

  async function write({path, content, expectedSha256, expected}: ProjectFileWrite): Promise<BackendReply<ProjectFileReceipt>> {
    const bytes = encode(content);
    if (!bytes) return failure('invalid_input', '脚本内容须为不超过 1000000 字节的 UTF-8 文本');
    const hash = await sha256(bytes);
    const previous = await read(path, expected);
    if (!previous.ok) return previous;
    const current = snapshot(path);
    if (!sameScope(current, expected) || current?.content !== previous.result.content)
      return failure('revision_conflict', '覆盖前项目或编辑版本已变化');
    if (previous.result.sha256 !== expectedSha256) return failure('revision_conflict', '文件散列已变化，请重新读取');
    const scope = content === previous.result.content ? expected : edit(path, content);
    return {ok: true, result: {...scope, path: 'res:/' + path, sha256: hash, bytes: bytes.length}};
  }

  return {read, write};
}
