import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MIN = 60

const tool = (id, name, summary, startedAt) => ({ id, tool: name, summary, startedAt })
const entry = (at, agent, name, summary, isError = false) => ({ at, agent, tool: name, summary, isError })

const usage = (input, output, cacheRead, cacheWrite) => ({ input, output, cacheRead, cacheWrite })

const EXECUTOR_PROMPT = `Implement coupon validation in src/checkout/coupon.service.ts.

- A coupon is valid when it exists, has not expired and the cart total reaches its minimum.
- Percentage coupons cap at the amount in maxDiscount; fixed coupons never take the total below zero.
- Reject a second coupon on the same cart with CouponAlreadyAppliedError.

Cover each rule in coupon.service.spec.ts and run npm test -- coupon until it passes.`

const E2E_PROMPT = `Run the checkout end-to-end suite (npx playwright test checkout.spec.ts) against the local server on port 3000 and report which scenarios fail, with the first assertion that breaks in each one.`

const EXPLORE_PROMPT = `Find every entry point of the checkout flow: routes, controllers and the services they call. List the files with one line each on what they do.`

const EXPLORE_ANSWER = `Checkout starts in src/checkout/checkout.controller.ts:
- POST /checkout → CheckoutController.create, which calls CartService.lock and PricingService.total.
- POST /checkout/:id/confirm → CheckoutController.confirm, which calls PaymentService.charge.
Pricing lives in src/checkout/pricing.service.ts; applyDiscount() is where a coupon would plug in.
No coupon code exists yet.`

const EXECUTOR_ANSWER = `Coupon validation is in place in coupon.service.ts with 9 tests covering expiry, minimum total, the percentage cap, fixed coupons and a second coupon on the same cart. npm test -- coupon passes.`

const executorSteps = [
  [0, 'Read', 'pricing.service.ts'],
  [40, 'Read', 'checkout.controller.ts'],
  [95, 'Write', 'coupon.service.ts'],
  [150, 'Write', 'coupon.service.spec.ts'],
  [210, 'Bash', 'npm test -- coupon', true],
  [255, 'Edit', 'coupon.service.ts'],
  [300, 'Bash', 'npm test -- coupon', true],
  [345, 'Edit', 'coupon.service.ts'],
  [390, 'Bash', 'npm test -- coupon'],
  [430, 'Edit', 'pricing.service.ts'],
  [470, 'Bash', 'npm test -- checkout'],
]

const EXECUTOR_END = 500

