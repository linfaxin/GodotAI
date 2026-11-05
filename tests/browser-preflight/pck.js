// Unencrypted Godot PCK v3. Layout follows core/io/pck_packer.cpp in Godot 4.6.1.
// Only already-compiled UTF-8 project files are supported by this initial probe.
function packProject(files) {
  const encoder = new TextEncoder();
  const align = (value, alignment) => Math.ceil(value / alignment) * alignment;
  const entries = [];
  let cursor = 112; // 104-byte header, aligned to 16 bytes.
  for (const uri of Object.keys(files).sort()) {
    if (!uri.startsWith('res://') || uri.slice(6).split('/').some(part => !part || part === '.' || part === '..')) throw Error('Invalid PCK path: ' + uri);
    const path = encoder.encode(uri.slice(6)), data = encoder.encode(files[uri]);
    const digest = SparkMD5.ArrayBuffer.hash(data.buffer, true);
    entries.push({ uri, path, data, digest, offset: cursor });
    cursor = align(cursor + data.length, 16);
  }
  const directoryOffset = cursor;
  const size = cursor + 4 + entries.reduce((size, entry) => size + 40 + align(entry.path.length, 4), 0);
  const pack = new ArrayBuffer(size), bytes = new Uint8Array(pack), view = new DataView(pack);
  [0x43504447, 3, 4, 6, 1, 2].forEach((value, index) => view.setUint32(index * 4, value, true));
  view.setBigUint64(24, 112n, true);
  view.setBigUint64(32, BigInt(directoryOffset), true);
  view.setUint32(cursor, entries.length, true); cursor += 4;
  const packIndex = {};
  for (const entry of entries) {
    bytes.set(entry.data, entry.offset);
    const length = align(entry.path.length, 4);
    view.setUint32(cursor, length, true); cursor += 4;
    bytes.set(entry.path, cursor); cursor += length;
    view.setBigUint64(cursor, BigInt(entry.offset - 112), true); cursor += 8;
    view.setBigUint64(cursor, BigInt(entry.data.length), true); cursor += 8;
    for (let i = 0; i < 16; i++) bytes[cursor++] = entry.digest.charCodeAt(i);
    view.setUint32(cursor, 0, true); cursor += 4;
    packIndex[entry.uri] = { offset: entry.offset, size: entry.data.length };
  }
  return { pack, packIndex };
}
