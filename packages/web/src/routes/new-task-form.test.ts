// @vitest-environment node

import { describe, expect, it } from 'vitest'

import type {
  BackendCheck,
  RunnerModelCatalogResponse,
  Skill,
  WorkflowDef,
} from '@open-mercato/cezar-api-client'

import {
  buildAutomationTask,
  availableRunners,
  buildCreateRunBody,
  effortOptionsForModel,
  MODELS_BY_RUNNER,
  modelConflictsWithRunner,
  modelsForRunner,
  modelCatalogStatus,
  pushRecentSource,
  resolveEffort,
  resolveModel,
  resolveRunner,
  resolveSource,
  sourceExists,
  startedRunPath,
  type TaskSource,
} from './new-task-form'

const check = (name: BackendCheck['name'], available: boolean): BackendCheck => ({ name, available })

const skill = (name: string, source: Skill['source'] = 'ai'): Skill => ({
  name,
  body: '',
  path: `/skills/${name}.md`,
  source,
})

const workflow = (name: string): WorkflowDef => ({ name, source: 'built-in', steps: [] })

describe('availableRunners (legacy renderChrome rule)', () => {
  it('offers exactly the detected backends, in RUNNERS order', () => {
    const checks = [check('opencode', true), check('git', true), check('claude', true), check('codex', false)]
    expect(availableRunners(checks)).toEqual(['claude', 'opencode'])
  })

  it('falls back to claude when nothing is detected — the form always has a runner', () => {
    expect(availableRunners([])).toEqual(['claude'])
    expect(availableRunners([check('git', true), check('gh', true)])).toEqual(['claude'])
  })
})

describe('resolveRunner (legacy preselection order)', () => {
  it('keeps the user pick while it is installed', () => {
    expect(resolveRunner('codex', ['claude', 'codex'], 'claude')).toBe('codex')
  })

  it('falls back to the configured default when the pick is gone', () => {
    expect(resolveRunner('opencode', ['claude', 'codex'], 'codex')).toBe('codex')
  })

  it('falls back to the first available when even the default is missing', () => {
    expect(resolveRunner(null, ['codex', 'opencode'], 'claude')).toBe('codex')
  })
})

