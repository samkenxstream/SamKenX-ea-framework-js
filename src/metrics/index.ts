import * as client from 'prom-client'
import { HttpRequestType, requestDurationBuckets } from './constants'
import { AdapterRequest, makeLogger } from '../util'
import { AdapterConfig } from '../config'
import fastify, { FastifyReply, HookHandlerDoneFunction } from 'fastify'
import { join } from 'path'
import { AdapterError } from '../validation/error'
import { getMTLSOptions, httpsOptions } from '../index'

const logger = makeLogger('Metrics')

export function setupMetricsServer(name: string, config: AdapterConfig) {
  const mTLSOptions: httpsOptions | Record<string, unknown> = getMTLSOptions(config)
  const metricsApp = fastify({
    ...mTLSOptions,
    logger: false,
  })
  const metricsPort = config.METRICS_PORT
  const endpoint = config.METRICS_USE_BASE_URL ? join(config.BASE_URL, 'metrics') : '/metrics'
  const eaHost = config.EA_HOST
  logger.info(`Metrics endpoint: http://${eaHost}:${metricsPort}${endpoint}`)

  setupMetrics(name)

  metricsApp.get(endpoint, async (_, res) => {
    res.type('txt')
    res.send(await client.register.metrics())
  })

  return metricsApp
}

export const setupMetrics = (name: string): void => {
  client.collectDefaultMetrics()
  client.register.setDefaultLabels({
    app_name: name || 'N/A',
    app_version: process.env['npm_package_version'],
  })
}

/**
 * Builds metrics middleware that records end to end EA response times
 * and count of requests
 *
 * @returns the cache middleware function
 */
export const buildMetricsMiddleware = (
  req: AdapterRequest,
  res: FastifyReply,
  done: HookHandlerDoneFunction,
) => {
  // The request context can technically be empty if the input validation failed
  const feedId = req.requestContext?.meta?.metrics?.feedId || 'N/A'
  const labels = buildHttpRequestMetricsLabel(
    feedId,
    req.requestContext?.meta?.error,
    req.requestContext?.meta?.metrics?.cacheHit,
  )

  // Record number of requests sent to EA
  metrics.get('httpRequestsTotal').labels(labels).inc()

  // Record response time of request through entire EA
  metrics.get('httpRequestDurationSeconds').observe(res.getResponseTime() / 1000)
  logger.debug(`Response time for ${feedId}: ${res.getResponseTime()}ms`)
  done()
}

export class Metrics<T extends Record<string, unknown>> {
  // Stores the method to register metrics to be used later on initialization
  private metricsDefinition: () => T
  private metrics?: T

  constructor(metricsDefinition: () => T) {
    this.metricsDefinition = metricsDefinition
  }

  // Register metrics and set the metrics map for use during runtime
  // Ideally called on adapter startup to avoid metrics conflicts
  initialize() {
    if (!this.metrics) {
      this.metrics = this.metricsDefinition()
    }
  }

  get<K extends keyof T>(name: K): T[K] {
    const metric = this.metrics?.[name]
    if (!metric) {
      throw new Error(`Metric "${name as string}" was not initialized before use`)
    }
    return metric
  }
}

const httpRequestsTotalLabels = [
  'method',
  'status_code',
  'retry',
  'type',
  'is_cache_warming',
  'feed_id',
  'provider_status_code',
] as const

const cacheMetricsLabels = [
  'feed_id',
  'participant_id',
  'cache_type',
  'is_from_ws',
  'experimental',
] as const

export const buildHttpRequestMetricsLabel = (
  feedId: string,
  error?: AdapterError | Error,
  cacheHit?: boolean,
): Record<string, string | number | undefined> => {
  const labels = {} as Record<typeof httpRequestsTotalLabels[number], string | number | undefined>
  labels.method = 'POST'
  labels.feed_id = feedId
  if (error instanceof AdapterError) {
    // If error present and an instace of AdapterError, build label from error info
    labels.type = error?.metricsLabel || HttpRequestType.ADAPTER_ERROR
    labels.status_code = error?.statusCode
    labels.provider_status_code = error?.providerStatusCode
  } else if (error instanceof Error) {
    // If error present and not instance of generic Error, unexpected failure occurred
    labels.type = HttpRequestType.ADAPTER_ERROR
    labels.status_code = 500
  } else {
    // If no error present, request went as expected
    labels.status_code = 200
    if (cacheHit) {
      labels.type = HttpRequestType.CACHE_HIT
    } else {
      labels.type = HttpRequestType.DATA_PROVIDER_HIT
      labels.provider_status_code = 200
    }
  }

  return labels
}

// Data Provider Requests Metrics
export const dataProviderMetricsLabel = (providerStatusCode?: number, method = 'get') => ({
  provider_status_code: providerStatusCode,
  method: method.toUpperCase(),
})

// Retrieve cost field from response if exists
// If not return default cost of 1
export const retrieveCost = <ProviderResponseBody>(data: ProviderResponseBody): number => {
  const cost = (data as Record<string, unknown>)?.['cost']
  if (typeof cost === 'number' || typeof cost === 'string') {
    return Number(cost)
  } else {
    return 1
  }
}

