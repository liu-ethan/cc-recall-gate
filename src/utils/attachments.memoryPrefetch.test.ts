import { describe, expect, it } from 'bun:test'
import {
  consumeRelevantMemoryPrefetch,
  type Attachment,
  type MemoryPrefetch,
} from './attachments.js'
import { createFileStateCacheWithSizeLimit } from './fileStateCache.js'

function relevantMemories(count: number): Attachment[] {
  return [
    {
      type: 'relevant_memories',
      memories: Array.from({ length: count }, (_, index) => ({
        path: `/memory/${index + 1}.md`,
        content: `memory ${index + 1}`,
        mtimeMs: index + 1,
      })),
    },
  ]
}

function memoryPrefetch(
  attachments: Attachment[],
  overrides: Partial<MemoryPrefetch> = {},
): MemoryPrefetch {
  const handle: MemoryPrefetch = {
    promise: Promise.resolve(attachments),
    settledAt: Date.now(),
    consumedOnIteration: -1,
    skipped: false,
    abort() {
      handle.skipped = true
    },
    [Symbol.dispose]() {},
    ...overrides,
  }
  return handle
}

describe('consumeRelevantMemoryPrefetch', () => {
  it('consumes all settled memories when no sync limit is requested', async () => {
    const readFileState = createFileStateCacheWithSizeLimit(100)
    const prefetch = memoryPrefetch(relevantMemories(3))

    const attachments = await consumeRelevantMemoryPrefetch(
      prefetch,
      readFileState,
      1,
    )

    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      type: 'relevant_memories',
      memories: [
        { path: '/memory/1.md' },
        { path: '/memory/2.md' },
        { path: '/memory/3.md' },
      ],
    })
    expect(prefetch.consumedOnIteration).toBe(1)
  })

  it('limits SYNC_RECALL consumption to the top memories', async () => {
    const readFileState = createFileStateCacheWithSizeLimit(100)
    const prefetch = memoryPrefetch(relevantMemories(5))

    const attachments = await consumeRelevantMemoryPrefetch(
      prefetch,
      readFileState,
      0,
      { limitMemories: 2 },
    )

    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      type: 'relevant_memories',
      memories: [{ path: '/memory/1.md' }, { path: '/memory/2.md' }],
    })
    expect(prefetch.consumedOnIteration).toBe(0)
    expect(readFileState.has('/memory/1.md')).toBe(true)
    expect(readFileState.has('/memory/2.md')).toBe(true)
    expect(readFileState.has('/memory/3.md')).toBe(false)
  })

  it('does not inject memories already present in readFileState', async () => {
    const readFileState = createFileStateCacheWithSizeLimit(100)
    readFileState.set('/memory/1.md', {
      content: 'already read',
      timestamp: 1,
      offset: undefined,
      limit: undefined,
    })
    const prefetch = memoryPrefetch(relevantMemories(1))

    const attachments = await consumeRelevantMemoryPrefetch(
      prefetch,
      readFileState,
      0,
      { limitMemories: 2 },
    )

    expect(attachments).toEqual([])
    expect(prefetch.consumedOnIteration).toBe(0)
  })

  it('does not consume skipped or already consumed prefetch handles', async () => {
    const readFileState = createFileStateCacheWithSizeLimit(100)
    const skipped = memoryPrefetch(relevantMemories(1), { skipped: true })
    const consumed = memoryPrefetch(relevantMemories(1), {
      consumedOnIteration: 0,
    })

    await expect(
      consumeRelevantMemoryPrefetch(skipped, readFileState, 1),
    ).resolves.toEqual([])
    await expect(
      consumeRelevantMemoryPrefetch(consumed, readFileState, 1),
    ).resolves.toEqual([])
    expect(skipped.consumedOnIteration).toBe(-1)
    expect(consumed.consumedOnIteration).toBe(0)
  })

  it('times out sync memory consumption without marking the prefetch consumed', async () => {
    const readFileState = createFileStateCacheWithSizeLimit(100)
    const prefetch = memoryPrefetch([], {
      promise: new Promise(() => {}),
      settledAt: null,
    })

    const attachments = await consumeRelevantMemoryPrefetch(
      prefetch,
      readFileState,
      0,
      { limitMemories: 2, timeoutMs: 1 },
    )

    expect(attachments).toEqual([])
    expect(prefetch.consumedOnIteration).toBe(-1)
  })

  it('swallows rejected memory prefetch promises and continues', async () => {
    const readFileState = createFileStateCacheWithSizeLimit(100)
    const prefetch = memoryPrefetch([], {
      promise: Promise.reject(new Error('prefetch failed')),
    })

    const attachments = await consumeRelevantMemoryPrefetch(
      prefetch,
      readFileState,
      0,
      { limitMemories: 2 },
    )

    expect(attachments).toEqual([])
    expect(prefetch.consumedOnIteration).toBe(0)
  })
})
