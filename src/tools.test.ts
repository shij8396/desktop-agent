import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { executeTool, CORE_TOOLS, FILE_TOOLS, TOOLS } from './tools.js'

describe('Tool definitions', () => {
  it('should have 4 core tools', () => {
    expect(CORE_TOOLS).toHaveLength(4)
    const names = CORE_TOOLS.map(t => t.name)
    expect(names).toEqual(['web_search', 'kb_search', 'calculate', 'get_datetime'])
  })

  it('should have 9 file tools', () => {
    expect(FILE_TOOLS).toHaveLength(9)
    expect(FILE_TOOLS.map(t => t.name)).not.toContain('exec_command')
  })

  it('should combine to 13 total tools', () => {
    expect(TOOLS).toHaveLength(13)
  })

  it('should have required fields on every tool', () => {
    for (const tool of TOOLS) {
      expect(tool.name).toBeTruthy()
      expect(tool.description).toBeTruthy()
      expect(tool.input_schema).toBeTruthy()
      expect(tool.input_schema.type).toBe('object')
    }
  })
})

describe('calculate tool', () => {
  it('should evaluate simple arithmetic', async () => {
    const result = await executeTool('calculate', { expression: '2 + 3' })
    expect(result).toBe('Result: 5')
  })

  it('should evaluate Math functions', async () => {
    const result = await executeTool('calculate', { expression: 'Math.sqrt(16)' })
    expect(result).toBe('Result: 4')
  })

  it('should handle division', async () => {
    const result = await executeTool('calculate', { expression: '10 / 3' })
    expect(result).toContain('Result: 3.33')
  })

  it('should reject invalid expressions', async () => {
    const result = await executeTool('calculate', { expression: 'process.exit(1)' })
    expect(result).toContain('Error')
  })

  it('should reject disallowed Math functions', async () => {
    const result = await executeTool('calculate', { expression: 'Math.random()' })
    // Math.random should be replaced with undefined
    expect(result).toContain('Error')
  })
})

describe('get_datetime tool', () => {
  it('should return current time info', async () => {
    const result = await executeTool('get_datetime', {})
    expect(result).toContain('Current time:')
    expect(result).toContain('Date:')
    expect(result).toContain('Day:')
  })
})

describe('list_files tool', () => {
  it('should list directory contents', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'))
    await fs.writeFile(path.join(tmpDir, 'test.txt'), 'hello')
    await fs.mkdir(path.join(tmpDir, 'subdir'))

    const result = await executeTool('list_files', { path: tmpDir })
    expect(result).toContain('test.txt')
    expect(result).toContain('[DIR]')
    expect(result).toContain('[FILE]')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should reject blocked paths', async () => {
    const result = await executeTool('list_files', { path: 'C:\\Windows\\System32' })
    expect(result).toContain('Access denied')
  })
})

describe('read_file tool', () => {
  it('should read a text file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'))
    const filePath = path.join(tmpDir, 'hello.txt')
    await fs.writeFile(filePath, 'Hello World')

    const result = await executeTool('read_file', { path: filePath })
    expect(result).toBe('Hello World')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should reject binary file types', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'))
    const filePath = path.join(tmpDir, 'test.exe')
    await fs.writeFile(filePath, 'MZ binary content')

    const result = await executeTool('read_file', { path: filePath })
    expect(result).toContain('Cannot read binary file')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should reject blocked paths', async () => {
    const result = await executeTool('read_file', { path: 'C:\\Windows\\System32\\cmd.exe' })
    expect(result).toContain('Access denied')
  })
})

describe('write_file tool', () => {
  it('should write content to a file', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'))
    const filePath = path.join(tmpDir, 'output.txt')

    const result = await executeTool('write_file', { path: filePath, content: 'test data' })
    expect(result).toContain('Successfully wrote')

    const content = await fs.readFile(filePath, 'utf-8')
    expect(content).toBe('test data')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})

describe('delete_file tool', () => {
  it('should delete an empty directory', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'))
    const emptyDir = path.join(tmpDir, 'empty')
    await fs.mkdir(emptyDir)

    const result = await executeTool('delete_file', { path: emptyDir })
    expect(result).toContain('Deleted empty directory')
    await expect(fs.stat(emptyDir)).rejects.toThrow()

    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})

describe('exec_command tool', () => {
  it('should still block shell chaining when called directly', async () => {
    const result = await executeTool('exec_command', { command: 'echo hello && echo unsafe' })
    expect(result).toContain('blocked')
  })
})

describe('find_files tool', () => {
  it('should find files by pattern', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tool-test-'))
    await fs.writeFile(path.join(tmpDir, 'a.txt'), 'a')
    await fs.writeFile(path.join(tmpDir, 'b.md'), 'b')
    await fs.writeFile(path.join(tmpDir, 'c.txt'), 'c')

    const result = await executeTool('find_files', { directory: tmpDir, pattern: '*.txt' })
    expect(result).toContain('a.txt')
    expect(result).toContain('c.txt')
    expect(result).not.toContain('b.md')

    await fs.rm(tmpDir, { recursive: true, force: true })
  })
})

describe('unknown tool', () => {
  it('should return error for unknown tool name', async () => {
    const result = await executeTool('nonexistent_tool', {})
    expect(result).toContain('Unknown tool')
  })
})
