import { describe, expect, it } from 'bun:test'
import type { Message } from 'src/types/message.js'
import {
  decideRecallPolicy,
  decideRecallPolicyForText,
  normalizeRecallPolicyResult,
  resolveRecallPolicyGate,
} from './recallPolicy.js'

function userMessage(content: string, overrides: Partial<Message> = {}): Message {
  return {
    type: 'user',
    message: { content },
    ...overrides,
  } as Message
}

describe('recallPolicy', () => {
  it('routes explicit memory ignore requests to SKIP_RECALL', () => {
    expect(decideRecallPolicyForText('不要参考我之前的偏好')).toMatchObject({
      policy: 'SKIP_RECALL',
    })
  })

  it('routes explicit memory references to SYNC_RECALL', () => {
    expect(
      decideRecallPolicyForText('你还记得我之前说测试不要用 Mock 吗'),
    ).toMatchObject({
      policy: 'SYNC_RECALL',
    })
    expect(decideRecallPolicyForText('按上次那个方案继续')).toMatchObject({
      policy: 'SYNC_RECALL',
    })
  })

  it('routes ordinary or uncertain requests to ASYNC_RECALL', () => {
    expect(decideRecallPolicyForText('帮我解释这个函数')).toMatchObject({
      policy: 'ASYNC_RECALL',
    })
  })

  it('only uses the latest real user message', async () => {
    const result = await decideRecallPolicy({
      messages: [
        userMessage('你还记得我之前说测试不要用 Mock 吗', {
          isMeta: true,
        }),
        userMessage('不要参考我之前的偏好', {
          toolUseResult: {},
        }),
        userMessage('帮我解释这个函数'),
      ],
      signal: new AbortController().signal,
    })

    expect(result).toMatchObject({ policy: 'ASYNC_RECALL' })
  })

  it('falls back to ASYNC_RECALL for aborts, errors, timeouts, and invalid gate output', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      decideRecallPolicy({
        messages: [userMessage('按上次那个方案继续')],
        signal: controller.signal,
      }),
    ).resolves.toMatchObject({ policy: 'ASYNC_RECALL' })

    expect(normalizeRecallPolicyResult({ policy: 'NOPE', reason: 'bad' }))
      .toMatchObject({
        policy: 'ASYNC_RECALL',
      })

    await expect(
      resolveRecallPolicyGate(Promise.reject(new Error('boom'))),
    ).resolves.toMatchObject({ policy: 'ASYNC_RECALL' })

    await expect(
      resolveRecallPolicyGate(new Promise(() => {}), { timeoutMs: 1 }),
    ).resolves.toMatchObject({
      policy: 'ASYNC_RECALL',
      timedOut: true,
    })
  })
})
