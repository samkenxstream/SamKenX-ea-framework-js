import test from 'ava'
import Redis from 'ioredis'
import { buildAdapterConfig } from '../../src/config'
import { SubscriptionSetFactory } from '../../src/util'
import { ExpiringSortedSet } from '../../src/util/subscription-set/expiring-sorted-set'
import { RedisSubscriptionSet } from '../../src/util/subscription-set/redis-sorted-set'
import { RedisMock } from '../util'

test('subscription set factory (local cache)', async (t) => {
  process.env['CACHE_TYPE'] = 'local'
  const config = buildAdapterConfig({})
  const factory = new SubscriptionSetFactory(config, 'test')
  const subscriptionSet = factory.buildSet('test')
  t.is(subscriptionSet instanceof ExpiringSortedSet, true)
})

test('subscription set factory (redis cache)', async (t) => {
  process.env['CACHE_TYPE'] = 'redis'
  const config = buildAdapterConfig({})
  const factory = new SubscriptionSetFactory(config, 'test', new RedisMock() as unknown as Redis)
  const subscriptionSet = factory.buildSet('test')
  t.is(subscriptionSet instanceof RedisSubscriptionSet, true)
})

test('subscription set factory (redis cache missing client)', async (t) => {
  process.env['CACHE_TYPE'] = 'redis'
  const config = buildAdapterConfig({})
  const factory = new SubscriptionSetFactory(config, 'test')
  try {
    factory.buildSet('test')
    t.fail()
  } catch (e: unknown) {
    t.pass()
  }
})

test('subscription set factory (local cache) max capacity', async (t) => {
  process.env['CACHE_TYPE'] = 'local'
  process.env['CACHE_MAX_SUBSCRIPTIONS'] = '3'
  const config = buildAdapterConfig({})
  const factory = new SubscriptionSetFactory(config, 'test')
  const subscriptionSet = factory.buildSet('hola')

  await subscriptionSet.add('1', 1, 10000)
  await subscriptionSet.add('2', 2, 10000)
  await subscriptionSet.add('3', 3, 10000)
  await subscriptionSet.add('4', 4, 10000)

  const value1 = await subscriptionSet.get('1')
  const value2 = await subscriptionSet.get('2')
  const value3 = await subscriptionSet.get('3')
  const value4 = await subscriptionSet.get('4')

  t.is(value1, undefined)
  t.is(value2, 2)
  t.is(value3, 3)
  t.is(value4, 4)

  const allValues = await subscriptionSet.getAll()
  t.deepEqual(allValues, [2, 3, 4])
})