describe('model option resolution', () => {
  it('every runner leads with auto (empty id — no model flag sent)', () => {
    for (const models of Object.values(MODELS_BY_RUNNER)) {
      expect(models[0]).toMatchObject({ id: '', label: 'auto' })
    }
  })

  it('claude: usable aliases when discovery is unavailable', () => {
    expect(modelsForRunner('claude').map((m) => m.id)).toEqual([
      '', 'opus', 'sonnet', 'haiku',
    ])
  })

  it('codex: auto plus host-discovered and custom ids', () => {
    const catalog = { runner: 'codex' as const, models: [{ id: 'gpt-future', label: 'Future', description: 'New' }], source: 'live' as const, stale: false }
    expect(modelsForRunner('codex', catalog, ['legacy-id']).map((m) => m.id)).toEqual(['', 'gpt-future', 'legacy-id'])
    expect(modelsForRunner('codex', catalog, ['legacy-id']).at(-1)?.desc).toBe('Custom or legacy model')
  })

  it('reports stale and unavailable Codex catalogs without exposing reasons', () => {
    expect(modelCatalogStatus('codex', { runner: 'codex', models: [], source: 'cache', stale: true, reason: 'raw' })).toBe('Using cached Codex model list')
    expect(modelCatalogStatus('codex', { runner: 'codex', models: [], source: 'unavailable', stale: false, reason: 'raw' })).toBe('Latest Codex models unavailable')
    expect(modelCatalogStatus('claude', undefined, true)).toBe('Latest Claude models unavailable')
  })

  it('opencode: auto alone until the host catalog answers (#794)', () => {
    expect(modelsForRunner('opencode').map((m) => m.id)).toEqual([''])
    expect(
      modelsForRunner('opencode', {
        runner: 'opencode',
        models: [
          { id: 'openai/gpt-5.4', label: 'openai/gpt-5.4', description: 'via openai' },
          { id: 'anthropic/claude-sonnet-5', label: 'anthropic/claude-sonnet-5', description: 'via anthropic' },
        ],
        source: 'live',
        stale: false,
      }).map((m) => m.id),
    ).toEqual(['', 'openai/gpt-5.4', 'anthropic/claude-sonnet-5'])
  })

  it('a pinned OpenCode id the host no longer offers stays selectable', () => {
    expect(
      modelsForRunner(
        'opencode',
        { runner: 'opencode', models: [], source: 'unavailable', stale: false },
        ['openai/gpt-5.1'],
      ).map((m) => m.id),
    ).toEqual(['', 'openai/gpt-5.1'])
  })

  it('never reads a provider-spanning runner’s preset as another runner’s exclusive model', () => {
    // pi and OpenCode both pick with `provider/model` and span every configured provider.
    // Counting either's list as evidence of "belongs to another runner" would silently strip
    // those ids from the other picker's catalog — the #794 bug, reintroduced through the back door.
    for (const model of ['openai/gpt-5.1', 'anthropic/claude-sonnet-5']) {
      expect(modelConflictsWithRunner(model, 'opencode')).toBe(false)
      expect(modelConflictsWithRunner(model, 'pi')).toBe(false)
    }
    // The guard it must NOT lose: a bare id that is unmistakably one single-provider runner's.
    expect(modelConflictsWithRunner('opus', 'codex')).toBe(true)
  })

  it('pi: auto alone until the host catalog answers', () => {
    expect(modelsForRunner('pi').map((m) => m.id)).toEqual([''])
    expect(
      modelsForRunner('pi', {
        runner: 'pi',
        models: [{ id: 'xai/grok-4.6', label: 'grok-4.6', description: 'via xai' }],
        source: 'live',
        stale: false,
      }).map((m) => m.id),
    ).toEqual(['', 'xai/grok-4.6'])
  })

  it('names the runner whose catalog is stale or unavailable', () => {
    expect(
      modelCatalogStatus('opencode', { runner: 'opencode', models: [], source: 'cache', stale: true, reason: 'raw' }),
    ).toBe('Using cached OpenCode model list')
    expect(modelCatalogStatus('opencode', undefined, true)).toBe('Latest OpenCode models unavailable')
    expect(
      modelCatalogStatus('pi', { runner: 'pi', models: [], source: 'cache', stale: true, reason: 'raw' }),
    ).toBe('Using cached Pi model list')
    expect(modelCatalogStatus('pi', undefined, true)).toBe('Latest Pi models unavailable')
  })

  it('resolveModel keeps known picks and arbitrary native model pins', () => {
    expect(resolveModel('opus', 'claude')).toBe('opus')
    expect(resolveModel('custom-codex-id', 'codex')).toBe('custom-codex-id')
    expect(resolveModel(null, 'opencode', { opencode: 'provider/custom-model' })).toBe('provider/custom-model')
    expect(resolveModel(null, 'claude')).toBe('')
  })

  it('resolveModel falls back to the Settings → Agents per-runner preset (R6 1.5)', () => {
    const defaults = { claude: 'opus', codex: 'not-a-preset' }
    // Untouched pill: the configured preset for THIS runner preselects.
    expect(resolveModel(null, 'claude', defaults)).toBe('opus')
    // An explicit pick — including explicitly picking auto ('') — beats the preset.
    expect(resolveModel('sonnet', 'claude', defaults)).toBe('sonnet')
    expect(resolveModel('', 'claude', defaults)).toBe('')
    // Configured custom ids remain representable even when discovery is unavailable.
    expect(resolveModel(null, 'codex', defaults)).toBe('not-a-preset')
    // No preset for the runner → auto, exactly as before.
    expect(resolveModel(null, 'opencode', defaults)).toBe('')
  })
})