export const buildSessions = T => {
  const now = Date.now()
  const at = v => now - (T - v) * 1000

  const executorDone = executorSteps.filter(([start]) => start + 20 <= T)
  const executorRunning = executorSteps.find(([start]) => start <= T && start + 20 > T)
  const executorEnded = T >= EXECUTOR_END
  const lastError = [...executorDone].reverse().findIndex(([, , , isError]) => !isError)
  const consecutiveErrors = lastError === -1 ? executorDone.length : lastError
  const executorRecent = executorDone
    .map(([start, name, summary, isError]) => entry(at(start), 'executor-sonnet', name, summary, isError === true))
    .reverse()

  const executor = {
    id: 'agent-executor',
    type: 'executor-sonnet',
    description: 'Implement coupon validation',
    model: 'claude-sonnet-5-5',
    status: executorEnded ? 'completed' : 'running',
    startedAt: at(-60),
    endedAt: executorEnded ? at(EXECUTOR_END) : null,
    currentTool:
      executorEnded || executorRunning === undefined ? null : tool(`exec-${executorRunning[0]}`, executorRunning[1], executorRunning[2], at(executorRunning[0])),
    toolCount: executorDone.length + (executorRunning === undefined ? 0 : 1) + 6,
    prompt: EXECUTOR_PROMPT,
    answer: executorEnded ? EXECUTOR_ANSWER : null,
    recent: executorRecent,
    lastActivityAt: executorRecent[0]?.at ?? at(-60),
    consecutiveErrors: executorEnded ? 0 : consecutiveErrors,
  }

  const e2eToolStart = -4 * MIN
  const e2e = {
    id: 'agent-e2e',
    type: 'general-purpose',
    description: 'Run the checkout e2e suite',
    model: 'claude-sonnet-5-5',
    status: 'running',
    startedAt: at(-6 * MIN),
    endedAt: null,
    currentTool: tool('e2e-run', 'Bash', 'npx playwright test checkout.spec.ts', at(e2eToolStart)),
    toolCount: 5,
    prompt: E2E_PROMPT,
    answer: null,
    recent: [
      entry(at(-4.5 * MIN), 'general-purpose', 'Bash', 'npm run build'),
      entry(at(-5 * MIN), 'general-purpose', 'Bash', 'curl -s localhost:3000/health'),
      entry(at(-5.3 * MIN), 'general-purpose', 'Read', 'playwright.config.ts'),
      entry(at(-5.6 * MIN), 'general-purpose', 'Glob', 'e2e/**/*.spec.ts'),
    ],
    lastActivityAt: at(e2eToolStart),
    consecutiveErrors: 0,
  }

  const explore = {
    id: 'agent-explore',
    type: 'Explore',
    description: 'Find checkout entry points',
    model: 'claude-haiku-5-5',
    status: 'completed',
    startedAt: at(-14 * MIN),
    endedAt: at(-12.5 * MIN),
    currentTool: null,
    toolCount: 7,
    prompt: EXPLORE_PROMPT,
    answer: EXPLORE_ANSWER,
    recent: [
      entry(at(-12.8 * MIN), 'Explore', 'Read', 'pricing.service.ts'),
      entry(at(-13.1 * MIN), 'Explore', 'Read', 'checkout.controller.ts'),
      entry(at(-13.4 * MIN), 'Explore', 'Grep', 'applyDiscount'),
      entry(at(-13.8 * MIN), 'Explore', 'Glob', 'src/checkout/**/*.ts'),
    ],
    lastActivityAt: at(-12.5 * MIN),
    consecutiveErrors: 0,
  }

  const shopRecent = [
    ...executorRecent.slice(0, 4),
    entry(at(-4.5 * MIN), 'general-purpose', 'Bash', 'npm run build'),
    entry(at(-7 * MIN), 'main', 'Bash', 'npm run lint', true),
    entry(at(-13.4 * MIN), 'Explore', 'Grep', 'applyDiscount'),
    entry(at(-16 * MIN), 'main', 'Edit', 'cart.module.ts'),
    entry(at(-22 * MIN), 'main', 'Bash', 'git status --short'),
    entry(at(-27 * MIN), 'main', 'Read', 'README.md'),
  ].sort((a, b) => b.at - a.at)

  const growth = Math.max(0, T) / 60

  const shopApi = {
    id: 'demo-shop-api',
    project: 'shop-api',
    cwd: '/Users/dev/code/shop-api',
    branch: 'feat/checkout-coupons',
    model: 'claude-opus-5-5',
    startedAt: at(-95 * MIN),
    updatedAt: now,
    isWorking: true,
    turnStartedAt: at(-15 * MIN),
    turnHistory: [
      { startedAt: at(-48 * MIN), endedAt: at(-37 * MIN) },
      { startedAt: at(-31 * MIN), endedAt: at(-24 * MIN) },
    ],
    prompt: 'Add coupon support to the checkout flow and cover it with tests',
    currentTool: null,
    agents: [executor, e2e, explore].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running')),
    usageByModel: {
      'claude-opus-5-5': usage(5200, Math.round(61000 + growth * 900), 3_400_000, 210_000),
      'claude-sonnet-5-5': usage(2100, Math.round(24000 + growth * 1400), 900_000, 80_000),
      'claude-haiku-5-5': usage(800, 3100, 120_000, 14_000),
    },
    contextPercent: 41 + Math.floor(growth),
    costUsd: 6.84 + growth * 0.11,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 38 + Math.floor(growth / 2), resetsAt: new Date(now + (133 * MIN - T) * 1000).toISOString() },
      { kind: 'seven_day', percentUsed: 22, resetsAt: new Date(now + 4 * 24 * 3600 * 1000).toISOString() },
    ],
    turns: 12,
    recent: shopRecent,
  }

  const dataPipeline = {
    id: 'demo-data-pipeline',
    project: 'data-pipeline',
    cwd: '/Users/dev/code/data-pipeline',
    branch: 'fix/march-backfill',
    model: 'claude-opus-5-5',
    startedAt: at(-70 * MIN),
    updatedAt: now,
    isWorking: true,
    turnStartedAt: at(-11 * MIN),
    turnHistory: [{ startedAt: at(-27 * MIN), endedAt: at(-19 * MIN) }],
    prompt: 'Backfill the March events and check the schema drift report',
    currentTool: tool('dp-1', 'Bash', 'python backfill.py --month 2026-03 --dry-run', at(-40)),
    agents: [
      {
        id: 'agent-dp-1',
        type: 'executor-sonnet',
        description: 'Backfill March events',
        model: 'claude-sonnet-5-5',
        status: 'running',
        startedAt: at(-9 * MIN),
        endedAt: null,
        currentTool: tool('dp-2', 'Bash', 'python backfill.py --month 2026-03', at(-30)),
        toolCount: 14,
        prompt: 'Backfill the March 2026 events into the warehouse with backfill.py and confirm the row counts match the source.',
        answer: null,
        recent: [entry(at(-60), 'executor-sonnet', 'Read', 'backfill.py')],
        lastActivityAt: at(-30),
        consecutiveErrors: 0,
      },
    ],
    usageByModel: { 'claude-opus-5-5': usage(6100, 33000, 2_600_000, 140_000), 'claude-sonnet-5-5': usage(2400, 62000, 1_100_000, 90_000) },
    contextPercent: 67,
    costUsd: 4.1,
    rateLimits: [],
    turns: 7,
    recent: [entry(at(-60), 'executor-sonnet', 'Read', 'backfill.py')],
  }

  const marketingSite = {
    id: 'demo-marketing-site',
    project: 'marketing-site',
    cwd: '/Users/dev/code/marketing-site',
    branch: 'main',
    model: 'claude-sonnet-5-5',
    startedAt: at(-50 * MIN),
    updatedAt: now,
    isWorking: false,
    turnStartedAt: null,
    turnHistory: [
      { startedAt: at(-21 * MIN), endedAt: at(-18 * MIN) },
      { startedAt: at(-8 * MIN), endedAt: at(-4 * MIN) },
    ],
    prompt: 'Update the pricing page copy',
    currentTool: null,
    agents: [],
    usageByModel: { 'claude-sonnet-5-5': usage(1300, 9000, 400_000, 30_000) },
    contextPercent: 18,
    costUsd: 0.92,
    rateLimits: [],
    turns: 5,
    recent: [entry(at(-4 * MIN), 'main', 'Edit', 'pricing.mdx')],
  }

  return [shopApi, dataPipeline, marketingSite]
}

export const writeScenario = async (sessionsDir, T) => {
  await mkdir(sessionsDir, { recursive: true })
  await Promise.all(buildSessions(T).map(session => writeFile(join(sessionsDir, `${session.id}.json`), JSON.stringify(session))))
}