export const metrics = new Metrics(() => ({
  httpRequestsTotal: new client.Counter({
    name: 'http_requests_total',
    help: 'The number of http requests this external adapter has serviced for its entire uptime',
    labelNames: httpRequestsTotalLabels,
  }),
  httpRequestDurationSeconds: new client.Histogram({
    name: 'http_request_duration_seconds',
    help: 'A histogram bucket of the distribution of http request durations',
    buckets: requestDurationBuckets,
  }),
  dataProviderRequests: new client.Counter({
    name: 'data_provider_requests',
    help: 'The number of http requests that are made to a data provider',
    labelNames: ['method', 'provider_status_code'] as const,
  }),
  dataProviderRequestDurationSeconds: new client.Histogram({
    name: 'data_provider_request_duration_seconds',
    help: 'A histogram bucket of the distribution of data provider request durations',
    buckets: requestDurationBuckets,
  }),
  requesterQueueSize: new client.Gauge({
    name: 'requester_queue_size',
    help: 'The number of provider http requests currently queued to be executed',
  }),
  requesterQueueOverflow: new client.Counter({
    name: 'requester_queue_overflow',
    help: 'Total times the requester queue replaced the oldest item to avoid an overflow',
  }),
  bgExecuteSubscriptionSetCount: new client.Gauge({
    name: 'bg_execute_subscription_set_count',
    help: 'The number of active subscriptions in background execute',
    labelNames: ['endpoint', 'transport_type'] as const,
  }),
  bgExecuteTotal: new client.Counter({
    name: 'bg_execute_total',
    help: 'The number of background executes performed per endpoint',
    labelNames: ['endpoint', 'transport'] as const,
  }),
  bgExecuteErrors: new client.Counter({
    name: 'bg_execute_errors',
    help: 'The number of background execute errors per endpoint x transport',
    labelNames: ['endpoint', 'transport'] as const,
  }),
  bgExecuteDurationSeconds: new client.Gauge({
    name: 'bg_execute_duration_seconds',
    help: 'A histogram bucket of the distribution of background execute durations',
    labelNames: ['endpoint', 'transport'] as const,
  }),
  cacheDataGetCount: new client.Counter({
    name: 'cache_data_get_count',
    help: 'A counter that increments every time a value is fetched from the cache',
    labelNames: cacheMetricsLabels,
  }),
  cacheDataGetValues: new client.Gauge({
    name: 'cache_data_get_values',
    help: 'A gauge keeping track of values being fetched from cache',
    labelNames: cacheMetricsLabels,
  }),
  cacheDataMaxAge: new client.Gauge({
    name: 'cache_data_max_age',
    help: 'A gauge tracking the max age of stored values in the cache',
    labelNames: cacheMetricsLabels,
  }),
  cacheDataSetCount: new client.Counter({
    name: 'cache_data_set_count',
    help: 'A counter that increments every time a value is set to the cache',
    labelNames: [...cacheMetricsLabels, 'status_code'],
  }),
  cacheDataStalenessSeconds: new client.Gauge({
    name: 'cache_data_staleness_seconds',
    help: 'Observes the cache staleness of the data returned (i.e., time since the data was written to the cache)',
    labelNames: cacheMetricsLabels,
  }),
  totalDataStalenessSeconds: new client.Gauge({
    name: 'total_data_staleness_seconds',
    help: 'Observes the total staleness of the data returned (i.e., time since the provider indicated the data was sent)',
    labelNames: cacheMetricsLabels,
  }),
  providerTimeDelta: new client.Gauge({
    name: 'provider_time_delta',
    help: 'Measures the difference between the time indicated by a DP for a value vs the time it was written to cache',
    labelNames: ['feed_id'],
  }),
  redisConnectionsOpen: new client.Counter({
    name: 'redis_connections_open',
    help: 'The number of redis connections that are open',
  }),
  redisRetriesCount: new client.Counter({
    name: 'redis_retries_count',
    help: 'The number of retries that have been made to establish a redis connection',
  }),
  redisCommandsSentCount: new client.Counter({
    name: 'redis_commands_sent_count',
    help: 'The number of redis commands sent',
    labelNames: ['status', 'function_name'],
  }),
  cacheWarmerCount: new client.Gauge({
    name: 'cache_warmer_get_count',
    help: 'The number of cache warmers running',
    labelNames: ['isBatched'] as const,
  }),
  wsConnectionActive: new client.Gauge({
    name: 'ws_connection_active',
    help: 'The number of active connections',
    labelNames: ['url'] as const,
  }),
  wsConnectionErrors: new client.Counter({
    name: 'ws_connection_errors',
    help: 'The number of connection errors',
    labelNames: ['url', 'message'] as const,
  }),
  wsSubscriptionActive: new client.Gauge({
    name: 'ws_subscription_active',
    help: 'The number of currently active subscriptions',
    labelNames: ['connection_url', 'feed_id', 'subscription_key'] as const,
  }),
  wsSubscriptionTotal: new client.Counter({
    name: 'ws_subscription_total',
    help: 'The number of subscriptions opened in total',
    labelNames: ['connection_url', 'feed_id', 'subscription_key'] as const,
  }),
  wsMessageTotal: new client.Counter({
    name: 'ws_message_total',
    help: 'The number of messages sent in total',
    labelNames: ['feed_id', 'subscription_key', 'direction'] as const,
  }),
  transportPollingFailureCount: new client.Counter({
    name: 'transport_polling_failure_count',
    help: 'The number of times the polling mechanism ran out of attempts and failed to return a response',
    labelNames: ['endpoint'] as const,
  }),
  transportPollingDurationSeconds: new client.Gauge({
    name: 'transport_polling_duration_seconds',
    help: 'A histogram bucket of the distribution of transport polling idle time durations',
    labelNames: ['endpoint', 'succeeded'] as const,
  }),
  rateLimitCreditsSpentTotal: new client.Counter({
    name: 'rate_limit_credits_spent_total',
    help: 'The number of data provider credits the adapter is consuming',
    labelNames: ['participant_id', 'feed_id'] as const,
  }),
}))