describe('effort option resolution (#55)', () => {
  const catalog: RunnerModelCatalogResponse = {
    runner: 'opencode',
    models: [
      {
        id: 'openai/gpt-5.4',
        label: 'GPT 5.4',
        description: '',
        effortLevels: ['low', 'medium', 'high', 'xhigh'],
      },
      {
        id: 'zai/glm-5.3',
        label: 'GLM 5.3',
        description: '',
        effortLevels: ['max', 'low', 'high'],
      },
      { id: 'openai/legacy', label: 'Legacy', description: '' },
      { id: 'openai/empty', label: 'Empty', description: '', effortLevels: [] },
    ],
    source: 'live',
    stale: false,
  }
  const full = ['', 'low', 'medium', 'high', 'xhigh', 'max']

  it('offers auto plus exactly the selected model levels in backend order', () => {
    expect(effortOptionsForModel('opencode', 'zai/glm-5.3', catalog).map((option) => option.value))
      .toEqual(['', 'max', 'low', 'high'])
    expect(effortOptionsForModel('opencode', 'openai/gpt-5.4', catalog).map((option) => option.value))
      .toEqual(['', 'low', 'medium', 'high', 'xhigh'])
  })

  it('resets an unsupported effort to auto and keeps a supported effort', () => {
    const options = effortOptionsForModel('opencode', 'zai/glm-5.3', catalog)
    expect(resolveEffort('medium', options)).toBe('')
    expect(resolveEffort('high', options)).toBe('high')
    expect(resolveEffort(null, options)).toBe('')
  })

  it('falls back per model for static runners, old metadata, custom ids, and missing catalogs', () => {
    expect(effortOptionsForModel('claude', 'opus').map((option) => option.value)).toEqual(full)
    expect(effortOptionsForModel('codex', 'gpt-future').map((option) => option.value)).toEqual(full)
    expect(effortOptionsForModel('opencode', 'openai/legacy', catalog).map((option) => option.value)).toEqual(full)
    expect(effortOptionsForModel('opencode', 'openai/empty', catalog).map((option) => option.value)).toEqual(full)
    expect(effortOptionsForModel('opencode', 'provider/custom', catalog).map((option) => option.value)).toEqual(full)
    expect(effortOptionsForModel('pi', 'xai/grok')).toHaveLength(full.length)
  })

  it('does not let one model metadata entry affect another', () => {
    expect(effortOptionsForModel('opencode', 'zai/glm-5.3', catalog).map((option) => option.value))
      .not.toContain('medium')
    expect(effortOptionsForModel('opencode', 'openai/legacy', catalog).map((option) => option.value))
      .toContain('medium')
  })
})

describe('resolveSource (the draft pick, validated — no cold default)', () => {
  const skills = [skill('om-fix'), skill('deploy', 'global')]
  const workflows = [workflow('quick-task'), workflow('fix-and-verify')]

  it('keeps a pick the catalog still has', () => {
    expect(resolveSource({ source: 'workflow', ref: 'fix-and-verify' }, skills, workflows))
      .toEqual({ source: 'workflow', ref: 'fix-and-verify' })
    expect(resolveSource({ source: 'skill', ref: 'om-fix' }, skills, workflows))
      .toEqual({ source: 'skill', ref: 'om-fix' })
  })

  it('resolves to NOTHING when there is no pick, or the pick is gone', () => {
    // The empty composer state: `/new` opens here, and nothing preselects it away.
    expect(resolveSource(null, skills, workflows)).toBeNull()
    expect(resolveSource(undefined, skills, workflows)).toBeNull()
    // A skill deleted since it was drafted must not stay in the pill.
    expect(resolveSource({ source: 'skill', ref: 'gone' }, skills, workflows)).toBeNull()
    expect(resolveSource({ source: 'workflow', ref: 'gone' }, skills, workflows)).toBeNull()
    // An empty catalog is the same answer, with no quick-task/first-skill fallback left.
    expect(resolveSource({ source: 'skill', ref: 'om-fix' }, [], [])).toBeNull()
  })

  it('sourceExists checks the matching catalog only', () => {
    // A workflow name does not validate a skill ref, and vice versa.
    expect(sourceExists({ source: 'skill', ref: 'quick-task' }, skills, workflows)).toBe(false)
    expect(sourceExists({ source: 'workflow', ref: 'om-fix' }, skills, workflows)).toBe(false)
  })
})

