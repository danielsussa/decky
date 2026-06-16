import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { basename, dirname } from 'node:path'

// FS read/write helpers shared by the file-watcher IPC handlers and (eventually) by the WS
// transport. Pure — no Electron API.

export async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8')
  } catch {
    return null
  }
}

export async function readBinaryFile(path: string): Promise<Uint8Array | null> {
  try {
    const buf = await readFile(path)
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
  } catch {
    return null
  }
}

export async function writeBinaryFileBase64(path: string, base64: string): Promise<boolean> {
  try {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, Buffer.from(base64, 'base64'))
    return true
  } catch (err) {
    console.error('[file-ops] write binary failed:', path, err)
    return false
  }
}

export async function writeTextFile(path: string, content: string): Promise<boolean> {
  try {
    // Safety net for a recurring corruption bug: a stray save has, more than once, written
    // the tail of the built index.html on top of package.json, leaving invalid JSON that
    // bricks the next build (Electron can't read `main` → app won't launch). A renderer save
    // should never put non-JSON into a package.json; refuse it rather than corrupt the file.
    if (basename(path) === 'package.json') {
      try {
        JSON.parse(content)
      } catch {
        console.error('[file-ops] refusing to write invalid JSON to package.json:', path)
        return false
      }
    }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf-8')
    return true
  } catch (err) {
    console.error('[file-ops] write failed:', path, err)
    return false
  }
}