describe('buildCreateRunBody — the exact POST /api/v1/runs payloads legacy sends', () => {
  it('workflow source → { workflow, task }, defaults omitted', () => {
    const body = buildCreateRunBody({
      task: 'do the thing',
      source: { source: 'workflow', ref: 'quick-task' },
      model: '',
      runner: 'claude',
      defaultRunner: 'claude',
      variants: 1,
      images: [],
    })
    expect(body).toEqual({
      task: 'do the thing',
      workflow: 'quick-task',
      model: undefined,
      runner: undefined,
      variants: undefined,
      images: undefined,
    })
    // What actually goes over the wire: the undefineds vanish.
    expect(JSON.parse(JSON.stringify(body))).toEqual({ task: 'do the thing', workflow: 'quick-task' })
  })

  it('sends a pinned effort and omits auto (#45)', () => {
    const pinned = buildCreateRunBody({
      task: 'hard',
      source: { source: 'workflow', ref: 'quick-task' },
      model: '',
      effort: 'xhigh',
      runner: 'claude',
      defaultRunner: 'claude',
      variants: 1,
      images: [],
    })
    expect(JSON.parse(JSON.stringify(pinned)).effort).toBe('xhigh')

    const auto = buildCreateRunBody({
      task: 'hard',
      source: { source: 'workflow', ref: 'quick-task' },
      model: '',
      effort: '',
      runner: 'claude',
      defaultRunner: 'claude',
      variants: 1,
      images: [],
    })
    expect(JSON.parse(JSON.stringify(auto)).effort).toBeUndefined()

    const locked = buildCreateRunBody({
      task: 'hard',
      source: { source: 'workflow', ref: 'quick-task' },
      model: 'opus',
      effort: 'max',
      modelsLocked: true,
      runner: 'claude',
      defaultRunner: 'claude',
      variants: 1,
      images: [],
    })
    expect(locked.effort).toBeUndefined()
  })

  it('NO source → the built-in quick-task, because the route demands workflow XOR steps', () => {
    const body = buildCreateRunBody({
      task: 'just do it',
      source: null,
      model: '',
      runner: 'claude',
      defaultRunner: 'claude',
      variants: 1,
      images: [],
    })
    // Byte-identical to picking quick-task by hand — which is why the picker stopped offering
    // both. `POST /runs` 400s on a body carrying neither key, so "nothing" cannot go out bare.
    expect(JSON.parse(JSON.stringify(body))).toEqual({ task: 'just do it', workflow: 'quick-task' })
  })

  it('skill source → the one-step inline chain (spec 008: same shape as inbox/bookmarklet)', () => {
    const body = buildCreateRunBody({
      task: 'fix the flake',
      source: { source: 'skill', ref: 'om-fix' },
      model: 'sonnet',
      runner: 'claude',
      defaultRunner: 'codex',
      variants: 1,
      images: [],
    })
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      task: 'fix the flake',
      steps: [{ id: 'task', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' }],
      model: 'sonnet',
      runner: 'claude',
    })
  })

  it('keeps a locked native default visible while omitting it from direct and automation requests', () => {
    const model = resolveModel(null, 'claude', { claude: 'native-sonnet' })
    expect(model).toBe('native-sonnet')

    const opts = {
      task: 'use the native model',
      source: { source: 'workflow' as const, ref: 'quick-task' },
      model,
      modelsLocked: true,
      runner: 'claude' as const,
      defaultRunner: 'claude' as const,
      variants: 1,
      images: [],
    }
    expect(buildCreateRunBody(opts).model).toBeUndefined()
    expect(buildAutomationTask(opts).model).toBeUndefined()
  })

  it('omits runner when the chosen connected runner equals the server default', () => {
    const body = buildCreateRunBody({
      task: 't', source: { source: 'workflow', ref: 'quick-task' }, model: '',
      runner: 'codex', defaultRunner: 'codex', variants: 1, images: [],
    })
    expect(body.runner).toBeUndefined()
  })

  it('keeps an explicit runner pick even when it equals the default snapshot', () => {
    const body = buildCreateRunBody({
      task: 't', source: { source: 'workflow', ref: 'quick-task' }, model: '',
      runner: 'codex', runnerExplicit: true, defaultRunner: 'codex', variants: 1, images: [],
    })
    expect(body.runner).toBe('codex')
  })

  it('sends a connected fallback that differs from the server default, even when it is the only choice', () => {
    const body = buildCreateRunBody({
      task: 't', source: { source: 'workflow', ref: 'quick-task' }, model: '',
      runner: 'codex', defaultRunner: 'claude', variants: 1, images: [],
    })
    expect(body.runner).toBe('codex')
  })

  it('worktree=false is sent only for a single run; on/variants keep it implicit', () => {
    const off = buildCreateRunBody({
      task: 't', source: { source: 'skill', ref: 'om-review' }, model: '',
      runner: 'claude', defaultRunner: 'claude', variants: 1, images: [], worktree: false,
    })
    expect(off.worktree).toBe(false)
    // Default (on) never sends the flag.
    const on = buildCreateRunBody({
      task: 't', source: { source: 'skill', ref: 'om-review' }, model: '',
      runner: 'claude', defaultRunner: 'claude', variants: 1, images: [], worktree: true,
    })
    expect(on.worktree).toBeUndefined()
    // Variants always isolate — worktree=false is ignored.
    const variant = buildCreateRunBody({
      task: 't', source: { source: 'skill', ref: 'om-review' }, model: '',
      runner: 'claude', defaultRunner: 'claude', variants: 2, images: [], worktree: false,
    })
    expect(variant.worktree).toBeUndefined()
  })

  it('generateFollowups=false is sent only when follow-up generation is disabled', () => {
    const base = {
      task: 't', source: { source: 'skill' as const, ref: 'om-review' }, model: '',
      runner: 'claude' as const, defaultRunner: 'claude' as const, variants: 1, images: [],
    }
    expect(buildCreateRunBody({ ...base, generateFollowups: false }).generateFollowups).toBe(false)
    expect(buildCreateRunBody({ ...base, generateFollowups: true }).generateFollowups).toBeUndefined()
    expect(buildCreateRunBody(base).generateFollowups).toBeUndefined()
  })

  it('variants > 1 and images ride along; ×1 and no images are omitted', () => {
    const body = buildCreateRunBody({
      task: 't', source: { source: 'workflow', ref: 'quick-task' }, model: '',
      runner: 'claude', defaultRunner: 'claude', variants: 3,
      images: [{ mediaType: 'image/png', data: 'aGk=' }],
    })
    expect(body.variants).toBe(3)
    expect(body.images).toEqual([{ mediaType: 'image/png', data: 'aGk=' }])
  })
})

describe('startedRunPath (legacy handleStarted: select the first run)', () => {
  const record = { id: 'r1' } as never

  it('×1: the created run’s thread', () => {
    expect(startedRunPath(record)).toBe('/tasks/r1')
  })

  it('×2/×3: the FIRST variant’s thread', () => {
    expect(startedRunPath({ runs: [{ id: 'v-a' }, { id: 'v-b' }] as never })).toBe('/tasks/v-a')
  })
})

describe('pushRecentSource (recency, #picker)', () => {
  const s = (ref: string, source: TaskSource['source'] = 'skill'): TaskSource => ({ source, ref })

  it('prepends newest and dedups the same source+ref', () => {
    const after = pushRecentSource([s('a'), s('b')], s('b'))
    expect(after).toEqual([s('b'), s('a')])
  })

  it('treats skill and workflow with the same ref as distinct', () => {
    const after = pushRecentSource([s('x', 'skill')], s('x', 'workflow'))
    expect(after).toEqual([s('x', 'workflow'), s('x', 'skill')])
  })

  it('caps the list length', () => {
    const seed = Array.from({ length: 24 }, (_, i) => s(`k${i}`))
    const after = pushRecentSource(seed, s('new'), 24)
    expect(after).toHaveLength(24)
    expect(after[0]).toEqual(s('new'))
    expect(after.at(-1)).toEqual(s('k22')) // k23 fell off the end
  })

  it('handles an undefined starting list', () => {
    expect(pushRecentSource(undefined, s('a'))).toEqual([s('a')])
  })
})

describe('buildAutomationTask', () => {
  it('uses the New task serializer while dropping one-shot transport fields', () => {
    expect(buildAutomationTask({
      task: 'Review {{github.url}}',
      source: { source: 'skill', ref: 'om-code-review' },
      model: 'opus',
      runner: 'claude',
      defaultRunner: 'claude',
      variants: 2,
      images: [{ mediaType: 'image/png', data: 'ignored' }],
      autonomous: true,
      todoId: 'ignored',
    })).toEqual({
      prompt: 'Review {{github.url}}',
      steps: [{ id: 'task', name: 'om-code-review', skill: 'om-code-review', prompt: '{{task}}' }],
      model: 'opus',
      variants: 2,
      autonomous: true,
    })
  })
})

 describe('Claude host discovery (#89)', () => {
  it('replaces suggestions with host rows while retaining explicit pins', () => {
    const catalog = { runner: 'claude' as const, models: [{ id: 'opus[1m]', label: 'Host Opus', description: 'Host choice' }], source: 'live' as const, stale: false }
    expect(modelsForRunner('claude', catalog, ['claude-opus-4-8', 'private-model']).map(m => m.id)).toEqual(['', 'opus[1m]', 'claude-opus-4-8', 'private-model'])
    expect(resolveModel('private-model', 'claude', undefined, catalog)).toBe('private-model')
    expect(modelCatalogStatus('claude', { ...catalog, source: 'cache', stale: true })).toBe('Using cached Claude model list')
  })
  it('retains the cross-runner guard for retired dated suggestions', () => {
    expect(modelConflictsWithRunner('claude-opus-4-8', 'codex')).toBe(true)
  })
 })

it('reports discovery in progress without masking cached feedback', () => {
  expect(modelCatalogStatus('claude', undefined, false, true)).toBe('Loading Claude models…')
  expect(modelCatalogStatus('claude', { runner: 'claude', models: [], source: 'cache', stale: true }, false, true)).toBe('Using cached Claude model list')
  expect(modelCatalogStatus('claude', undefined, false, false)).toBeUndefined()
})
